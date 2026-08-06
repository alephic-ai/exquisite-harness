import {
  autocomplete,
  confirm,
  isCancel,
  password,
  select,
  text,
} from '@clack/prompts'

import type { ResolvedProvider, ResolvedSearchProvider } from '../config.js'
import type { HarnessDef } from '../harnesses.js'

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
  listGatewayProviders,
  listModelsCached,
} from '../providers.js'
import { EFFORT_LEVELS, type ModelInfo } from '../types.js'
import { findBin } from '../which.js'
import { bail, keyStoredText, log, note, spinner } from './output.js'

type ProviderRowState = 'incompatible' | 'key-missing' | 'key-set' | 'no-key'

// Effort defaults to `auto` (model default); anything else is an override.
export async function pickEffort() {
  const value = await select({
    message: 'effort',
    options: EFFORT_LEVELS.map((level) => ({
      hint:
        level === 'auto'
          ? 'model default (recommended)'
          : level === 'xhigh' || level === 'max'
            ? 'claude + grok + pi; codex maps to high'
            : undefined,
      label: level,
      value: level,
    })),
  })
  if (isCancel(value)) bail()
  return value
}

export async function pickHarness() {
  const value = await select({
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
    const value = await select({
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
    const value = await select({
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

// What the Gateway picker returns: a pinned provider slug, or automatic
// routing (undefined) optionally restricted to ZDR providers. Both flags
// null/undefined means plain automatic Vercel routing + fallback.
export interface GatewayRouteChoice {
  provider?: string
  zeroDataRetention?: boolean
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
  const value = await select<'back' | 'go' | 'save'>({
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
  } catch {
    providers = []
    s.stop('provider fetch failed — automatic/manual still available')
  }

  const value = await autocomplete({
    maxItems: 12,
    message: `AI Gateway provider · ${model}`,
    options: [
      {
        hint: 'Vercel routing and fallback',
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
      message: 'AI Gateway provider slug',
      validate: (v) =>
        v != null && /^[A-Za-z0-9._-]+$/.test(v)
          ? undefined
          : 'use the provider slug from Vercel AI Gateway',
    })
    if (isCancel(typed)) bail()
    return { provider: typed }
  }
  return { provider: value }
}

export async function pickModel(provider: ResolvedProvider) {
  const models = await loadModels(provider)
  const isGateway = provider.type === 'vercel-gateway'
  // Throughput lives per-model in a separate /endpoints call the gateway doesn't
  // want to pay for the whole list, so it's fetched lazily — only for the models
  // actually shown — and never blocks the picker from opening.
  const throughputs = new Map<string, string>()
  const throughputPending = new Set<string>()
  // Manual-entry escape hatch — never offer it if a real model id collides.
  const hasManual = models.some((m) => m.id === MANUAL)
  const value = await autocomplete({
    maxItems: 12,
    message: `model · ${provider.name}`,
    // Dynamic options getter (re-run by clack on each keystroke): for the
    // gateway, enrich the labels of the models currently shown with throughput
    // as fast as it arrives, fetching it for exactly those models.
    options(this: { filteredOptions?: { value: string }[] }) {
      if (isGateway) {
        for (const row of this.filteredOptions ?? []) {
          if (throughputs.has(row.value) || throughputPending.has(row.value)) {
            continue
          }
          throughputPending.add(row.value)
          void fetchGatewayModelThroughput(provider, row.value).then(
            (label) => {
              if (label != null) throughputs.set(row.value, label)
            },
          )
        }
      }
      const options: { hint?: string; label: string; value: string }[] =
        models.map((m) => ({
          hint: m.hint,
          label: modelLabel(
            throughputs.has(m.id)
              ? { ...m, throughputLabel: throughputs.get(m.id) }
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
  return parts.length > 0 ? `${info.name} — ${parts.join(' · ')}` : info.name
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
