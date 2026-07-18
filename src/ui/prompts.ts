import {
  autocomplete,
  cancel,
  confirm,
  isCancel,
  password,
  select,
  spinner,
  text,
} from '@clack/prompts'

import type { ResolvedProvider } from '../config.js'
import type { Protocol } from '../types.js'

import { cachedModels, freshModels, writeModels } from '../cache.js'
import { findBin, HARNESSES } from '../harnesses.js'
import { resolveApiKey, secretsPathForDisplay, storeApiKey } from '../keys.js'
import { canServeAny, listModels } from '../providers.js'
import { EFFORT_LEVELS } from '../types.js'
import { log, note } from './output.js'

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

export async function pickProvider(
  protocols: Protocol[],
  providers: ResolvedProvider[],
) {
  for (;;) {
    const value = await select({
      message: 'provider',
      options: providers.map((p) => ({
        hint: canServeAny(p.type, protocols)
          ? `${p.type} · ${p.baseURL}`
          : 'needs router (phase 2)',
        label: p.name,
        value: p.name,
      })),
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

// A provider with an envKey needs a key from somewhere. If none resolves
// (env → OS store → file), offer to store one right here. Returns false when
// the user bails out of the key prompt.
async function ensureKey(provider: ResolvedProvider) {
  if (!provider.envKey) return true
  const key = await resolveApiKey(provider.envKey, provider.name)
  if (key.value) return true
  log.warn(`"${provider.name}" needs ${provider.envKey} — none found`)
  const value = await askApiKeyOptional(provider.name)
  if (!value) return false
  const where = await storeApiKey(provider.name, value)
  log.success(
    where === 'keychain'
      ? 'stored in macOS Keychain'
      : `stored in ${secretsPathForDisplay()} (mode 0600)`,
  )
  return true
}

// Annotated: TS cannot infer `never` here, and the narrowing at every
// isCancel call site depends on it.
function bail(): never {
  cancel('bye')
  process.exit(0)
}

const MANUAL = '__manual__'

export async function askConfirm(message: string) {
  const value = await confirm({ message })
  if (isCancel(value)) bail()
  return value
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
    validate: (v) =>
      v != null && /^[\w-]+$/.test(v)
        ? undefined
        : 'letters, digits, - and _ only',
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
    filter: (search, option) =>
      (option.label ?? '').toLowerCase().includes(search.toLowerCase()),
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
  const fresh = freshModels(provider.name)
  if (fresh) return fresh
  const s = spinner()
  s.start(`fetching models from ${provider.name}`)
  try {
    const models = await listModels(provider)
    writeModels(provider.name, models)
    s.stop(`${String(models.length)} models`)
    return models
  } catch (error) {
    s.stop('model fetch failed')
    const stale = cachedModels(provider.name)
    if (stale) return stale
    throw error
  }
}
