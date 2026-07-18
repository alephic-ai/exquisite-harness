import type { Config } from './config.js'

import { allProviders, configPath } from './config.js'
import { findBin, HARNESSES } from './harnesses.js'
import { checkProvider } from './providers.js'
import { log } from './ui/output.js'

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

  for (const provider of allProviders(config)) {
    const status = await checkProvider(provider)
    const line = `${provider.name} (${provider.type}) — ${status.detail}`
    if (status.ok) {
      log.success(line)
    } else {
      log.error(line)
    }
  }
}
