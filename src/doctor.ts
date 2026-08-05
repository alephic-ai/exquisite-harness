import type { Config } from './config.js'

import {
  allProviders,
  allSearchProviders,
  configPath,
  providerLabel,
  searchProviderKeyAccount,
  searchProviderLabel,
} from './config.js'
import { HARNESSES } from './harnesses.js'
import { resolveApiKey } from './keys.js'
import { checkProvider } from './providers.js'
import { log } from './ui/output.js'
import { findBin } from './which.js'

export async function doctor(config: Config) {
  log.step(`config: ${configPath()}`)

  for (const [name, def] of Object.entries(HARNESSES)) {
    const bin = findBin(def.bin)
    if (bin) {
      log.success(`${name} (${def.label}) — ${bin}`)
    } else {
      log.warn(`${name} (${def.label}) — not installed`)
    }
  }

  // Independent network checks — run them in parallel, print in order.
  const statuses = await Promise.all(
    allProviders(config).map(async (provider) => ({
      provider,
      status: await checkProvider(provider),
    })),
  )
  for (const { provider, status } of statuses) {
    const line = `${providerLabel(provider.name)} (${provider.name}) — ${status.detail}`
    if (status.ok) {
      log.success(line)
    } else if ('keyless' in status) {
      // An unset key is a normal unconfigured state, not a failure.
      log.warn(line)
    } else {
      log.error(line)
    }
  }

  const searchStatuses = await Promise.all(
    allSearchProviders(config).map(async (provider) => ({
      key: await resolveApiKey(
        provider.envKey,
        searchProviderKeyAccount(provider.name),
      ),
      provider,
    })),
  )
  for (const { key, provider } of searchStatuses) {
    const prefix = `${searchProviderLabel(provider.name)} search (${provider.name}) — ${provider.baseURL}`
    if (key.source === 'none') {
      log.warn(
        `${prefix} · ${provider.envKey} not set — run eh search key ${provider.name}`,
      )
    } else {
      log.success(`${prefix} · key from ${key.source}`)
    }
  }
}
