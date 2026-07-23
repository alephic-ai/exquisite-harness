import { isCancel, select } from '@clack/prompts'

import type { Config, ResolvedProvider } from '../config.js'
import type { ResolvedKey } from '../keys.js'

import { allProviders, providerLabel } from '../config.js'
import { deleteApiKey, resolveApiKey, storeApiKey } from '../keys.js'
import { keyStoredText, log, note } from './output.js'
import { askApiKeyOptional } from './prompts.js'

type ProviderRowState = 'key-missing' | 'key-set' | 'no-key'

const BACK = '__back__'

// Providers with a key set first, then no-key-needed, then keyless. Stable
// sort keeps config order within each group.
const ROW_ORDER: Record<ProviderRowState, number> = {
  'key-missing': 2,
  'key-set': 0,
  'no-key': 1,
}

function keyHint(key: ResolvedKey | undefined) {
  return key && key.source !== 'none' ? `key from ${key.source}` : '⚠ no key'
}

// Home → providers: status per provider, with set/delete-key actions for the
// ones that need keys. Loops until the user backs out.
export async function providersScreen(config: Config) {
  for (;;) {
    const providers = allProviders(config)
    const rows = await Promise.all(
      providers.map(async (p) => {
        const key = p.envKey ? await resolveApiKey(p.envKey, p.name) : undefined
        const state: ProviderRowState =
          key === undefined
            ? 'no-key'
            : key.source === 'none'
              ? 'key-missing'
              : 'key-set'
        return {
          option: {
            hint: p.envKey
              ? `${p.type} · ${keyHint(key)}`
              : `${p.type} · no key needed`,
            label:
              state === 'key-missing'
                ? `⚠ ${providerLabel(p.name)}`
                : providerLabel(p.name),
            value: p.name,
          },
          state,
        }
      }),
    )
    rows.sort((a, b) => ROW_ORDER[a.state] - ROW_ORDER[b.state])
    const options = rows.map((r) => r.option)
    options.push({ hint: 'home', label: '← back', value: BACK })
    const value = await select({ message: 'providers', options })
    if (isCancel(value) || value === BACK) return
    const provider = providers.find((p) => p.name === value)
    if (provider) await providerActions(provider)
  }
}

async function providerActions(provider: ResolvedProvider) {
  const key = provider.envKey
    ? await resolveApiKey(provider.envKey, provider.name)
    : undefined
  note(
    [
      `${providerLabel(provider.name)} (${provider.name})`,
      provider.baseURL,
      provider.envKey
        ? `key: ${key && key.source !== 'none' ? `set (${key.source})` : 'not set'}`
        : 'no key needed',
    ].join('\n'),
    'provider',
  )
  if (!provider.envKey) return

  const options = [{ label: 'set key…', value: 'set' }]
  // Can't delete a key that lives in the shell environment — only stored ones.
  if (key && key.source !== 'none' && key.source !== 'env') {
    options.push({ label: 'delete stored key', value: 'delete' })
  }
  options.push({ label: '← back', value: BACK })

  const action = await select({ message: provider.name, options })
  if (isCancel(action) || action === BACK) return
  if (action === 'set') {
    const value = await askApiKeyOptional(provider.name)
    if (value) {
      const where = await storeApiKey(provider.name, value)
      log.success(keyStoredText(where))
    }
    return
  }
  if (action === 'delete') {
    await deleteApiKey(provider.name)
    log.success(`key for "${provider.name}" deleted`)
  }
}
