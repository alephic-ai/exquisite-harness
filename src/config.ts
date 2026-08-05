import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'

import type { ProviderType, SearchProviderType, Selection } from './types.js'

import {
  EFFORT_LEVELS,
  PROVIDER_TYPES,
  SEARCH_PROVIDER_TYPES,
} from './types.js'

const providerConfigSchema = z.object({
  baseURL: z.string().optional(),
  envKey: z.string().optional(),
  type: z.enum(PROVIDER_TYPES),
})

const searchProviderConfigSchema = z.object({
  baseURL: z.string().optional(),
  envKey: z.string().optional(),
  type: z.enum(SEARCH_PROVIDER_TYPES),
})

const selectionSchema = z.object({
  effort: z.enum(EFFORT_LEVELS).optional(),
  gatewayProvider: z.string().optional(),
  harness: z.string(),
  model: z.string(),
  provider: z.string(),
  searchProvider: z.string().optional(),
})

// cwd is optional so recents written before `eh -r` existed still parse.
const recentEntrySchema = selectionSchema.extend({
  cwd: z.string().optional(),
  usedAt: z.string(),
})

const configSchema = z.object({
  defaultSearchProvider: z.string().optional(),
  profiles: z.record(z.string(), selectionSchema).default({}),
  providers: z.record(z.string(), providerConfigSchema).default({}),
  recent: z.array(recentEntrySchema).default([]),
  searchProviders: z.record(z.string(), searchProviderConfigSchema).default({}),
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

export interface ResolvedSearchProvider {
  baseURL: string
  envKey: string
  name: string
  type: SearchProviderType
}

export type SearchProviderConfig = z.infer<typeof searchProviderConfigSchema>

const MAX_RECENT = 10

const DEFAULT_BASE_URLS: Record<ProviderType, string> = {
  'ollama': 'http://localhost:11434',
  'openai-chat': '',
  'vercel-gateway': 'https://ai-gateway.vercel.sh/v1',
}

const DEFAULT_ENV_KEYS: Partial<Record<ProviderType, string>> = {
  'vercel-gateway': 'AI_GATEWAY_API_KEY',
}

const DEFAULT_SEARCH_BASE_URLS: Record<SearchProviderType, string> = {
  firecrawl: 'https://api.firecrawl.dev',
}

const DEFAULT_SEARCH_ENV_KEYS: Record<SearchProviderType, string> = {
  firecrawl: 'FIRECRAWL_API_KEY',
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

const BUILTIN_SEARCH_PROVIDERS: Record<string, SearchProviderConfig> = {
  firecrawl: { type: 'firecrawl' },
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

const BUILTIN_SEARCH_PROVIDER_LABELS: Record<string, string> = {
  firecrawl: 'Firecrawl',
  native: 'Native',
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

export function allSearchProviders(config: Config) {
  const merged: Record<string, SearchProviderConfig> = {
    ...BUILTIN_SEARCH_PROVIDERS,
    ...config.searchProviders,
  }
  return Object.entries(merged).map(([name, provider]) => ({
    baseURL: provider.baseURL ?? DEFAULT_SEARCH_BASE_URLS[provider.type],
    envKey: provider.envKey ?? DEFAULT_SEARCH_ENV_KEYS[provider.type],
    name,
    type: provider.type,
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

export function searchProviderLabel(name: string) {
  return BUILTIN_SEARCH_PROVIDER_LABELS[name] ?? name
}

// Keep search credentials separate from model-provider credentials even when
// a user gives both providers the same config name.
export function searchProviderForSelection(
  config: Config,
  selection: Partial<Selection>,
) {
  if (selection.searchProvider !== undefined) return selection.searchProvider
  return selection.harness === 'claude'
    ? (config.defaultSearchProvider ?? 'native')
    : 'native'
}

export function searchProviderKeyAccount(name: string) {
  return `search:${name}`
}

// Recents are home-screen shortcuts, so changing the global preference should
// make those shortcuts honor it too. Profiles remain reproducible and keep the
// search provider they were explicitly saved with.
export function withDefaultSearchProvider(config: Config, name: string) {
  const recent = config.recent.map((entry) =>
    entry.harness === 'claude' ? { ...entry, searchProvider: name } : entry,
  )
  return {
    ...config,
    defaultSearchProvider: name,
    // Retargeting native and external shortcuts can collapse two entries into
    // the same launch. Keep only the newest one (recents are newest-first).
    recent: recent.filter(
      (entry, index) =>
        recent.findIndex(
          (candidate) =>
            sameRecentSelection(config, candidate, entry) &&
            candidate.cwd === entry.cwd,
        ) === index,
    ),
  }
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
  'run',
  'search',
  'setup',
  'statusline',
  'update',
  'web-fetch-hook',
]

export function getProvider(config: Config, name: string) {
  const canon = canonicalProviderName(name)
  return allProviders(config).find((p) => p.name === canon)
}

export function getSearchProvider(config: Config, name: string) {
  return allSearchProviders(config).find((provider) => provider.name === name)
}

export function loadConfig() {
  let raw: string
  try {
    raw = readFileSync(configPath(), 'utf8')
  } catch {
    // No config file yet — the schema defaults are the empty config.
    return configSchema.parse({ version: 1 })
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
  const entry: RecentEntry = {
    ...selection,
    cwd: process.cwd(),
    usedAt: new Date().toISOString(),
  }
  // Identity includes cwd: a launch in one directory must not evict another
  // directory's last combo — `eh -r` matches recents on cwd. Pre-cwd recents
  // (undefined) are always replaced; their directory is unknown anyway.
  const rest = config.recent.filter(
    (r) =>
      !(
        sameRecentSelection(config, r, selection) &&
        (r.cwd === undefined || r.cwd === process.cwd())
      ),
  )
  return { ...config, recent: [entry, ...rest].slice(0, MAX_RECENT) }
}

function sameRecentSelection(config: Config, a: Selection, b: Selection) {
  return (
    a.harness === b.harness &&
    a.provider === b.provider &&
    a.model === b.model &&
    a.gatewayProvider === b.gatewayProvider &&
    searchProviderForSelection(config, a) ===
      searchProviderForSelection(config, b)
  )
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
