import { cancel, isCancel, log, select, text } from '@clack/prompts'

import type { Config } from '../config.js'
import type { ProviderType } from '../types.js'

import { findBin, HARNESSES } from '../harnesses.js'
import { checkProvider } from '../providers.js'
import { note } from './output.js'

// Annotated: TS cannot infer `never` here, and isCancel narrowing needs it.
function bail(): never {
  cancel('bye')
  process.exit(0)
}

// First-run setup: detect harnesses, probe Ollama, detect API keys already in
// the environment, and offer to persist what we find. Safe to re-run: it only
// ever adds providers, never removes them.
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

  const detected: { gateway?: ProviderType; openrouter?: ProviderType } = {}
  if (process.env.OPENROUTER_API_KEY) detected.openrouter = 'openai-chat'
  if (process.env.AI_GATEWAY_API_KEY) detected.gateway = 'vercel-gateway'
  for (const name of Object.keys(detected)) {
    lines.push(`${name}: API key found in environment`)
  }

  note(lines.join('\n'), 'detected')

  const choice = await select({
    message: 'write this config?',
    options: [
      { hint: configSummary(detected), label: 'yes', value: 'yes' },
      { label: 'no, use built-in defaults only', value: 'no' },
    ],
  })
  if (isCancel(choice)) bail()
  if (choice === 'no') return config

  const next: Config = { ...config, providers: { ...config.providers } }
  if (detected.openrouter) {
    next.providers.openrouter = {
      baseURL: 'https://openrouter.ai/api/v1',
      envKey: 'OPENROUTER_API_KEY',
      type: 'openai-chat',
    }
  }
  if (detected.gateway) {
    next.providers.gateway = {
      envKey: 'AI_GATEWAY_API_KEY',
      type: 'vercel-gateway',
    }
  }
  log.success('config written')
  return next
}

function configSummary(detected: {
  gateway?: ProviderType
  openrouter?: ProviderType
}) {
  const names = ['ollama', ...Object.keys(detected)]
  return `providers: ${names.join(', ')}`
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
  return next
}
