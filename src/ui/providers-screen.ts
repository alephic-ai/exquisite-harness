import { isCancel } from '@clack/prompts'

import type {
  Config,
  ResolvedProvider,
  ResolvedSearchProvider,
} from '../config.js'
import type { ResolvedKey } from '../keys.js'

import {
  allProviders,
  allSearchProviders,
  providerLabel,
  saveConfig,
  searchProviderKeyAccount,
  searchProviderLabel,
  withDefaultSearchProvider,
} from '../config.js'
import { deleteApiKey, resolveApiKey, storeApiKey } from '../keys.js'
import { letterSelect } from './letter-select.js'
import { bail, keyStoredText, log, note } from './output.js'
import { askApiKeyOptional, confirmSearchProviderDefault } from './prompts.js'

type ProviderRowState = 'key-missing' | 'key-set' | 'no-key'

const BACK = '__back__'
const MODEL_HEADING = '__model_heading__'
const MODEL_PREFIX = 'model:'
const SEARCH_HEADING = '__search_heading__'
const SEARCH_PREFIX = 'search:'

// Providers with a key set first, then no-key-needed, then keyless. Stable
// sort keeps config order within each group.
const ROW_ORDER: Record<ProviderRowState, number> = {
  'key-missing': 2,
  'key-set': 0,
  'no-key': 1,
}

// Home → providers: model and search providers in one management screen.
export async function providersScreen(config: Config) {
  let currentConfig = config
  for (;;) {
    const modelProviders = allProviders(currentConfig)
    const searchProviders = allSearchProviders(currentConfig)
    const defaultSearchProvider =
      currentConfig.defaultSearchProvider ?? 'native'
    const [modelRows, searchRows] = await Promise.all([
      Promise.all(
        modelProviders.map(async (provider) => {
          const key = provider.envKey
            ? await resolveApiKey(provider.envKey, provider.name)
            : undefined
          const state: ProviderRowState =
            key === undefined
              ? 'no-key'
              : key.source === 'none'
                ? 'key-missing'
                : 'key-set'
          return {
            option: {
              hint: provider.envKey
                ? `${provider.type} · ${keyHint(key)}`
                : `${provider.type} · no key needed`,
              label:
                state === 'key-missing'
                  ? `⚠ ${providerLabel(provider.name)}`
                  : providerLabel(provider.name),
              value: `${MODEL_PREFIX}${provider.name}`,
            },
            state,
          }
        }),
      ),
      Promise.all(
        searchProviders.map(async (provider) => {
          const key = await resolveApiKey(
            provider.envKey,
            searchProviderKeyAccount(provider.name),
          )
          const state: ProviderRowState =
            key.source === 'none' ? 'key-missing' : 'key-set'
          return {
            option: {
              hint: `${provider.type} · ${keyHint(key)}`,
              label:
                state === 'key-missing'
                  ? `⚠ ${searchProviderLabel(provider.name)}${defaultSearchProvider === provider.name ? ' · default' : ''}`
                  : `${searchProviderLabel(provider.name)}${defaultSearchProvider === provider.name ? ' · default' : ''}`,
              value: `${SEARCH_PREFIX}${provider.name}`,
            },
            state,
          }
        }),
      ),
    ])
    modelRows.sort((a, b) => ROW_ORDER[a.state] - ROW_ORDER[b.state])
    const nativeRow = {
      option: {
        hint: `Claude Code native search${defaultSearchProvider === 'native' ? ' · default' : ''}`,
        label: `Native${defaultSearchProvider === 'native' ? ' · default' : ''}`,
        value: `${SEARCH_PREFIX}native`,
      },
      state: 'no-key' as const,
    }
    const sortedSearchRows = [nativeRow, ...searchRows].sort(
      (a, b) => ROW_ORDER[a.state] - ROW_ORDER[b.state],
    )
    const value = await letterSelect({
      message: 'providers',
      options: [
        {
          disabled: true,
          label: 'Model providers',
          value: MODEL_HEADING,
        },
        ...modelRows.map((row) => row.option),
        {
          disabled: true,
          label: 'Search providers',
          value: SEARCH_HEADING,
        },
        ...sortedSearchRows.map((row) => row.option),
        { hint: 'home', label: '← back', value: BACK },
      ],
    })
    if (isCancel(value)) bail()
    if (value === BACK) return currentConfig
    if (value.startsWith(MODEL_PREFIX)) {
      const name = value.slice(MODEL_PREFIX.length)
      const provider = modelProviders.find((item) => item.name === name)
      if (provider) await modelProviderActions(provider)
    }
    if (value.startsWith(SEARCH_PREFIX)) {
      const name = value.slice(SEARCH_PREFIX.length)
      if (name === 'native') {
        currentConfig = await nativeSearchProviderActions(currentConfig)
        continue
      }
      const provider = searchProviders.find((item) => item.name === name)
      if (provider) {
        currentConfig = await searchProviderActions(currentConfig, provider)
      }
    }
  }
}

function keyHint(key: ResolvedKey | undefined) {
  return key && key.source !== 'none' ? `key from ${key.source}` : '⚠ no key'
}

async function modelProviderActions(provider: ResolvedProvider) {
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

  const action = await letterSelect({ message: provider.name, options })
  if (isCancel(action)) bail()
  if (action === BACK) return
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

async function nativeSearchProviderActions(config: Config) {
  const isDefault = (config.defaultSearchProvider ?? 'native') === 'native'
  note(
    [
      'Native',
      'Claude Code server search',
      `default: ${isDefault ? 'yes' : 'no'}`,
    ].join('\n'),
    'search provider',
  )
  const options = [
    ...(!isDefault ? [{ label: 'make default', value: 'default' }] : []),
    { label: '← back', value: BACK },
  ]
  const action = await letterSelect({ message: 'native', options })
  if (isCancel(action)) bail()
  if (action === BACK) return config
  return setDefaultSearchProvider(config, 'native')
}

async function searchProviderActions(
  config: Config,
  provider: ResolvedSearchProvider,
) {
  const account = searchProviderKeyAccount(provider.name)
  const key = await resolveApiKey(provider.envKey, account)
  const isDefault = config.defaultSearchProvider === provider.name
  note(
    [
      `${searchProviderLabel(provider.name)} (${provider.name})`,
      provider.baseURL,
      `key: ${key.source === 'none' ? 'not set' : `set (${key.source})`}`,
      `default: ${isDefault ? 'yes' : 'no'}`,
    ].join('\n'),
    'search provider',
  )

  const options = [
    ...(!isDefault ? [{ label: 'make default', value: 'default' }] : []),
    { label: 'set/replace key…', value: 'set' },
  ]
  if (key.source !== 'none' && key.source !== 'env') {
    options.push({ label: 'delete stored key', value: 'delete' })
  }
  options.push({ label: '← back', value: BACK })

  const action = await letterSelect({ message: provider.name, options })
  if (isCancel(action)) bail()
  if (action === BACK) return config
  if (action === 'default') {
    if (key.source === 'none') {
      const value = await askApiKeyOptional(`${provider.name} search`)
      if (!value) return config
      const where = await storeApiKey(account, value)
      log.success(keyStoredText(where))
    }
    return setDefaultSearchProvider(config, provider.name)
  }
  if (action === 'set') {
    const value = await askApiKeyOptional(`${provider.name} search`)
    if (value) {
      const where = await storeApiKey(account, value)
      log.success(keyStoredText(where))
      if (!isDefault) {
        if (await confirmSearchProviderDefault(provider.name)) {
          return setDefaultSearchProvider(config, provider.name)
        }
      }
    }
    return config
  }
  if (action === 'delete') {
    await deleteApiKey(account)
    log.success(`key for search provider "${provider.name}" deleted`)
    const remaining = await resolveApiKey(provider.envKey, account)
    if (isDefault && remaining.source === 'none') {
      return setDefaultSearchProvider(config, 'native')
    }
  }
  return config
}

function setDefaultSearchProvider(config: Config, name: string) {
  const next = withDefaultSearchProvider(config, name)
  saveConfig(next)
  log.success(
    `${searchProviderLabel(name)} is the default for new Claude sessions`,
  )
  return next
}
