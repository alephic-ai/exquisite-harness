import { z } from 'zod'

import type { ResolvedProvider } from './config.js'

import { resolveApiKey } from './keys.js'
import { fetchJson, withV1 } from './providers.js'

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
  rateLabel: string | undefined
  rates: ModelRates | undefined
}

// Providers disagree on string vs number and camelCase vs snake_case.
const priceField = z.union([z.string(), z.number()]).optional()
const priceValue = z.union([z.string(), z.number()])
const priceTierSchema = z.looseObject({
  cost: priceValue,
  max: z.number().optional(),
  min: z.number().optional(),
})

const openRouterModelsSchema = z.object({
  data: z.array(
    z.looseObject({
      context_length: z.number().optional(),
      id: z.string(),
      pricing: z
        .looseObject({
          completion: priceField,
          input_cache_read: priceField,
          input_cache_write: priceField,
          prompt: priceField,
        })
        .optional(),
    }),
  ),
})

const gatewayModelsSchema = z.object({
  data: z.array(
    z.looseObject({
      context_window: z.number().optional(),
      id: z.string(),
      pricing: z
        .looseObject({
          cacheCreationInputTokens: priceField,
          cachedInputTokens: priceField,
          input: priceField,
          input_cache_read: priceField,
          input_cache_write: priceField,
          output: priceField,
        })
        .optional(),
    }),
  ),
})

const gatewayEndpointsSchema = z.object({
  data: z.looseObject({
    endpoints: z.array(
      z.looseObject({
        pricing: z.looseObject({
          completion: priceField,
          completion_tiers: z.array(priceTierSchema).optional(),
          prompt: priceField,
          prompt_tiers: z.array(priceTierSchema).optional(),
        }),
        provider_name: z.string(),
        status: z.number().optional(),
      }),
    ),
  }),
})

// Fetch the model facts and, for a routing gateway, active endpoint rates.
export async function fetchModelMeta(props: {
  gatewayProvider?: string
  modelId: string
  provider: ResolvedProvider
}): Promise<ModelMeta> {
  const { gatewayProvider, modelId, provider } = props
  if (provider.type === 'ollama') {
    return {
      contextWindow: undefined,
      rateLabel: 'free',
      rates: { inputPerMillion: 0, outputPerMillion: 0 },
    }
  }
  const key = provider.envKey
    ? await resolveApiKey(provider.envKey, provider.name)
    : undefined
  const apiKey = key && key.source !== 'none' ? key.value : undefined
  try {
    if (provider.type === 'vercel-gateway') {
      return await fetchGatewayMeta({
        apiKey,
        baseURL: provider.baseURL,
        gatewayProvider,
        modelId,
      })
    }
    return await fetchOpenRouterMeta(provider.baseURL, modelId, apiKey)
  } catch {
    return {
      contextWindow: undefined,
      rateLabel: undefined,
      rates: undefined,
    }
  }
}

export function formatExactSessionCostUsd(amount: string) {
  return `$${amount}`
}

export function formatRatesPerMillion(rates: ModelRates | undefined) {
  if (!rates) return '—/—'
  if (rates.inputPerMillion === 0 && rates.outputPerMillion === 0) return 'free'
  return `${formatUsd(rates.inputPerMillion)}/${formatUsd(rates.outputPerMillion)}`
}

export function formatSessionCostUsd(amount: number) {
  if (amount === 0) return '$0'
  if (amount < 0.01) return `$${amount.toFixed(4)}`
  return `$${amount.toFixed(2)}`
}

export function formatStatuslineCost(props: {
  capturedCost: undefined | { exact: boolean; total: string }
  captureExpected: boolean
  estimatedCost: string | undefined
  rates: ModelRates | undefined
}) {
  if (props.capturedCost != null) {
    const formatted = formatExactSessionCostUsd(props.capturedCost.total)
    return props.capturedCost.exact ? formatted : `~${formatted}`
  }
  if (props.captureExpected || props.estimatedCost == null) return '—'
  if (ratesAreFree(props.rates)) return props.estimatedCost
  return `~${props.estimatedCost}`
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
  if (usage.cacheRead > 0 && rates.cacheReadPerMillion == null) return undefined
  if (usage.cacheWrite > 0 && rates.cacheWritePerMillion == null) {
    return undefined
  }
  const cacheReadRate = rates.cacheReadPerMillion ?? 0
  const cacheWriteRate = rates.cacheWritePerMillion ?? 0
  const usd =
    (usage.input * rates.inputPerMillion +
      usage.output * rates.outputPerMillion +
      usage.cacheRead * cacheReadRate +
      usage.cacheWrite * cacheWriteRate) /
    1_000_000
  return formatSessionCostUsd(usd)
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

async function fetchGatewayMeta(props: {
  apiKey: string | undefined
  baseURL: string
  gatewayProvider: string | undefined
  modelId: string
}): Promise<ModelMeta> {
  const body = await fetchJson(`${withV1(props.baseURL)}/models`, props.apiKey)
  const match = gatewayModelsSchema
    .parse(body)
    .data.find((m) => m.id === props.modelId)
  if (!match) {
    return {
      contextWindow: undefined,
      rateLabel: undefined,
      rates: undefined,
    }
  }
  const contextWindow =
    typeof match.context_window === 'number' && match.context_window > 0
      ? match.context_window
      : undefined
  const rateLabel = await fetchGatewayRateLabel(props)
    .then((label) => label ?? 'varies')
    .catch(() => 'varies')
  if (!match.pricing) return { contextWindow, rateLabel, rates: undefined }
  const input = perTokenToPerMillion(match.pricing.input)
  const output = perTokenToPerMillion(match.pricing.output)
  if (input == null || output == null) {
    return { contextWindow, rateLabel, rates: undefined }
  }
  const cacheRead = perTokenToPerMillion(
    match.pricing.cachedInputTokens ?? match.pricing.input_cache_read,
  )
  const cacheWrite = perTokenToPerMillion(
    match.pricing.cacheCreationInputTokens ?? match.pricing.input_cache_write,
  )
  return {
    contextWindow,
    rateLabel,
    rates: {
      cacheReadPerMillion: cacheRead,
      cacheWritePerMillion: cacheWrite,
      inputPerMillion: input,
      outputPerMillion: output,
    },
  }
}

async function fetchGatewayRateLabel(props: {
  apiKey: string | undefined
  baseURL: string
  gatewayProvider: string | undefined
  modelId: string
}) {
  const modelPath = props.modelId.split('/').map(encodeURIComponent).join('/')
  const body = await fetchJson(
    `${withV1(props.baseURL)}/models/${modelPath}/endpoints`,
    props.apiKey,
  )
  const endpoints = gatewayEndpointsSchema
    .parse(body)
    .data.endpoints.filter(
      (endpoint) =>
        (endpoint.status == null || endpoint.status === 0) &&
        (props.gatewayProvider == null ||
          endpoint.provider_name === props.gatewayProvider),
    )
  if (endpoints.length === 0) return undefined

  const inputRates: number[] = []
  const outputRates: number[] = []
  for (const endpoint of endpoints) {
    const inputs = priceValues(
      endpoint.pricing.prompt,
      endpoint.pricing.prompt_tiers,
    )
    const outputs = priceValues(
      endpoint.pricing.completion,
      endpoint.pricing.completion_tiers,
    )
    if (!inputs || !outputs) return undefined
    inputRates.push(...inputs)
    outputRates.push(...outputs)
  }
  return `${formatRateRange(inputRates)}/${formatRateRange(outputRates)}`
}

async function fetchOpenRouterMeta(
  baseURL: string,
  modelId: string,
  apiKey?: string,
): Promise<ModelMeta> {
  const body = await fetchJson(`${withV1(baseURL)}/models`, apiKey)
  const match = openRouterModelsSchema
    .parse(body)
    .data.find((m) => m.id === modelId)
  if (!match) {
    return {
      contextWindow: undefined,
      rateLabel: undefined,
      rates: undefined,
    }
  }
  const contextWindow =
    typeof match.context_length === 'number' && match.context_length > 0
      ? match.context_length
      : undefined
  if (!match.pricing) {
    return { contextWindow, rateLabel: undefined, rates: undefined }
  }
  const input = perTokenToPerMillion(match.pricing.prompt)
  const output = perTokenToPerMillion(match.pricing.completion)
  // OpenRouter uses "-1" for dynamic/router pricing — treat as unknown.
  if (input == null || output == null) {
    return { contextWindow, rateLabel: undefined, rates: undefined }
  }
  const cacheRead = perTokenToPerMillion(match.pricing.input_cache_read)
  const cacheWrite = perTokenToPerMillion(match.pricing.input_cache_write)
  const rates = {
    cacheReadPerMillion: cacheRead,
    cacheWritePerMillion: cacheWrite,
    inputPerMillion: input,
    outputPerMillion: output,
  }
  return {
    contextWindow,
    rateLabel: formatRatesPerMillion(rates),
    rates,
  }
}

function formatRateRange(values: number[]) {
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (min === max) return formatUsd(min)
  return `${formatUsd(min)}–${formatUsd(max).slice(1)}`
}

function priceValues(
  base: number | string | undefined,
  tiers: undefined | z.infer<typeof priceTierSchema>[],
) {
  const prices: number[] = []
  for (const raw of [base, ...(tiers ?? []).map((tier) => tier.cost)]) {
    const price = perTokenToPerMillion(raw)
    if (price == null) return undefined
    prices.push(price)
  }
  return prices
}

function ratesAreFree(rates: ModelRates | undefined) {
  return (
    rates?.inputPerMillion === 0 &&
    rates.outputPerMillion === 0 &&
    (rates.cacheReadPerMillion ?? 0) === 0 &&
    (rates.cacheWritePerMillion ?? 0) === 0
  )
}

// Provider APIs publish USD per token as string or number. Reject negatives
// (OpenRouter dynamic "-1") and non-numeric values.
function perTokenToPerMillion(raw: number | string | undefined) {
  if (raw == null || raw === '') return undefined
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n) || n < 0) return undefined
  return n * 1_000_000
}

function trimZeros(s: string) {
  return s.replace(/\.?0+$/, '')
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
