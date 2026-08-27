import { autocomplete, confirm, isCancel, password, text } from '@clack/prompts'
import { ZodError } from 'zod'

import type { ResolvedProvider, ResolvedSearchProvider } from '../config.js'
import type { HarnessDef } from '../harnesses.js'
import type { ModelEffortLevel, ModelInfo } from '../types.js'

import { freshModels } from '../cache.js'
import {
  providerLabel,
  reservedProfileNameMessage,
  searchProviderKeyAccount,
  searchProviderLabel,
} from '../config.js'
import { HARNESSES } from '../harnesses.js'
import { resolveApiKey, storeApiKey } from '../keys.js'
import { formatUsd } from '../pricing.js'
import {
  canServeAny,
  fetchGatewayModelThroughput,
  type GatewayProviderInfo,
  HttpError,
  isRoutingProvider,
  listGatewayProviders,
  listModelsCached,
} from '../providers.js'
import { findBin } from '../which.js'
import { letterSelect } from './letter-select.js'
import { bail, keyStoredText, log, note, spinner } from './output.js'

type ProviderRowState = 'incompatible' | 'key-missing' | 'key-set' | 'no-key'

// Effort defaults to `auto` (model default); anything else is an override.
export async function pickEffort(efforts: readonly ModelEffortLevel[]) {
  if (efforts.length === 0) return 'auto' as const
  const value = await letterSelect({
    message: 'effort',
    options: (['auto', ...efforts] as const).map((level) => ({
      hint:
        level === 'auto'
          ? 'model default (recommended)'
          : level === 'none'
            ? 'disable reasoning'
            : undefined,
      // m is the only useful mnemonic free of the auto letters (a–e): h and l
      // are clack's cursor aliases, so "high"/"low" can't take theirs.
      hotkey: level === 'max' ? 'm' : undefined,
      label: level,
      value: level,
    })),
  })
  if (isCancel(value)) bail()
  return value
}

export async function pickHarness() {
  const value = await letterSelect({
    message: 'harness',
    options: Object.entries(HARNESSES).map(([name, def]) => ({
      hint: findBin(def.bin)
        ? `${def.label} · ${def.protocols.join(' or ')}`
        : 'not installed',
      label: name,
      value: name,
    })),
  })
  if (isCancel(value)) bail()
  return value
}

// Picker sort order: providers with a key set first, then no-key-needed, then
// ones missing a key, then protocol-incompatible. Array.sort is stable, so
// config order is preserved within each group.
const ROW_ORDER: Record<ProviderRowState, number> = {
  'incompatible': 3,
  'key-missing': 2,
  'key-set': 0,
  'no-key': 1,
}

export async function pickProvider(
  def: HarnessDef,
  providers: ResolvedProvider[],
) {
  for (;;) {
    // Status hints per DESIGN.md: ✓ key set / ✗ KEY not set (incompatible rows
    // get `needs router` or a harness-specific reason). Reachability probing
    // stays in doctor/providers — network checks don't belong in a picker.
    const rows = await Promise.all(
      providers.map(async (p) => {
        const label = providerLabel(p.name)
        const block = providerBlockReason(def, p)
        if (block) {
          return {
            option: { hint: block.rowHint, label, value: p.name },
            state: 'incompatible' as const,
          }
        }
        if (!p.envKey) {
          return {
            option: {
              hint: `${p.type} · ${p.baseURL} · no key needed`,
              label,
              value: p.name,
            },
            state: 'no-key' as const,
          }
        }
        const keySet = (await resolveApiKey(p.envKey, p.name)).source !== 'none'
        return {
          option: {
            hint: `${p.type} · ${p.baseURL} · ${keySet ? '✓ key set' : `✗ ${p.envKey} not set`}`,
            label: keySet ? label : `✗ ${label}`,
            value: p.name,
          },
          state: keySet ? ('key-set' as const) : ('key-missing' as const),
        }
      }),
    )
    rows.sort((a, b) => ROW_ORDER[a.state] - ROW_ORDER[b.state])
    const value = await letterSelect({
      message: 'provider',
      options: rows.map((r) => r.option),
    })
    if (isCancel(value)) bail()
    const provider = providers.find((p) => p.name === value)
    if (!provider) throw new Error(`unknown provider "${value}"`)
    const block = providerBlockReason(def, provider)
    if (block) {
      log.warn(block.warn)
      continue
    }
    if (await ensureKey(provider)) return provider
    // key entry cancelled → back to the provider list
  }
}

// Why a provider can't serve this harness: protocol-level (needs the phase-2
// router) or instance-level (HarnessDef.providerCompat — e.g. pi needs the
// provider in its catalog or models.json). Undefined = compatible.
function providerBlockReason(def: HarnessDef, provider: ResolvedProvider) {
  if (!canServeAny(provider.type, def.protocols)) {
    return {
      rowHint: `${provider.type} · needs router`,
      warn: `"${provider.name}" can't serve ${def.protocols.join(' or ')} — that needs the phase-2 router`,
    }
  }
  const compat = def.providerCompat?.(provider)
  if (compat && !compat.ok) {
    return {
      rowHint: `${provider.type} · ${compat.hint}`,
      warn: `"${provider.name}" ${compat.hint}`,
    }
  }
  return undefined
}

// Claude keeps its native server-tool path by default; configured external
// backends share model providers' inline key-status and masked key entry.
export async function pickSearchProvider(
  providers: ResolvedSearchProvider[],
  defaultProvider: string | undefined,
) {
  for (;;) {
    const rows = await Promise.all(
      providers.map(async (provider) => {
        const keyAccount = searchProviderKeyAccount(provider.name)
        const key = await resolveApiKey(provider.envKey, keyAccount)
        const keySet = key.source !== 'none'
        return {
          hint: `${provider.baseURL} · ${keySet ? '✓ key set' : `✗ ${provider.envKey} not set`}${defaultProvider === provider.name ? ' · default' : ''}`,
          label: keySet
            ? searchProviderLabel(provider.name)
            : `✗ ${searchProviderLabel(provider.name)}`,
          value: provider.name,
        }
      }),
    )
    const value = await letterSelect({
      initialValue: pickerInitialValue(providers, defaultProvider),
      message: 'web search',
      options: [
        {
          hint:
            defaultProvider === undefined || defaultProvider === 'native'
              ? 'default'
              : 'Claude Code native search',
          label: searchProviderLabel('native'),
          value: 'native',
        },
        ...rows,
      ],
    })
    if (isCancel(value)) bail()
    if (value === 'native') return value
    const provider = providers.find((candidate) => candidate.name === value)
    if (!provider) throw new Error(`unknown search provider "${value}"`)
    if (
      await ensureKey({
        ...provider,
        keyAccount: searchProviderKeyAccount(provider.name),
      })
    ) {
      return provider.name
    }
  }
}

function pickerInitialValue(
  providers: ResolvedSearchProvider[],
  defaultProvider: string | undefined,
) {
  if (
    defaultProvider &&
    providers.some((provider) => provider.name === defaultProvider)
  ) {
    return defaultProvider
  }
  return 'native'
}

// A provider with an envKey needs a key from somewhere. If none resolves
// (env → OS store → file), offer to store one right here. Returns false when
// the user bails out of the key prompt.
async function ensureKey(provider: {
  envKey?: string
  keyAccount?: string
  name: string
}) {
  if (!provider.envKey) return true
  const key = await resolveApiKey(
    provider.envKey,
    provider.keyAccount ?? provider.name,
  )
  if (key.source !== 'none') return true
  log.warn(`"${provider.name}" needs ${provider.envKey} — none found`)
  const value = await askApiKeyOptional(provider.name)
  if (!value) return false
  const where = await storeApiKey(provider.keyAccount ?? provider.name, value)
  log.success(keyStoredText(where))
  return true
}

const MANUAL = '__manual__'
const GATEWAY_AUTO = '__gateway_auto__'
const GATEWAY_ZDR = '__gateway_zdr__'

// Rows the model picker renders at once (autocomplete maxItems); the
// throughput prefetch window derives from it.
const MODEL_PICKER_ROWS = 12

// What the Gateway picker returns: a pinned provider slug, or automatic
// routing (undefined) optionally restricted to ZDR providers. Both flags
// null/undefined means plain automatic Vercel routing + fallback.
export interface GatewayRouteChoice {
  provider?: string
  zeroDataRetention?: boolean
}

interface ThroughputState {
  apiKey: string | undefined
  attemptedNoThroughput: Set<string>
  // First prefetch failure, stashed until the prompt closes — clack owns the
  // terminal while it's open, and an out-of-band log.warn garbles its frame.
  failureMessage: string | undefined
  throughputPending: Set<string>
  throughputs: Map<string, string>
}

// Masked key entry — the key never echoes and never touches argv/history.
export async function askApiKey(providerName: string) {
  const value = await password({
    message: `API key for ${providerName}`,
    validate: (v) => (v == null || v.length === 0 ? 'required' : undefined),
  })
  if (isCancel(value)) bail()
  return value
}

// Cancelable variant: returns undefined instead of exiting on Esc.
export async function askApiKeyOptional(providerName: string) {
  const value = await password({
    message: `API key for ${providerName} (esc to go back)`,
  })
  if (isCancel(value)) return undefined
  return value.length > 0 ? value : undefined
}

export async function askProfileName() {
  const value = await text({
    message: 'profile name',
    validate: (v) => {
      if (v == null || !/^[\w-]+$/.test(v)) {
        return 'letters, digits, - and _ only'
      }
      return reservedProfileNameMessage(v)
    },
  })
  if (isCancel(value)) bail()
  return value
}

export async function confirmLaunch(summary: string) {
  note(summary, 'launch plan')
  const value = await letterSelect<'back' | 'go' | 'save'>({
    message: 'launch?',
    options: [
      { label: 'go', value: 'go' },
      { hint: 'save as profile, then launch', label: 'save…', value: 'save' },
      { label: 'back', value: 'back' },
    ],
  })
  if (isCancel(value)) bail()
  return value
}

export async function confirmSearchProviderDefault(providerName: string) {
  const value = await confirm({
    message: `use ${providerName} by default for new Claude sessions?`,
  })
  return !isCancel(value) && value
}

export async function pickGatewayProvider(
  provider: ResolvedProvider,
  model: string,
): Promise<GatewayRouteChoice> {
  const s = spinner()
  s.start(`fetching providers for ${model}`)
  let providers: GatewayProviderInfo[]
  try {
    providers = await listGatewayProviders(provider, model)
    s.stop(`${String(providers.length)} providers`)
  } catch (error) {
    providers = []
    s.stop(
      error instanceof HttpError && error.status === 404
        ? `${model} not found on the gateway — automatic/manual still available`
        : 'provider fetch failed — automatic/manual still available',
    )
  }

  const product = provider.type === 'openrouter' ? 'OpenRouter' : 'AI Gateway'
  const value = await autocomplete({
    maxItems: 12,
    message: `${product} provider · ${model}`,
    options: [
      {
        hint:
          provider.type === 'openrouter'
            ? 'OpenRouter routing and fallback'
            : 'Vercel routing and fallback',
        label: 'automatic (recommended)',
        value: GATEWAY_AUTO,
      },
      {
        hint: 'route only to zero-data-retention providers',
        label: 'ZDR only',
        value: GATEWAY_ZDR,
      },
      ...providers.map((info) => ({
        hint: 'pin every request; no provider fallback',
        label: gatewayProviderLabel(info),
        value: info.name,
      })),
      { hint: 'type a provider slug', label: 'other…', value: MANUAL },
    ],
    placeholder: 'type to filter…',
  })
  if (isCancel(value)) bail()
  if (value === GATEWAY_AUTO) return {}
  if (value === GATEWAY_ZDR) return { zeroDataRetention: true }
  if (value === MANUAL) {
    const typed = await text({
      message: `${product} provider slug`,
      validate: (v) =>
        v != null && /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(v)
          ? undefined
          : 'use the provider slug from the model page',
    })
    if (isCancel(typed)) bail()
    return { provider: typed }
  }
  return { provider: value }
}

export async function pickModel(provider: ResolvedProvider) {
  const models = await loadModels(provider)
  const isGateway = isRoutingProvider(provider.type)
  // Throughput lives per-model in a separate /endpoints call the gateway doesn't
  // want to pay for the whole list. Fetch it for the models visible on the first
  // screen so tok/s shows immediately, then lazily for anything the user filters
  // to. Bounded so a large list doesn't stall the picker.
  const throughputState: ThroughputState = {
    apiKey: undefined,
    attemptedNoThroughput: new Set(),
    failureMessage: undefined,
    throughputPending: new Set(),
    throughputs: new Map(),
  }
  if (isGateway) {
    // Resolve the key once — resolveApiKey can shell out to the OS keychain,
    // far too slow to repeat per model on every render.
    const key = provider.envKey
      ? await resolveApiKey(provider.envKey, provider.name)
      : undefined
    throughputState.apiKey =
      key && key.source !== 'none' ? key.value : undefined
    await prefetchVisibleThroughput(
      provider,
      models.slice(0, MODEL_PICKER_ROWS),
      throughputState,
    )
    warnThroughputFailure(throughputState)
  }
  // Manual-entry escape hatch — never offer it if a real model id collides.
  const hasManual = models.some((m) => m.id === MANUAL)
  const value = await autocomplete({
    maxItems: MODEL_PICKER_ROWS,
    message: `model · ${provider.name}`,
    // Dynamic options getter (re-run by clack on each keystroke): for the
    // gateway, enrich the labels of the models currently shown with throughput
    // as fast as it arrives, fetching it for exactly those models.
    options(this: { cursor?: number; filteredOptions?: { value: string }[] }) {
      if (isGateway) {
        // filteredOptions is clack's whole filtered list, not the rendered
        // window. The rendered window always contains the cursor and holds at
        // most MODEL_PICKER_ROWS rows, so every visible row sits within
        // MODEL_PICKER_ROWS - 1 of it — prefetch that span instead of fanning
        // out /endpoints requests for rows never shown. .catch keeps a
        // rejection here from becoming a fatal unhandled rejection mid-prompt.
        const filtered = this.filteredOptions ?? []
        const start = Math.max(0, (this.cursor ?? 0) - (MODEL_PICKER_ROWS - 1))
        void prefetchVisibleThroughput(
          provider,
          filtered
            .slice(start, start + 2 * MODEL_PICKER_ROWS - 1)
            .map((r) => ({ id: r.value })),
          throughputState,
        ).catch(() => undefined)
      }
      const options: { hint?: string; label: string; value: string }[] =
        models.map((m) => ({
          hint: m.hint,
          label: modelLabel(
            throughputState.throughputs.has(m.id)
              ? { ...m, throughputLabel: throughputState.throughputs.get(m.id) }
              : m,
          ),
          value: m.id,
        }))
      if (!hasManual) {
        options.push({
          hint: 'type a model id',
          label: 'other…',
          value: MANUAL,
        })
      }
      return options
    },
    placeholder: 'type to filter…',
  })
  if (isCancel(value)) bail()
  warnThroughputFailure(throughputState)
  if (value === MANUAL) {
    const typed = await text({
      message: 'model id',
      validate: (v) => (v == null || v.length === 0 ? 'required' : undefined),
    })
    if (isCancel(typed)) bail()
    return typed
  }
  return value
}

function warnThroughputFailure(state: ThroughputState) {
  if (!state.failureMessage) return
  log.warn(`throughput unavailable: ${state.failureMessage}`)
  state.failureMessage = undefined
}

// Fetch throughput for a batch of models (e.g. the currently visible ones) with
// bounded concurrency, deduped against what's cached or already in flight.
async function prefetchVisibleThroughput(
  provider: ResolvedProvider,
  rows: { id: string }[],
  state: ThroughputState,
) {
  const ids = rows
    .map((r) => r.id)
    .filter(
      (id) =>
        id !== MANUAL &&
        !state.throughputs.has(id) &&
        !state.attemptedNoThroughput.has(id) &&
        !state.throughputPending.has(id),
    )
  if (ids.length === 0) return
  for (const id of ids) state.throughputPending.add(id)
  // Run all target ids through a pool of 8 in flight — the batch is bounded by
  // concurrency, not by a count cap, so every model passed in gets fetched.
  let cursor = 0
  const workers = Array.from({ length: Math.min(8, ids.length) }, async () => {
    for (;;) {
      const i = cursor++
      if (i >= ids.length) return
      const id = ids[i]
      try {
        const label = await fetchGatewayModelThroughput(
          provider,
          id,
          state.apiKey,
        )
        if (label != null) state.throughputs.set(id, label)
        else state.attemptedNoThroughput.add(id)
      } catch (error) {
        // A bad key or response-shape drift fails identically for every id —
        // retrying those on later renders would refetch the whole list per
        // keystroke. Anything else (timeout, blip) stays retryable.
        if (
          error instanceof ZodError ||
          (error instanceof HttpError &&
            (error.status === 401 || error.status === 403))
        ) {
          state.attemptedNoThroughput.add(id)
        }
        state.failureMessage ??=
          error instanceof Error ? error.message : String(error)
      } finally {
        state.throughputPending.delete(id)
      }
    }
  })
  await Promise.all(workers)
}

// Cost/throughput go in the label so they're visible across the whole list
// (clack only shows the hint on the focused row).
function gatewayProviderLabel(info: GatewayProviderInfo) {
  const cost =
    info.costInputPerMillion != null && info.costOutputPerMillion != null
      ? `${formatUsd(info.costInputPerMillion)}/${formatUsd(info.costOutputPerMillion)}`
      : undefined
  const throughput =
    info.throughputTokensPerSec != null
      ? `${Math.round(info.throughputTokensPerSec)} tps`
      : undefined
  const parts = [cost, throughput].filter((part) => part != null)
  const display = info.label ?? info.name
  return parts.length > 0 ? `${display} — ${parts.join(' · ')}` : display
}

// Model picker row: cost/throughput (when the provider lists them) go inline in
// the label so they're visible across the whole list, like the gateway provider
// picker.
async function loadModels(provider: ResolvedProvider) {
  // Skip the spinner flash when the fresh cache can answer instantly.
  const fresh = freshModels(provider.name)
  if (fresh) return fresh
  const s = spinner()
  s.start(`fetching models from ${provider.name}`)
  try {
    const models = await listModelsCached(provider)
    s.stop(`${String(models.length)} models`)
    return models
  } catch (error) {
    s.stop('model fetch failed')
    throw error
  }
}

function modelLabel(m: ModelInfo) {
  const parts = [m.costLabel, m.throughputLabel].filter((part) => part != null)
  return parts.length > 0 ? `${m.id} — ${parts.join(' · ')}` : m.id
}
