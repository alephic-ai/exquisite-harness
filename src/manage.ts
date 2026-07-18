import type { Config } from './config.js'
import type { ModelInfo, Selection } from './types.js'

import {
  allProviders,
  getProvider,
  providerLabel,
  reservedProfileNameMessage,
  saveConfig,
} from './config.js'
import { deleteApiKey, storeApiKey } from './keys.js'
import { checkProvider } from './providers.js'
import { keyStoredText, log } from './ui/output.js'
import { askApiKey } from './ui/prompts.js'

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
    console.log(
      `${name}  ${p.harness} · ${providerLabel(p.provider)} · ${p.model}`,
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
    `profile "${name}" saved — ${selection.harness} · ${selection.provider} · ${selection.model}`,
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
