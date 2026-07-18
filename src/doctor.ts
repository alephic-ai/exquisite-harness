import type { Config } from './config.js'

import { allProviders, configPath } from './config.js'
import { HARNESSES } from './harnesses.js'
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
    const line = `${provider.name} (${provider.type}) — ${status.detail}`
    if (status.ok) {
      log.success(line)
    } else if ('keyless' in status) {
      // An unset key is a normal unconfigured state, not a failure.
      log.warn(line)
    } else {
      log.error(line)
    }
  }
}
