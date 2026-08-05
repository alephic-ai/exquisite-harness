import type { Config } from './config.js'
import type { ModelInfo, Selection } from './types.js'

import {
  allProviders,
  getProvider,
  getSearchProvider,
  providerLabel,
  reservedProfileNameMessage,
  saveConfig,
  searchProviderForSelection,
  searchProviderKeyAccount,
  searchProviderLabel,
  withDefaultSearchProvider,
} from './config.js'
import { deleteApiKey, resolveApiKey, storeApiKey } from './keys.js'
import { checkProvider } from './providers.js'
import { keyStoredText, log } from './ui/output.js'
import { askApiKey, confirmSearchProviderDefault } from './ui/prompts.js'

export function modelsList(models: ModelInfo[]) {
  for (const m of models) {
    console.log(m.hint ? `${m.id}  ${m.hint}` : m.id)
  }
}

export function profileList(config: Config) {
  const entries = Object.entries(config.profiles)
  if (entries.length === 0) {
    console.log(
      'no profiles — launch something and choose "save…", or use `eh profile save <name>`',
    )
    return
  }
  for (const [name, p] of entries) {
    const searchProvider = searchProviderForSelection(config, p)
    const search =
      searchProvider !== 'native'
        ? ` · ${searchProviderLabel(searchProvider)} search`
        : ''
    const gateway = p.gatewayProvider ? ` via ${p.gatewayProvider}` : ''
    console.log(
      `${name}  ${p.harness} · ${providerLabel(p.provider)}${gateway} · ${p.model}${search}`,
    )
  }
}

export function profileRemove(config: Config, name: string) {
  if (!(name in config.profiles)) {
    throw new Error(`no profile named "${name}"`)
  }
  const { [name]: _removed, ...rest } = config.profiles
  saveConfig({ ...config, profiles: rest })
  log.success(`profile "${name}" removed`)
}

export function profileSave(
  config: Config,
  name: string,
  selection: Selection,
) {
  const taken = reservedProfileNameMessage(name)
  if (taken) throw new Error(taken)
  saveConfig({ ...config, profiles: { ...config.profiles, [name]: selection } })
  log.success(
    `profile "${name}" saved — ${selection.harness} · ${selection.provider}${selection.gatewayProvider ? ` via ${selection.gatewayProvider}` : ''} · ${selection.model}`,
  )
}

export async function providerKeyDelete(config: Config, name: string) {
  const provider = getProvider(config, name)
  if (!provider) throw new Error(`unknown provider "${name}"`)
  const removed = await deleteApiKey(name)
  if (removed) {
    log.success(`key for "${name}" deleted`)
  } else {
    log.warn(`no stored key for "${name}"`)
  }
}

// `eh provider key <name>` — store a key in Keychain (macOS) or the 0600
// secrets file. The key travels: masked prompt → eh's stdin → store; never
// argv, never shell history, never echoed back.
export async function providerKeySet(config: Config, name: string) {
  const provider = getProvider(config, name)
  if (!provider) throw new Error(`unknown provider "${name}"`)
  const key = await askApiKey(name)
  const where = await storeApiKey(name, key)
  log.success(`key for "${name}" ${keyStoredText(where)}`)
}

export async function providersCommand(config: Config) {
  // Independent network checks — run them in parallel, print in order.
  const statuses = await Promise.all(
    allProviders(config).map(async (provider) => ({
      provider,
      status: await checkProvider(provider),
    })),
  )
  for (const { provider, status } of statuses) {
    const line = `${providerLabel(provider.name)} (${provider.name}) — ${provider.baseURL} · ${status.detail}`
    if (status.ok) {
      log.success(line)
    } else {
      log.warn(line)
    }
  }
}

export async function searchProviderKeyDelete(config: Config, name: string) {
  const provider = getSearchProvider(config, name)
  if (!provider) throw new Error(`unknown search provider "${name}"`)
  const removed = await deleteApiKey(searchProviderKeyAccount(provider.name))
  if (removed) {
    log.success(`key for search provider "${name}" deleted`)
  } else {
    log.warn(`no stored key for search provider "${name}"`)
  }
  if (config.defaultSearchProvider === provider.name) {
    const remaining = await resolveApiKey(
      provider.envKey,
      searchProviderKeyAccount(provider.name),
    )
    if (remaining.source === 'none') {
      saveConfig(withDefaultSearchProvider(config, 'native'))
      log.success('Native is the default for new Claude sessions')
    }
  }
}

export async function searchProviderKeySet(config: Config, name: string) {
  const provider = getSearchProvider(config, name)
  if (!provider) throw new Error(`unknown search provider "${name}"`)
  const key = await askApiKey(name)
  const where = await storeApiKey(searchProviderKeyAccount(provider.name), key)
  log.success(`key for search provider "${name}" ${keyStoredText(where)}`)
  if (
    config.defaultSearchProvider !== provider.name &&
    (await confirmSearchProviderDefault(provider.name))
  ) {
    saveConfig(withDefaultSearchProvider(config, provider.name))
    log.success(
      `${searchProviderLabel(provider.name)} is the default for new Claude sessions`,
    )
  }
}
