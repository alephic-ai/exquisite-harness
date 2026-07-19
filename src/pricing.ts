import { z } from 'zod'

import type { ResolvedProvider } from './config.js'

import { resolveApiKey } from './keys.js'

// USD per 1M tokens. Optional cache rates when the provider publishes them.
export interface ModelRates {
  cacheReadPerMillion?: number
  cacheWritePerMillion?: number
  inputPerMillion: number
  outputPerMillion: number
}

// List-time model facts for the statusline (rates + real context window size).
export interface ModelMeta {
  contextWindow: number | undefined
  rates: ModelRates | undefined
}

const FETCH_TIMEOUT_MS = 4000

// Providers disagree on string vs number and camelCase vs snake_case.
const priceField = z.union([z.string(), z.number()]).optional()

// One schema for both providers: field names differ (gateway: input/output/
// context_window, OpenRouter: prompt/completion/context_length) but never
// collide, so the fetcher just prefers the canonical name and falls back.
const modelsSchema = z.object({
  data: z.array(
    z.looseObject({
      context_length: z.number().optional(),
      context_window: z.number().optional(),
      id: z.string(),
      pricing: z
        .looseObject({
          cacheCreationInputTokens: priceField,
          cachedInputTokens: priceField,
          completion: priceField,
          input: priceField,
          input_cache_read: priceField,
          input_cache_write: priceField,
          output: priceField,
          prompt: priceField,
        })
        .optional(),
    }),
  ),
})

// One models-list fetch: list rates + context window for the chosen model.
export async function fetchModelMeta(
  provider: ResolvedProvider,
  modelId: string,
): Promise<ModelMeta> {
  if (provider.type === 'ollama') {
    return {
      contextWindow: undefined,
      rates: { inputPerMillion: 0, outputPerMillion: 0 },
    }
  }
  const key = provider.envKey
    ? await resolveApiKey(provider.envKey, provider.name)
    : undefined
  const apiKey = key && key.source !== 'none' ? key.value : undefined
  try {
    return await fetchProviderMeta(provider.baseURL, modelId, apiKey)
  } catch {
    return { contextWindow: undefined, rates: undefined }
  }
}

export function formatRatesPerMillion(rates: ModelRates | undefined) {
  if (!rates) return '—/—'
  if (rates.inputPerMillion === 0 && rates.outputPerMillion === 0) return 'free'
  return `${formatUsd(rates.inputPerMillion)}/${formatUsd(rates.outputPerMillion)}`
}

// Compact $ for the bar: $1.5, $0.15, $12 — drop trailing zeros past 2 decimals
// when the value is whole-ish, keep more for sub-cent rates.
export function formatUsd(amount: number) {
  if (amount === 0) return '$0'
  if (amount >= 100) return `$${amount.toFixed(0)}`
  if (amount >= 1) return `$${trimZeros(amount.toFixed(2))}`
  if (amount >= 0.01) return `$${trimZeros(amount.toFixed(3))}`
  return `$${amount.toPrecision(2)}`
}

export function sessionCostUsd(
  rates: ModelRates | undefined,
  usage: {
    cacheRead: number
    cacheWrite: number
    input: number
    output: number
  },
) {
  if (!rates) return undefined
  if (rates.inputPerMillion === 0 && rates.outputPerMillion === 0) return '$0'
  const cacheReadRate = rates.cacheReadPerMillion ?? rates.inputPerMillion * 0.1
  // Prefer published cache-write rate; fall back to input when absent.
  const cacheWriteRate = rates.cacheWritePerMillion ?? rates.inputPerMillion
  const usd =
    (usage.input * rates.inputPerMillion +
      usage.output * rates.outputPerMillion +
      usage.cacheRead * cacheReadRate +
      usage.cacheWrite * cacheWriteRate) /
    1_000_000
  return formatUsdSession(usd)
}

// Context % matching Claude Code's formula (input-side only; not output):
// (input + cache_creation + cache_read) / window_size * 100
export function contextUsedPercentage(props: {
  cacheRead: number
  cacheWrite: number
  contextWindow: number | undefined
  input: number
}) {
  const size = props.contextWindow
  if (size == null || size <= 0) return undefined
  const used = props.input + props.cacheWrite + props.cacheRead
  return Math.min(100, (used / size) * 100)
}

async function fetchJson(url: string, apiKey?: string) {
  const headers: Record<string, string> = {}
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`HTTP ${String(res.status)} from ${url}`)
  return res.json()
}

async function fetchProviderMeta(
  baseURL: string,
  modelId: string,
  apiKey?: string,
): Promise<ModelMeta> {
  const body = await fetchJson(`${withV1(baseURL)}/models`, apiKey)
  const match = modelsSchema.parse(body).data.find((m) => m.id === modelId)
  if (!match) return { contextWindow: undefined, rates: undefined }
  const ctx = match.context_window ?? match.context_length
  const contextWindow = ctx != null && ctx > 0 ? ctx : undefined
  const p = match.pricing
  if (!p) return { contextWindow, rates: undefined }
  const input = perTokenToPerMillion(p.input ?? p.prompt)
  const output = perTokenToPerMillion(p.output ?? p.completion)
  // OpenRouter uses "-1" for dynamic/router pricing — treat as unknown.
  if (input == null || output == null) {
    return { contextWindow, rates: undefined }
  }
  return {
    contextWindow,
    rates: {
      cacheReadPerMillion: perTokenToPerMillion(
        p.cachedInputTokens ?? p.input_cache_read,
      ),
      cacheWritePerMillion: perTokenToPerMillion(
        p.cacheCreationInputTokens ?? p.input_cache_write,
      ),
      inputPerMillion: input,
      outputPerMillion: output,
    },
  }
}

function formatUsdSession(amount: number) {
  if (amount === 0) return '$0'
  if (amount < 0.01) return `$${amount.toFixed(4)}`
  return `$${amount.toFixed(2)}`
}

// Provider APIs publish USD per token as string or number. Reject negatives
// (OpenRouter dynamic "-1") and non-numeric values.
function perTokenToPerMillion(raw: number | string | undefined) {
  if (raw == null || raw === '') return undefined
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n) || n < 0) return undefined
  return n * 1_000_000
}

function stripTrailingSlash(url: string) {
  return url.replace(/\/+$/, '')
}

function trimZeros(s: string) {
  return s.replace(/\.?0+$/, '')
}

function withV1(url: string) {
  const base = stripTrailingSlash(url)
  return base.endsWith('/v1') ? base : `${base}/v1`
}

// Used by statusline to rebuild rates from env without re-fetching.
export function contextWindowFromEnv(
  env: Record<string, string | undefined> = process.env,
) {
  const raw = env.EH_CONTEXT_WINDOW
  if (raw == null || raw === '') return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return n
}

export function ratesFromEnv(
  env: Record<string, string | undefined> = process.env,
) {
  const input = env.EH_PRICE_IN
  const output = env.EH_PRICE_OUT
  if (input == null || output == null || input === '' || output === '') {
    return undefined
  }
  const inputPerMillion = Number(input)
  const outputPerMillion = Number(output)
  if (!Number.isFinite(inputPerMillion) || !Number.isFinite(outputPerMillion)) {
    return undefined
  }
  const cacheReadPerMillion = optionalEnvRate(env.EH_PRICE_CACHE_READ)
  const cacheWritePerMillion = optionalEnvRate(env.EH_PRICE_CACHE_WRITE)
  return {
    cacheReadPerMillion,
    cacheWritePerMillion,
    inputPerMillion,
    outputPerMillion,
  } satisfies ModelRates
}

function optionalEnvRate(raw: string | undefined) {
  if (raw == null || raw === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}
