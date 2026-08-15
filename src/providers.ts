import { z } from 'zod'

import type { ResolvedProvider } from './config.js'
import type { ModelInfo, Protocol, ProviderType } from './types.js'

import { cachedModels, freshModels, writeModels } from './cache.js'
import { resolveApiKey } from './keys.js'

interface ProviderBehavior {
  // Base URL to hand to Anthropic-protocol harnesses (e.g. Claude Code's
  // ANTHROPIC_BASE_URL). Undefined = cannot serve Anthropic natively.
  anthropicBaseURL?: (baseURL: string) => string
  codexWireApi: 'chat' | 'responses'
  listModels: (baseURL: string, apiKey?: string) => Promise<ModelInfo[]>
  // Base URL for OpenAI-protocol harnesses (chat completions / responses).
  openAIBaseURL: (baseURL: string) => string
  protocols: Protocol[]
}

const openAiModelsSchema = z.object({
  data: z.array(
    z.looseObject({
      context_length: z.number().optional(),
      id: z.string(),
    }),
  ),
})

// Vercel AI Gateway model list carries per-model pricing (input/output per
// token) that the picker shows as a cost label. OpenRouter uses prompt/completion
// instead, so this stays gateway-specific.
const gatewayModelsSchema = z.object({
  data: z.array(
    z.looseObject({
      context_window: z.number().optional(),
      id: z.string(),
      pricing: z
        .looseObject({
          input: z.union([z.string(), z.number()]).optional(),
          output: z.union([z.string(), z.number()]).optional(),
        })
        .optional(),
    }),
  ),
})

const gatewayEndpointsSchema = z.object({
  data: z.looseObject({
    endpoints: z.array(
      z.looseObject({
        pricing: z
          .looseObject({
            completion: z.union([z.string(), z.number()]).optional(),
            prompt: z.union([z.string(), z.number()]).optional(),
          })
          .optional(),
        provider_name: z.string(),
        status: z.number().optional(),
        throughput_last_1h: z
          .looseObject({
            p50: z.number().optional(),
          })
          .nullable()
          .optional(),
      }),
    ),
  }),
})

const ollamaTagsSchema = z.object({
  models: z.array(
    z.looseObject({
      details: z
        .looseObject({ parameter_size: z.string().optional() })
        .optional(),
      name: z.string(),
    }),
  ),
})

const FETCH_TIMEOUT_MS = 4000

// Carries the HTTP status so callers can branch on it (404 = unknown model,
// 401/403 = bad key) without parsing the message back apart.
export class HttpError extends Error {
  public readonly status: number

  constructor(status: number, url: string) {
    super(`HTTP ${String(status)} from ${url}`)
    this.status = status
  }
}

// Shared with pricing.ts — same timeout, auth header, and /v1 handling.
export async function fetchJson(url: string, apiKey?: string) {
  const headers: Record<string, string> = {}
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new HttpError(res.status, url)
  const body: unknown = await res.json()
  return body
}

export function withV1(url: string) {
  const base = stripTrailingSlash(url)
  return base.endsWith('/v1') ? base : `${base}/v1`
}

async function listOllamaModels(baseURL: string) {
  const body = await fetchJson(`${stripTrailingSlash(baseURL)}/api/tags`)
  return ollamaTagsSchema
    .parse(body)
    .models.map((m) => ({
      hint: m.details?.parameter_size
        ? `${m.details.parameter_size} · local`
        : 'local',
      id: m.name,
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

async function listOpenAiModels(baseURL: string, apiKey?: string) {
  const body = await fetchJson(`${withV1(baseURL)}/models`, apiKey)
  return openAiModelsSchema
    .parse(body)
    .data.map((m) => ({
      hint:
        m.context_length == null
          ? undefined
          : `${String(Math.round(m.context_length / 1024))}k ctx`,
      id: m.id,
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

// Vercel AI Gateway model list: cost comes straight from /v1/models pricing so
// the picker opens instantly. Per-model throughput lives in a separate
// /v1/models/{model}/endpoints call, which the picker fetches lazily (only for
// the models a user actually looks at) rather than for the whole list.
async function listGatewayModels(baseURL: string, apiKey?: string) {
  const body = await fetchJson(`${withV1(baseURL)}/models`, apiKey)
  return gatewayModelsSchema
    .parse(body)
    .data.map((m) => {
      const input = perTokenToPerMillion(m.pricing?.input)
      const output = perTokenToPerMillion(m.pricing?.output)
      return {
        costLabel:
          input != null && output != null
            ? `${formatUsd(input)}/${formatUsd(output)}`
            : undefined,
        hint:
          m.context_window == null
            ? undefined
            : `${String(Math.round(m.context_window / 1024))}k ctx`,
        id: m.id,
      }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
}

// Fetch one model's p50 throughput (tokens/sec) from its /endpoints response.
// Returns undefined when no active endpoint publishes a p50, or when the model
// id 404s — Vercel 404s `/models/{id}/endpoints` for ids it no longer lists
// (e.g. from a stale model cache). Other failures propagate so callers can
// retry them later (a transient failure must not be treated as "no throughput"
// forever).
export async function fetchGatewayModelThroughput(
  provider: ResolvedProvider,
  modelId: string,
  apiKey?: string,
) {
  const modelPath = modelId.split('/').map(encodeURIComponent).join('/')
  let body: unknown
  try {
    body = await fetchJson(
      `${withV1(provider.baseURL)}/models/${modelPath}/endpoints`,
      apiKey,
    )
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return undefined
    throw error
  }
  const p50 = gatewayEndpointsSchema
    .parse(body)
    .data.endpoints.filter((e) => e.status === undefined || e.status === 0)
    .map((e) => e.throughput_last_1h?.p50)
    .find((value) => value != null)
  return p50 == null ? undefined : `${Math.round(p50)} tps`
}

function stripTrailingSlash(url: string) {
  return url.replace(/\/+$/, '')
}

function withoutV1(url: string) {
  return stripTrailingSlash(url).replace(/\/v1$/, '')
}

const BEHAVIORS: Record<ProviderType, ProviderBehavior> = {
  'ollama': {
    anthropicBaseURL: stripTrailingSlash,
    codexWireApi: 'responses',
    listModels: async (baseURL) => listOllamaModels(baseURL),
    openAIBaseURL: withV1,
    protocols: ['anthropic', 'openai-chat', 'openai-responses'],
  },
  'openai-chat': {
    codexWireApi: 'chat',
    listModels: listOpenAiModels,
    openAIBaseURL: withV1,
    protocols: ['openai-chat'],
  },
  'vercel-gateway': {
    anthropicBaseURL: withoutV1,
    codexWireApi: 'responses',
    listModels: listGatewayModels,
    openAIBaseURL: withV1,
    protocols: ['anthropic', 'openai-chat', 'openai-responses'],
  },
}

// A harness can use a provider when their protocol sets intersect — e.g.
// Codex speaks responses OR chat, so an openai-chat provider is fine for it.
export function anthropicBaseURLFor(provider: ResolvedProvider) {
  return BEHAVIORS[provider.type].anthropicBaseURL?.(provider.baseURL)
}

export function canServeAny(type: ProviderType, protocols: Protocol[]) {
  return protocols.some((p) => BEHAVIORS[type].protocols.includes(p))
}

// env (explicit shell/1Password/dotenvx) → macOS Keychain → 0600 secrets file.
// A missing key is a normal unconfigured state, not a failure — the `keyless`
// flag lets callers pick a milder severity for it.
export async function checkProvider(provider: ResolvedProvider) {
  const key = provider.envKey ? await resolveKey(provider) : undefined
  if (provider.envKey && key?.source === 'none') {
    return {
      detail: `${provider.envKey} not set — run \`eh provider key ${provider.name}\``,
      keyless: true,
      ok: false,
    }
  }
  try {
    const models = await listModels(provider)
    const suffix = key ? ` · key from ${key.source}` : ''
    return { detail: `${String(models.length)} models${suffix}`, ok: true }
  } catch (error) {
    return {
      detail: error instanceof Error ? error.message : 'unreachable',
      ok: false,
    }
  }
}

export function codexWireApiFor(provider: ResolvedProvider) {
  return BEHAVIORS[provider.type].codexWireApi
}

export async function listModels(provider: ResolvedProvider) {
  const key = provider.envKey ? await resolveKey(provider) : undefined
  const apiKey = key && key.source !== 'none' ? key.value : undefined
  return BEHAVIORS[provider.type].listModels(provider.baseURL, apiKey)
}

// Provider slugs are model-specific, so resolve them from the model endpoint
// when the Gateway picker opens instead of treating the global provider list as
// proof that a provider can serve this model. Each entry carries the facts the
// picker shows next to the slug (cost in/out per 1M, p50 throughput) — the
// picker formats them; this module only parses.
export interface GatewayProviderInfo {
  costInputPerMillion: number | undefined
  costOutputPerMillion: number | undefined
  name: string
  throughputTokensPerSec: number | undefined
}

export async function listGatewayProviders(
  provider: ResolvedProvider,
  modelId: string,
): Promise<GatewayProviderInfo[]> {
  if (provider.type !== 'vercel-gateway') {
    throw new Error(`provider "${provider.name}" is not Vercel AI Gateway`)
  }
  const key = provider.envKey ? await resolveKey(provider) : undefined
  const apiKey = key && key.source !== 'none' ? key.value : undefined
  const modelPath = modelId.split('/').map(encodeURIComponent).join('/')
  const body = await fetchJson(
    `${withV1(provider.baseURL)}/models/${modelPath}/endpoints`,
    apiKey,
  )
  const endpoints = gatewayEndpointsSchema
    .parse(body)
    .data.endpoints.filter(
      (endpoint) => endpoint.status === undefined || endpoint.status === 0,
    )
  const seen = new Set<string>()
  const providers: GatewayProviderInfo[] = []
  for (const endpoint of endpoints) {
    if (seen.has(endpoint.provider_name)) continue
    seen.add(endpoint.provider_name)
    providers.push({
      costInputPerMillion: perTokenToPerMillion(endpoint.pricing?.prompt),
      costOutputPerMillion: perTokenToPerMillion(endpoint.pricing?.completion),
      name: endpoint.provider_name,
      throughputTokensPerSec: endpoint.throughput_last_1h?.p50,
    })
  }
  return providers.sort((a, b) => a.name.localeCompare(b.name))
}

// Provider APIs publish USD per token as a string or number. Reject negatives
// and non-numeric values. Mirrors pricing.ts's parser (kept local to avoid a
// providers → pricing import cycle).
function perTokenToPerMillion(raw: number | string | undefined) {
  if (raw == null || raw === '') return undefined
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n) || n < 0) return undefined
  return n * 1_000_000
}

// Compact $ for the model picker cost label. Mirrors pricing.ts's formatUsd
// (kept local to avoid a providers → pricing import cycle).
function formatUsd(amount: number) {
  if (amount === 0) return '$0'
  if (amount >= 100) return `$${amount.toFixed(0)}`
  if (amount >= 1) return `$${trimZeros(amount.toFixed(2))}`
  if (amount >= 0.01) return `$${trimZeros(amount.toFixed(3))}`
  return `$${amount.toPrecision(2)}`
}

function trimZeros(s: string) {
  return s.replace(/\.?0+$/, '')
}

// The one copy of the cache flow: fresh cache → live fetch (write-through) →
// stale cache fallback (DESIGN.md "cached 5 min, stale fallback"). The model
// picker wraps this with a spinner (src/ui/prompts.ts).
export async function listModelsCached(provider: ResolvedProvider) {
  const fresh = freshModels(provider.name)
  if (fresh) return fresh
  try {
    const models = await listModels(provider)
    writeModels(provider.name, models)
    return models
  } catch (error) {
    const stale = cachedModels(provider.name)
    if (stale) return stale
    throw error
  }
}

export function openAIBaseURLFor(provider: ResolvedProvider) {
  return BEHAVIORS[provider.type].openAIBaseURL(provider.baseURL)
}

export async function resolveKey(provider: ResolvedProvider) {
  return resolveApiKey(provider.envKey, provider.name)
}
