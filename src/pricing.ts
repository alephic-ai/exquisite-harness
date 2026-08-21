import { z } from 'zod'

import type { ResolvedProvider } from './config.js'

import { resolveApiKey } from './keys.js'
import { fetchJson, gatewaySlugMatches, withV1 } from './providers.js'

// USD per 1M tokens. Optional cache rates when the provider publishes them.
export interface ModelRates {
  cacheReadPerMillion?: number
  cacheWritePerMillion?: number
  inputPerMillion: number
  outputPerMillion: number
}

// List-time model facts used by harness launch metadata.
export interface ModelMeta {
  contextWindow: number | undefined
  rateLabel: string | undefined
  rates: ModelRates | undefined
}

// How a headless run's cost was derived: from gateway rates, free (a zero-rate
// provider), or unavailable when no rates could be resolved.
export type HeadlessCostSource = 'free' | 'gateway-rates' | 'unavailable'

// eh's own normalized token counts for a run, summed across harness events.
export interface NormalizedUsage {
  cacheRead: number
  cacheWrite: number
  input: number
  output: number
}

// The rate source resolved for a headless run. `endpoint` carries the raw
// per-endpoint pricing (tier selection is usage-dependent, so it's deferred to
// cost time); `rates` is the model-aggregate fallback when no pin is given.
export type HeadlessRateCard =
  | { kind: 'endpoint'; pricing: EndpointPricing }
  | { kind: 'free' }
  | { kind: 'rates'; rates: ModelRates }
  | { kind: 'unavailable' }

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

// Per-endpoint pricing. Cache fields are declared so headless cost computation
// can read them; the gateway publishes them under either naming.
const gatewayEndpointPricingSchema = z.looseObject({
  cacheCreationInputTokens: priceField,
  cachedInputTokens: priceField,
  completion: priceField,
  completion_tiers: z.array(priceTierSchema).optional(),
  input_cache_read: priceField,
  input_cache_write: priceField,
  prompt: priceField,
  prompt_tiers: z.array(priceTierSchema).optional(),
})

export type EndpointPricing = z.infer<typeof gatewayEndpointPricingSchema>

const gatewayEndpointsSchema = z.object({
  data: z.looseObject({
    endpoints: z.array(
      z.looseObject({
        pricing: gatewayEndpointPricingSchema,
        provider_name: z.string(),
        status: z.number().optional(),
        tag: z.string().optional(),
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
    if (provider.type === 'openrouter') {
      return await fetchOpenRouterMeta({
        apiKey,
        baseURL: provider.baseURL,
        gatewayProvider,
        modelId,
      })
    }
    return await fetchOpenRouterListMeta(provider.baseURL, modelId, apiKey)
  } catch {
    return {
      contextWindow: undefined,
      rateLabel: undefined,
      rates: undefined,
    }
  }
}

// Resolve the rate source for a headless run. A `--gateway-provider` pin gets
// per-endpoint pricing (AC-1); otherwise fall back to the model-aggregate rates.
// Never throws — any failure resolves to `unavailable` so no cost is fabricated.
export async function fetchHeadlessRateCard(props: {
  gatewayProvider?: string
  modelId: string
  provider: ResolvedProvider
}): Promise<HeadlessRateCard> {
  const { gatewayProvider, modelId, provider } = props
  if (provider.type === 'ollama') return { kind: 'free' }
  try {
    if (
      gatewayProvider != null &&
      (provider.type === 'vercel-gateway' || provider.type === 'openrouter')
    ) {
      const key = provider.envKey
        ? await resolveApiKey(provider.envKey, provider.name)
        : undefined
      const apiKey = key && key.source !== 'none' ? key.value : undefined
      const pricing = await fetchEndpointPricing({
        apiKey,
        baseURL: provider.baseURL,
        gatewayProvider,
        modelId,
      })
      if (pricing) return { kind: 'endpoint', pricing }
      // A pin that fails to resolve must not fall back to the model-aggregate
      // rates: that would bill the wrong provider's cost as authoritative
      // `gateway-rates`. Report unavailable instead.
      return { kind: 'unavailable' }
    }
    const meta = await fetchModelMeta({ gatewayProvider, modelId, provider })
    if (!meta.rates) return { kind: 'unavailable' }
    if (ratesAreFree(meta.rates)) return { kind: 'free' }
    return { kind: 'rates', rates: meta.rates }
  } catch {
    return { kind: 'unavailable' }
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

// The pricing of the first active endpoint matching the pin. Mirrors the fetch +
// filter of `fetchGatewayRateLabel`, but returns usable rates, not a label.
// Returns undefined on any failure so the caller can fall back to model rates.
async function fetchEndpointPricing(props: {
  apiKey: string | undefined
  baseURL: string
  gatewayProvider: string
  modelId: string
}): Promise<EndpointPricing | undefined> {
  try {
    const modelPath = props.modelId.split('/').map(encodeURIComponent).join('/')
    const body = await fetchJson(
      `${withV1(props.baseURL)}/models/${modelPath}/endpoints`,
      props.apiKey,
    )
    const match = gatewayEndpointsSchema
      .parse(body)
      .data.endpoints.find(
        (endpoint) =>
          (endpoint.status == null || endpoint.status === 0) &&
          gatewaySlugMatches(
            endpoint.tag ?? endpoint.provider_name,
            props.gatewayProvider,
          ),
      )
    return match?.pricing
  } catch {
    return undefined
  }
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

// Cost of eh's own normalized usage against a resolved rate card. Returns the
// cost source so unavailable rates are reported, never fabricated as $0.
export function headlessCost(
  card: HeadlessRateCard,
  usage: NormalizedUsage,
): { costSource: HeadlessCostSource; costUsd: number | undefined } {
  if (card.kind === 'free') return { costSource: 'free', costUsd: 0 }
  if (card.kind === 'unavailable') {
    return { costSource: 'unavailable', costUsd: undefined }
  }
  const rates =
    card.kind === 'endpoint' ? endpointRates(card.pricing, usage) : card.rates
  if (!rates) return { costSource: 'unavailable', costUsd: undefined }
  if (ratesAreFree(rates)) return { costSource: 'free', costUsd: 0 }
  return { costSource: 'gateway-rates', costUsd: gatewayCostUsd(rates, usage) }
}

// Numeric cost from per-million rates. Unlike sessionCostUsd this never returns
// undefined for missing cache rates: AC-4 bills cache reads/writes at the
// regular input rate when the endpoint publishes no cache rate — a provider that
// gives no cache discount charges cache tokens as ordinary input, so input-rate
// is the non-fabricating default (zero would understate the bill).
export function gatewayCostUsd(rates: ModelRates, usage: NormalizedUsage) {
  const cacheReadRate = rates.cacheReadPerMillion ?? rates.inputPerMillion
  const cacheWriteRate = rates.cacheWritePerMillion ?? rates.inputPerMillion
  return (
    (usage.input * rates.inputPerMillion +
      usage.output * rates.outputPerMillion +
      usage.cacheRead * cacheReadRate +
      usage.cacheWrite * cacheWriteRate) /
    1_000_000
  )
}

// Convert per-endpoint pricing to per-million rates for the given usage. Tiers
// are treated as context brackets: the bucket is charged at the matched tier's
// rate. Returns undefined when neither a base rate nor a tier resolves.
export function endpointRates(
  pricing: EndpointPricing,
  usage: NormalizedUsage,
): ModelRates | undefined {
  // The prompt tier is a context bracket: it keys on the full context, cache
  // tokens included, matching `contextUsedPercentage`'s context definition.
  const inputPerMillion = tierRate(
    pricing.prompt,
    pricing.prompt_tiers,
    usage.input + usage.cacheRead + usage.cacheWrite,
  )
  const outputPerMillion = tierRate(
    pricing.completion,
    pricing.completion_tiers,
    usage.output,
  )
  if (inputPerMillion == null || outputPerMillion == null) return undefined
  return {
    cacheReadPerMillion: perTokenToPerMillion(
      pricing.cachedInputTokens ?? pricing.input_cache_read,
    ),
    cacheWritePerMillion: perTokenToPerMillion(
      pricing.cacheCreationInputTokens ?? pricing.input_cache_write,
    ),
    inputPerMillion,
    outputPerMillion,
  }
}

// Pick the tier bracket containing `count` and return its per-million rate;
// fall back to the base rate, then the first tier.
function tierRate(
  base: number | string | undefined,
  tiers: undefined | z.infer<typeof priceTierSchema>[],
  count: number,
) {
  const match = tiers?.find(
    (tier) =>
      count >= (tier.min ?? 0) && (tier.max == null || count <= tier.max),
  )
  if (match) return perTokenToPerMillion(match.cost)
  const fromBase = perTokenToPerMillion(base)
  if (fromBase != null) return fromBase
  return perTokenToPerMillion(tiers?.[0]?.cost)
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
          gatewaySlugMatches(
            endpoint.tag ?? endpoint.provider_name,
            props.gatewayProvider,
          )),
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

async function fetchOpenRouterListMeta(
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

async function fetchOpenRouterMeta(props: {
  apiKey: string | undefined
  baseURL: string
  gatewayProvider: string | undefined
  modelId: string
}): Promise<ModelMeta> {
  const listed = await fetchOpenRouterListMeta(
    props.baseURL,
    props.modelId,
    props.apiKey,
  )
  const rateLabel = await fetchGatewayRateLabel(props)
    .then((label) => label ?? listed.rateLabel ?? 'varies')
    .catch(() => listed.rateLabel ?? 'varies')
  return { ...listed, rateLabel }
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
