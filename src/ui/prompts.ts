import {
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
import { canServeAny, listModels } from '../providers.js'
import { note } from './output.js'

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
    throw new Error(
      `provider "${provider.name}" cannot serve ${protocols.join(' or ')} yet`,
    )
  }
  return provider
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
  // Sentinel value for the manual-entry escape hatch — never offer it if a
  // real model id collides with it (select values must stay unique).
  if (!models.some((m) => m.id === MANUAL)) {
    options.push({ hint: 'type a model id', label: 'other…', value: MANUAL })
  }
  const value = await select({
    maxItems: 12,
    message: `model · ${provider.name}`,
    options,
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
