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

// Shared with pricing.ts — same timeout, auth header, and /v1 handling.
export async function fetchJson(url: string, apiKey?: string) {
  const headers: Record<string, string> = {}
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`HTTP ${String(res.status)} from ${url}`)
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
    listModels: listOpenAiModels,
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
