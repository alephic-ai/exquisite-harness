import { cancel, confirm, isCancel, log, select, text } from '@clack/prompts'

import type { Config } from '../config.js'
import type { ProviderType } from '../types.js'

import { findBin, HARNESSES } from '../harnesses.js'
import { secretsPathForDisplay, storeApiKey } from '../keys.js'
import { checkProvider } from '../providers.js'
import { note } from './output.js'
import { askApiKey } from './prompts.js'

// Annotated: TS cannot infer `never` here, and isCancel narrowing needs it.
function bail(): never {
  cancel('bye')
  process.exit(0)
}

// First-run setup: detect harnesses, probe Ollama, detect API keys already
// in the environment, and offer to stash them in the OS credential store.
// All three matrix providers are built in, so there is nothing to write to
// the config file here — keys are the only thing worth setting up.
export async function wizard(config: Config) {
  const lines: string[] = []
  for (const [name, def] of Object.entries(HARNESSES)) {
    lines.push(`${name}: ${findBin(def.bin) ? 'installed' : 'not found'}`)
  }

  const ollama = {
    baseURL: 'http://localhost:11434',
    name: 'ollama',
    type: 'ollama' as const,
  }
  const ollamaStatus = await checkProvider(ollama)
  lines.push(
    `ollama @ localhost:11434: ${ollamaStatus.ok ? `running · ${ollamaStatus.detail}` : 'not running'}`,
  )

  const detectedKeys: { envVar: string; provider: string }[] = []
  if (process.env.OPENROUTER_API_KEY) {
    detectedKeys.push({ envVar: 'OPENROUTER_API_KEY', provider: 'openrouter' })
  }
  if (process.env.AI_GATEWAY_API_KEY) {
    detectedKeys.push({ envVar: 'AI_GATEWAY_API_KEY', provider: 'gateway' })
  }
  for (const k of detectedKeys) {
    lines.push(`${k.provider}: ${k.envVar} found in environment`)
  }

  note(lines.join('\n'), 'detected')

  for (const k of detectedKeys) {
    const wants = await confirm({
      message: `store ${k.envVar} for "${k.provider}" in the OS credential store?`,
    })
    if (isCancel(wants)) bail()
    const value = process.env[k.envVar]
    if (wants && value) {
      const where = await storeApiKey(k.provider, value)
      log.success(
        where === 'keychain'
          ? 'stored in macOS Keychain'
          : `stored in ${secretsPathForDisplay()} (mode 0600)`,
      )
    }
  }

  log.success('ollama, openrouter and gateway are built in — nothing to write')
  return config
}

// `eh provider add` — interactive provider definition.
export async function addProvider(config: Config) {
  const name = await text({
    message: 'provider name',
    validate: (v) =>
      v != null && /^[\w-]+$/.test(v)
        ? undefined
        : 'letters, digits, - and _ only',
  })
  if (isCancel(name)) bail()

  const type = await select<ProviderType>({
    message: 'type',
    options: [
      {
        hint: 'local, http://localhost:11434',
        label: 'ollama',
        value: 'ollama',
      },
      {
        hint: 'e.g. OpenRouter — chat completions only',
        label: 'openai-chat',
        value: 'openai-chat',
      },
      {
        hint: 'Vercel AI Gateway — all protocols',
        label: 'vercel-gateway',
        value: 'vercel-gateway',
      },
    ],
  })
  if (isCancel(type)) bail()

  const baseURL = await text({
    message: 'base URL',
    placeholder:
      type === 'ollama'
        ? 'http://localhost:11434'
        : type === 'vercel-gateway'
          ? 'https://ai-gateway.vercel.sh/v1'
          : 'https://openrouter.ai/api/v1',
  })
  if (isCancel(baseURL)) bail()

  const envKey = await text({
    message: 'API key env var (blank for none)',
    placeholder: type === 'vercel-gateway' ? 'AI_GATEWAY_API_KEY' : '',
  })
  if (isCancel(envKey)) bail()

  const next: Config = { ...config, providers: { ...config.providers } }
  next.providers[name] = {
    baseURL: baseURL.length > 0 ? baseURL : undefined,
    envKey: envKey.length > 0 ? envKey : undefined,
    type,
  }
  log.success(`provider "${name}" added`)

  // Non-ollama providers need a key — offer to store it right away.
  if (type !== 'ollama') {
    const wantsKey = await confirm({
      message: `store an API key for "${name}" now?`,
    })
    if (isCancel(wantsKey)) bail()
    if (wantsKey) {
      const key = await askApiKey(name)
      const where = await storeApiKey(name, key)
      log.success(
        where === 'keychain'
          ? 'stored in macOS Keychain'
          : `stored in ${secretsPathForDisplay()} (mode 0600)`,
      )
    }
  }
  return next
}
