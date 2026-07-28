import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'

import type { ResolvedProvider } from './config.js'

// Where picker rows and launch-time errors send the user when pi can't serve
// a provider.
export const PI_MODELS_JSON_HINT = 'needs an entry in ~/.pi/agent/models.json'

const piModelsJsonSchema = z.object({
  providers: z
    .record(
      z.string(),
      z.looseObject({
        apiKey: z.string().optional(),
        baseUrl: z.string().optional(),
      }),
    )
    .default({}),
})
export type PiModelsJson = z.infer<typeof piModelsJsonSchema>

// pi can only talk to providers it knows: natively (openrouter,
// vercel-ai-gateway) or declared in the user's models.json, matched by
// baseUrl. eh never writes that file (phase-1 no-mutation rule), so this is a
// gate, not a fixup. Returns the pi provider id plus the env var eh should
// inject with the resolved key — native providers read fixed names (models.dev
// convention), a models.json entry's apiKey "$VAR" names its own; undefined
// keyEnvVar = pi already has what it needs (literal/absent apiKey).
export function matchPiProvider(
  modelsJson: PiModelsJson,
  provider: ResolvedProvider,
) {
  // Object.hasOwn guard — Record index access would claim every key exists.
  const native = Object.hasOwn(NATIVE_PI_PROVIDERS, provider.name)
    ? NATIVE_PI_PROVIDERS[provider.name]
    : undefined
  if (native && samePiBaseURL(native.baseURL, provider.baseURL)) {
    return { keyEnvVar: native.envVar, piName: native.piName }
  }
  for (const [piName, entry] of Object.entries(modelsJson.providers)) {
    if (
      entry.baseUrl !== undefined &&
      samePiBaseURL(entry.baseUrl, provider.baseURL)
    ) {
      return {
        keyEnvVar:
          entry.apiKey === undefined ? undefined : envVarRef(entry.apiKey),
        piName,
      }
    }
  }
  return undefined
}

// HarnessDef.providerCompat for pi.
export function piProviderCompat(provider: ResolvedProvider) {
  if (resolvePiProvider(provider)) return { ok: true as const }
  return { hint: PI_MODELS_JSON_HINT, ok: false as const }
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
const NATIVE_PI_PROVIDERS: Record<
  string,
  { baseURL: string; envVar: string; piName: string }
> = {
  'openrouter': {
    baseURL: 'https://openrouter.ai/api/v1',
    envVar: 'OPENROUTER_API_KEY',
    piName: 'openrouter',
  },
  'vercel-ai-gateway': {
    baseURL: 'https://ai-gateway.vercel.sh/v1',
    envVar: 'AI_GATEWAY_API_KEY',
    piName: 'vercel-ai-gateway',
  },
}

let cachedModelsJson: PiModelsJson | undefined

// "$VAR" / "${VAR}" — pi interpolates env refs inside larger literals too; eh
// only needs the var name to inject. ("!cmd" and literals yield nothing.)
function envVarRef(apiKey: string) {
  return /\$\{?([A-Za-z_]\w*)\}?/.exec(apiKey)?.at(1)
}

function loadPiModelsJson() {
  if (cachedModelsJson) return cachedModelsJson
  cachedModelsJson = { providers: {} }
  try {
    const parsed = piModelsJsonSchema.safeParse(
      JSON.parse(readFileSync(piModelsJsonPath(), 'utf8')),
    )
    if (parsed.success) cachedModelsJson = parsed.data
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
  const agentDir =
    process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), '.pi', 'agent')
  return path.join(agentDir, 'models.json')
}
