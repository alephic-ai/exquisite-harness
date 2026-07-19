import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'

import type { ProviderType, Selection } from './types.js'

import { EFFORT_LEVELS, PROVIDER_TYPES } from './types.js'

const providerConfigSchema = z.object({
  baseURL: z.string().optional(),
  envKey: z.string().optional(),
  type: z.enum(PROVIDER_TYPES),
})

const selectionSchema = z.object({
  effort: z.enum(EFFORT_LEVELS).optional(),
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
// all. Ollama works zero-config; openrouter / vercel-ai-gateway show a
// "key not set" hint until a key is stored or the env var is set.
// The config file only needs to override these or add custom providers.
const BUILTIN_PROVIDERS: Record<string, ProviderConfig> = {
  'ollama': { baseURL: DEFAULT_BASE_URLS.ollama, type: 'ollama' },
  'openrouter': {
    baseURL: 'https://openrouter.ai/api/v1',
    envKey: 'OPENROUTER_API_KEY',
    type: 'openai-chat',
  },
  'vercel-ai-gateway': {
    envKey: 'AI_GATEWAY_API_KEY',
    type: 'vercel-gateway',
  },
}

// Old short name still resolves so profiles/recents/keys keep working.
const PROVIDER_NAME_ALIASES: Record<string, string> = {
  gateway: 'vercel-ai-gateway',
}

const BUILTIN_PROVIDER_LABELS: Record<string, string> = {
  'ollama': 'Ollama',
  'openrouter': 'OpenRouter',
  'vercel-ai-gateway': 'Vercel AI Gateway',
}

export function allProviders(config: Config) {
  const merged: Record<string, ProviderConfig> = { ...BUILTIN_PROVIDERS }
  // Fold config overrides under canonical names (e.g. legacy "gateway" → …).
  for (const [name, p] of Object.entries(config.providers)) {
    merged[canonicalProviderName(name)] = p
  }
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

export function canonicalProviderName(name: string) {
  return PROVIDER_NAME_ALIASES[name] ?? name
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
  return existsSync(configPath())
}

export function configPath() {
  return path.join(configDir(), 'config.json')
}

export function defaultBaseURLFor(type: ProviderType) {
  return DEFAULT_BASE_URLS[type]
}

// Human label for pickers / statusline (CLI id stays kebab-case).
export function providerLabel(name: string) {
  return BUILTIN_PROVIDER_LABELS[canonicalProviderName(name)] ?? name
}

// Keychain/file account names to try for a provider (canonical first, then
// legacy aliases so a key stored as "gateway" still resolves).
export function providerKeyAccounts(name: string) {
  const canon = canonicalProviderName(name)
  const aliases = Object.entries(PROVIDER_NAME_ALIASES)
    .filter(([, target]) => target === canon)
    .map(([alias]) => alias)
  return [...new Set([canon, ...aliases, name])]
}

// Commander subcommands shadow a same-named profile: `eh doctor` always runs
// the subcommand, so a profile called "doctor" could never be launched.
const RESERVED_PROFILE_NAMES = [
  'doctor',
  'models',
  'profile',
  'provider',
  'providers',
  'setup',
  'statusline',
  'update',
]

export function getProvider(config: Config, name: string) {
  const canon = canonicalProviderName(name)
  return allProviders(config).find((p) => p.name === canon)
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

// The one wording for a profile-name collision — returned for validators,
// thrown by the command paths. Undefined when the name is free.
export function reservedProfileNameMessage(name: string) {
  return RESERVED_PROFILE_NAMES.includes(name)
    ? `"${name}" is a subcommand — pick another profile name`
    : undefined
}

export function saveConfig(config: Config) {
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`)
}

function emptyConfig() {
  const profiles: Record<string, Selection> = {}
  const providers: Record<string, ProviderConfig> = {}
  return { profiles, providers, recent: [], version: 1 as const }
}
