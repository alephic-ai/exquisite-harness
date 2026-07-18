import type { ResolvedProvider } from './config.js'
import type { LaunchPlan, Protocol } from './types.js'

import {
  anthropicBaseURLFor,
  codexWireApiFor,
  openAIBaseURLFor,
  resolveKey,
} from './providers.js'

export { findBin } from './which.js'

export interface HarnessDef {
  bin: string
  label: string
  plan: (provider: ResolvedProvider, model: string) => Promise<LaunchPlan>
  protocols: Protocol[]
}

// Ollama ignores the token value but requires one to be present.
async function authTokenFor(provider: ResolvedProvider) {
  const { value } = await resolveKey(provider)
  if (value) return value
  if (provider.type === 'ollama') return 'ollama'
  throw new Error(
    `no API key for "${provider.name}" — set ${provider.envKey ?? 'the key env var'} or run \`eh provider key ${provider.name}\``,
  )
}

// Claude Code speaks Anthropic Messages; everything it needs is env vars.
async function planClaude(provider: ResolvedProvider, model: string) {
  const baseURL = anthropicBaseURLFor(provider)
  if (!baseURL) {
    throw new Error(
      `provider "${provider.name}" cannot serve the Anthropic protocol (needs the eh router, phase 2)`,
    )
  }
  return {
    args: [],
    bin: 'claude',
    env: {
      ANTHROPIC_AUTH_TOKEN: await authTokenFor(provider),
      ANTHROPIC_BASE_URL: baseURL,
      ANTHROPIC_MODEL: model,
      ANTHROPIC_SMALL_FAST_MODEL: model,
    },
    notes: [],
  }
}

// Codex takes a full custom-provider definition via -c TOML overrides, so we
// never touch ~/.codex/config.toml. Codex resolves env_key from its own
// environment, so when the key lives in our store (not the shell env) we
// inject it there for the child process.
async function planCodex(provider: ResolvedProvider, model: string) {
  const env: Record<string, string> = {}
  if (provider.envKey && !process.env[provider.envKey]) {
    const { value } = await resolveKey(provider)
    if (value) env[provider.envKey] = value
  }
  const args = [
    '-c',
    `model=${tomlString(model)}`,
    '-c',
    'model_provider="eh"',
    '-c',
    `model_providers.eh.name=${tomlString(`eh · ${provider.name}`)}`,
    '-c',
    `model_providers.eh.base_url=${tomlString(openAIBaseURLFor(provider))}`,
    '-c',
    `model_providers.eh.wire_api=${tomlString(codexWireApiFor(provider))}`,
  ]
  if (provider.envKey) {
    args.push('-c', `model_providers.eh.env_key=${tomlString(provider.envKey)}`)
  }
  return { args, bin: 'codex', env, notes: [] }
}

// grok-cli is OpenAI-compatible: point GROK_BASE_URL at any /v1 endpoint.
async function planGrok(provider: ResolvedProvider, model: string) {
  return {
    args: ['--model', model],
    bin: 'grok',
    env: {
      GROK_API_KEY: await authTokenFor(provider),
      GROK_BASE_URL: openAIBaseURLFor(provider),
    },
    notes: [],
  }
}

function tomlString(value: string) {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

// Exported for iteration (picker options). For lookups use getHarness —
// Record index access would claim every key exists.
export const HARNESSES: Record<string, HarnessDef> = {
  claude: {
    bin: 'claude',
    label: 'Claude Code',
    plan: planClaude,
    protocols: ['anthropic'],
  },
  codex: {
    bin: 'codex',
    label: 'Codex CLI',
    plan: planCodex,
    protocols: ['openai-chat', 'openai-responses'],
  },
  grok: {
    bin: 'grok',
    label: 'Grok CLI',
    plan: planGrok,
    protocols: ['openai-chat'],
  },
}

// Single lookup chokepoint — this keeps the `| undefined` honest.
export async function buildLaunchPlan(
  harness: string,
  provider: ResolvedProvider,
  model: string,
) {
  const def = getHarness(harness)
  if (!def) throw new Error(`unknown harness "${harness}"`)
  return def.plan(provider, model)
}

export function getHarness(name: string) {
  return Object.hasOwn(HARNESSES, name) ? HARNESSES[name] : undefined
}

export function harnessNames() {
  return Object.keys(HARNESSES)
}
