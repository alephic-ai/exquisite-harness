import {
  autocomplete,
  confirm,
  isCancel,
  password,
  select,
  text,
} from '@clack/prompts'

import type { ResolvedProvider, ResolvedSearchProvider } from '../config.js'
import type { Protocol } from '../types.js'

import { freshModels } from '../cache.js'
import {
  providerLabel,
  reservedProfileNameMessage,
  searchProviderKeyAccount,
  searchProviderLabel,
} from '../config.js'
import { HARNESSES } from '../harnesses.js'
import { resolveApiKey, storeApiKey } from '../keys.js'
import { canServeAny, listModelsCached } from '../providers.js'
import { EFFORT_LEVELS } from '../types.js'
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
            ? 'claude only; codex maps to high'
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
  protocols: Protocol[],
  providers: ResolvedProvider[],
) {
  for (;;) {
    // Status hints per DESIGN.md: ✓ key set / ✗ KEY not set (incompatible rows
    // get `needs router`). Reachability probing stays in doctor/providers —
    // network checks don't belong in a picker.
    const rows = await Promise.all(
      providers.map(async (p) => {
        const label = providerLabel(p.name)
        if (!canServeAny(p.type, protocols)) {
          return {
            option: { hint: `${p.type} · needs router`, label, value: p.name },
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
    if (!canServeAny(provider.type, protocols)) {
      log.warn(
        `"${provider.name}" can't serve ${protocols.join(' or ')} — that needs the phase-2 router`,
      )
      continue
    }
    if (await ensureKey(provider)) return provider
    // key entry cancelled → back to the provider list
  }
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

export async function pickModel(provider: ResolvedProvider) {
  const models = await loadModels(provider)
  const options = models.map((m) => ({
    hint: m.hint,
    label: m.id,
    value: m.id,
  }))
  // Manual-entry escape hatch — never offer it if a real model id collides.
  if (!models.some((m) => m.id === MANUAL)) {
    options.push({ hint: 'type a model id', label: 'other…', value: MANUAL })
  }
  const value = await autocomplete({
    maxItems: 12,
    message: `model · ${provider.name}`,
    options,
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
