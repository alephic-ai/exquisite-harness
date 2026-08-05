import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { ResolvedProvider } from './config.js'
import type { PiModelsJson } from './pi-models-json.js'

import { parsePiModelsJson } from './pi-models-json.js'

// Where picker rows and launch-time errors send the user when pi can't serve
// a provider.
export function piModelsJsonHint() {
  const configuredDir = process.env.PI_CODING_AGENT_DIR
  const agentDir = configuredDir
    ? expandHomePath(configuredDir, os.homedir())
    : '~/.pi/agent'
  return `needs a runnable provider entry in ${path.join(agentDir, 'models.json')}`
}

// pi can only talk to providers it knows: natively (openrouter,
// vercel-ai-gateway) or declared in the user's models.json, matched by
// baseUrl. eh never writes that file (phase-1 no-mutation rule), so this is a
// gate, not a fixup. Returns the pi provider id plus the env var eh should
// inject with the resolved key — native providers read fixed names (models.dev
// convention), a models.json entry's apiKey "$VAR" names its own; undefined
// keyEnvVar = pi resolves a native, literal, or compound config value itself.
export function matchPiProvider(
  modelsJson: PiModelsJson,
  provider: ResolvedProvider,
) {
  const native = NATIVE_PI_PROVIDERS.get(provider.name)
  const nativeOverride = Object.hasOwn(modelsJson.providers, provider.name)
    ? modelsJson.providers[provider.name]
    : undefined
  if (native && nativeOverride) {
    const effectiveBaseURL = nativeOverride.baseUrl ?? native.baseURL
    if (!samePiBaseURL(effectiveBaseURL, provider.baseURL)) return undefined
    return {
      keyEnvVar:
        nativeOverride.apiKey === undefined
          ? native.envVar
          : envVarRef(nativeOverride.apiKey),
      piName: native.piName,
    }
  }
  if (native && samePiBaseURL(native.baseURL, provider.baseURL)) {
    return { keyEnvVar: native.envVar, piName: native.piName }
  }

  const exact = Object.hasOwn(modelsJson.providers, provider.name)
    ? modelsJson.providers[provider.name]
    : undefined
  if (
    !native &&
    exact !== undefined &&
    isRunnableCustomPiProvider(exact) &&
    samePiBaseURL(exact.baseUrl, provider.baseURL)
  ) {
    return piProviderMatch(provider.name, exact)
  }

  const matches = Object.entries(modelsJson.providers).filter(
    ([piName, entry]) =>
      piName !== provider.name &&
      isRunnableCustomPiProvider(entry) &&
      samePiBaseURL(entry.baseUrl, provider.baseURL),
  )
  const match = matches.length === 1 ? matches.at(0) : undefined
  return match ? piProviderMatch(...match) : undefined
}

// HarnessDef.providerCompat for pi.
export function piProviderCompat(provider: ResolvedProvider) {
  if (resolvePiProvider(provider)) return { ok: true as const }
  return { hint: piModelsJsonHint(), ok: false as const }
}

// models.json read is memoized for the process — picker and launch plan both
// ask, and the file doesn't change mid-run.
export function resolvePiProvider(provider: ResolvedProvider) {
  return matchPiProvider(loadPiModelsJson(), provider)
}

// Loopback aliases and the optional /v1 suffix must not defeat matching: eh's
// ollama default is http://localhost:11434 while a models.json entry typically
// says http://127.0.0.1:11434/v1.
function samePiBaseURL(a: string, b: string) {
  return normalizeBaseURL(a) === normalizeBaseURL(b)
}

// pi's native catalog (models.dev-derived) knows these providers under fixed
// ids, upstreams, and key env vars. Applies only when eh's baseURL matches the
// native upstream — a repointed baseURL (proxy) falls through to models.json.
const NATIVE_PI_PROVIDERS = new Map<
  string,
  { baseURL: string; envVar: string; piName: string }
>([
  [
    'openrouter',
    {
      baseURL: 'https://openrouter.ai/api/v1',
      envVar: 'OPENROUTER_API_KEY',
      piName: 'openrouter',
    },
  ],
  [
    'vercel-ai-gateway',
    {
      baseURL: 'https://ai-gateway.vercel.sh/v1',
      envVar: 'AI_GATEWAY_API_KEY',
      piName: 'vercel-ai-gateway',
    },
  ],
])

let cachedModelsJson: PiModelsJson | undefined

// Only an exact "$VAR" / "${VAR}" names a single value eh can inject. Pi owns
// compound templates, escaped dollars, commands, and literals.
function envVarRef(apiKey: string) {
  const match = /^(?:\$([A-Za-z_]\w*)|\$\{([A-Za-z_]\w*)\})$/.exec(apiKey)
  return match?.at(1) ?? match?.at(2)
}

function expandHomePath(value: string, home: string) {
  if (value === '~') return home
  return /^~[/\\]/.test(value) ? path.join(home, value.slice(2)) : value
}

function isRunnableCustomPiProvider(
  entry: PiModelsJson['providers'][string],
): entry is PiModelsJson['providers'][string] & {
  apiKey: string
  baseUrl: string
} {
  return (
    entry.baseUrl !== undefined &&
    Boolean(entry.apiKey?.trim()) &&
    entry.models !== undefined &&
    entry.models.length > 0 &&
    entry.models.every((model) => Boolean((model.api ?? entry.api)?.trim()))
  )
}

function loadPiModelsJson() {
  if (cachedModelsJson) return cachedModelsJson
  cachedModelsJson = { providers: {} }
  try {
    const parsed = parsePiModelsJson(readFileSync(piModelsJsonPath(), 'utf8'))
    if (parsed) cachedModelsJson = parsed
  } catch {
    // Missing or malformed — treated as no custom providers.
  }
  return cachedModelsJson
}

function normalizeBaseURL(raw: string) {
  try {
    const url = new URL(raw)
    const host = url.hostname === 'localhost' ? '127.0.0.1' : url.hostname
    const port =
      url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port
    const pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')
    return `${url.protocol}//${host}:${port}${pathname}`
  } catch {
    // Unparseable — compare the raw-ish string instead.
    return raw.trim().toLowerCase().replace(/\/+$/, '').replace(/\/v1$/, '')
  }
}

function piModelsJsonPath() {
  const home = os.homedir()
  const agentDir = expandHomePath(
    process.env.PI_CODING_AGENT_DIR ?? path.join(home, '.pi', 'agent'),
    home,
  )
  return path.join(agentDir, 'models.json')
}

function piProviderMatch(
  piName: string,
  entry: PiModelsJson['providers'][string],
) {
  return {
    keyEnvVar: entry.apiKey === undefined ? undefined : envVarRef(entry.apiKey),
    piName,
  }
}
