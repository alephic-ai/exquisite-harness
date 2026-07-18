import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'

import type { ProviderType, Selection } from './types.js'

const providerConfigSchema = z.object({
  baseURL: z.string().optional(),
  envKey: z.string().optional(),
  type: z.enum(['ollama', 'openai-chat', 'vercel-gateway']),
})

const selectionSchema = z.object({
  harness: z.string(),
  model: z.string(),
  provider: z.string(),
})

const recentEntrySchema = selectionSchema.extend({ usedAt: z.string() })

const configSchema = z.object({
  profiles: z.record(z.string(), selectionSchema).default({}),
  providers: z.record(z.string(), providerConfigSchema).default({}),
  recent: z.array(recentEntrySchema).default([]),
  version: z.literal(1),
})

export type Config = z.infer<typeof configSchema>
export type ProviderConfig = z.infer<typeof providerConfigSchema>
export type RecentEntry = z.infer<typeof recentEntrySchema>

export interface ResolvedProvider {
  baseURL: string
  envKey?: string
  name: string
  type: ProviderType
}

const MAX_RECENT = 10

const DEFAULT_BASE_URLS: Record<ProviderType, string> = {
  'ollama': 'http://localhost:11434',
  'openai-chat': '',
  'vercel-gateway': 'https://ai-gateway.vercel.sh/v1',
}

const DEFAULT_ENV_KEYS: Partial<Record<ProviderType, string>> = {
  'vercel-gateway': 'AI_GATEWAY_API_KEY',
}

// All three matrix providers are built in — visible with no config file at
// all. Ollama works zero-config; openrouter/gateway show a "key not set"
// hint until a key is stored (`eh provider key <name>`) or the env var is set.
// The config file only needs to override these or add custom providers.
const BUILTIN_PROVIDERS: Record<string, ProviderConfig> = {
  gateway: { envKey: 'AI_GATEWAY_API_KEY', type: 'vercel-gateway' },
  ollama: { baseURL: DEFAULT_BASE_URLS.ollama, type: 'ollama' },
  openrouter: {
    baseURL: 'https://openrouter.ai/api/v1',
    envKey: 'OPENROUTER_API_KEY',
    type: 'openai-chat',
  },
}

export function allProviders(config: Config) {
  const merged = { ...BUILTIN_PROVIDERS, ...config.providers }
  return Object.entries(merged).map(([name, p]) => ({
    baseURL: p.baseURL ?? DEFAULT_BASE_URLS[p.type],
    envKey: p.envKey ?? DEFAULT_ENV_KEYS[p.type],
    name,
    type: p.type,
  }))
}

export function cachePath() {
  return path.join(configDir(), 'cache.json')
}

export function configDir() {
  const xdg = process.env.XDG_CONFIG_HOME
  if (xdg) return path.join(xdg, 'eh')
  // XDG on linux/macOS, %APPDATA% on Windows — same convention as gh.
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? os.homedir(), 'eh')
  }
  return path.join(os.homedir(), '.config', 'eh')
}

export function configExists() {
  try {
    readFileSync(configPath())
    return true
  } catch {
    return false
  }
}

export function configPath() {
  return path.join(configDir(), 'config.json')
}

export function emptyConfig() {
  const profiles: Record<string, Selection> = {}
  const providers: Record<string, ProviderConfig> = {}
  return { profiles, providers, recent: [], version: 1 as const }
}

export function getProvider(config: Config, name: string) {
  return allProviders(config).find((p) => p.name === name)
}

export function loadConfig() {
  let raw: string
  try {
    raw = readFileSync(configPath(), 'utf8')
  } catch {
    return emptyConfig()
  }
  let data: unknown
  try {
    // JSON.parse returns any; assigning into an unknown-typed var is the
    // sanctioned way to re-enter type safety.
    data = JSON.parse(raw) as unknown
  } catch {
    throw new Error(`invalid config at ${configPath()} — not valid JSON`)
  }
  const parsed = configSchema.safeParse(data)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ')
    throw new Error(`invalid config at ${configPath()} — ${issues}`)
  }
  return parsed.data
}

export function pushRecent(config: Config, selection: Selection) {
  const entry: RecentEntry = { ...selection, usedAt: new Date().toISOString() }
  const rest = config.recent.filter(
    (r) =>
      !(
        r.harness === selection.harness &&
        r.provider === selection.provider &&
        r.model === selection.model
      ),
  )
  return { ...config, recent: [entry, ...rest].slice(0, MAX_RECENT) }
}

export function saveConfig(config: Config) {
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`)
}
