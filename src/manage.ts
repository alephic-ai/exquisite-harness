import type { Config } from './config.js'
import type { ModelInfo, Selection } from './types.js'

import { allProviders, getProvider, saveConfig } from './config.js'
import { deleteApiKey, secretsPathForDisplay, storeApiKey } from './keys.js'
import { checkProvider } from './providers.js'
import { log } from './ui/output.js'
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
    console.log(`${name}  ${p.harness} · ${p.provider} · ${p.model}`)
  }
}

// `eh provider key <name>` — store a key in Keychain (macOS) or the 0600
// secrets file. The key travels: masked prompt → eh's stdin → store; never
// argv, never shell history, never echoed back.
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
  config.profiles[name] = selection
  saveConfig(config)
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

export async function providerKeySet(config: Config, name: string) {
  const provider = getProvider(config, name)
  if (!provider) throw new Error(`unknown provider "${name}"`)
  const key = await askApiKey(name)
  const where = await storeApiKey(name, key)
  if (where === 'keychain') {
    log.success(`key for "${name}" stored in macOS Keychain (service "eh")`)
  } else {
    log.success(
      `key for "${name}" stored in ${secretsPathForDisplay()} (mode 0600)`,
    )
  }
}

export async function providersCommand(config: Config) {
  for (const provider of allProviders(config)) {
    const status = await checkProvider(provider)
    const line = `${provider.name} (${provider.type}) — ${provider.baseURL} · ${status.detail}`
    if (status.ok) {
      log.success(line)
    } else {
      log.warn(line)
    }
  }
}
