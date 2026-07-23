import type { ResolvedProvider } from './config.js'
import type { LaunchPlan, Protocol } from './types.js'

import { fetchModelMeta } from './pricing.js'
import {
  anthropicBaseURLFor,
  codexWireApiFor,
  openAIBaseURLFor,
  resolveKey,
} from './providers.js'
import { statuslineEnv, writeClaudeStatuslineSettings } from './statusline.js'

export interface HarnessDef {
  bin: string
  label: string
  plan: (
    provider: ResolvedProvider,
    model: string,
    effort?: string,
  ) => Promise<LaunchPlan>
  protocols: Protocol[]
  // Appended to the plan's args for `eh -r`. With a session id, resumes that
  // exact session; without one (the --print-env path), falls back to the
  // harness's own picker / most recent.
  resumeArgs: (sessionId?: string) => string[]
}

// Ollama ignores the token value but requires one to be present.
async function authTokenFor(provider: ResolvedProvider) {
  const key = await resolveKey(provider)
  if (key.source !== 'none') return key.value
  if (provider.type === 'ollama') return 'ollama'
  throw new Error(
    `no API key for "${provider.name}" — set ${provider.envKey ?? 'the key env var'} or run \`eh provider key ${provider.name}\``,
  )
}

// Claude Code speaks Anthropic Messages; everything it needs is env vars.
// Session statusline: override Claude's (wrong for third-party models) cost
// display with provider/model/effort/list rates + recomputed session $.
async function planClaude(
  provider: ResolvedProvider,
  model: string,
  effort?: string,
) {
  const baseURL = anthropicBaseURLFor(provider)
  if (!baseURL) {
    throw new Error(
      `provider "${provider.name}" cannot serve the Anthropic protocol (needs the eh router, phase 2)`,
    )
  }
  // Meta fetch and key resolve are independent — run together so launch
  // doesn't pay two sequential round-trips.
  const [meta, authToken] = await Promise.all([
    fetchModelMeta(provider, model),
    authTokenFor(provider),
  ])
  const settingsPath = writeClaudeStatuslineSettings()
  const env: Record<string, string> = {
    ANTHROPIC_AUTH_TOKEN: authToken,
    ANTHROPIC_BASE_URL: baseURL,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: model,
    ...statuslineEnv({
      contextWindow: meta.contextWindow,
      effort,
      model,
      provider: provider.name,
      rates: meta.rates,
    }),
  }
  const notes: string[] = [
    'statusline: eh (provider rates, context window, session cost)',
  ]
  if (effort && effort !== 'auto') {
    env.CLAUDE_CODE_EFFORT_LEVEL = effort
    // Through a non-Anthropic provider the model ID is not effort-recognized,
    // so force the parameter through (DESIGN.md "Launch plans").
    env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = '1'
    notes.push('effort forced on for non-Anthropic provider')
  }
  if (!meta.rates) notes.push('list rates unavailable for this model')
  if (meta.contextWindow == null) {
    notes.push('context window unknown — falling back to Claude context size')
  }
  return {
    args: ['--settings', settingsPath],
    bin: 'claude',
    env,
    notes,
  }
}

// Codex takes a full custom-provider definition via -c TOML overrides, so we
// never touch ~/.codex/config.toml. Codex resolves env_key from its own
// environment, so when the key lives in our store (not the shell env) we
// inject it there for the child process.
async function planCodex(
  provider: ResolvedProvider,
  model: string,
  effort?: string,
) {
  const env: Record<string, string> = {}
  if (provider.envKey && !process.env[provider.envKey]) {
    // Throws an actionable error when no key resolves anywhere — codex would
    // otherwise launch and fail with a raw upstream 401.
    env[provider.envKey] = await authTokenFor(provider)
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
  const notes: string[] = []
  if (effort && effort !== 'auto') {
    // codex caps at high — map xhigh/max down.
    const level = effort === 'xhigh' || effort === 'max' ? 'high' : effort
    args.push('-c', `model_reasoning_effort=${tomlString(level)}`)
    if (level !== effort) notes.push(`effort ${effort} → codex max is high`)
  }
  return { args, bin: 'codex', env, notes }
}

// grok-cli is OpenAI-compatible: point GROK_BASE_URL at any /v1 endpoint.
async function planGrok(
  provider: ResolvedProvider,
  model: string,
  effort?: string,
) {
  const notes: string[] = []
  if (effort && effort !== 'auto') {
    notes.push('grok-cli has no effort knob — ignoring')
  }
  return {
    args: ['--model', model],
    bin: 'grok',
    env: {
      GROK_API_KEY: await authTokenFor(provider),
      GROK_BASE_URL: openAIBaseURLFor(provider),
    },
    notes,
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
    resumeArgs: (id) => (id ? ['--resume', id] : ['--resume']),
  },
  codex: {
    bin: 'codex',
    label: 'Codex CLI',
    plan: planCodex,
    protocols: ['openai-chat', 'openai-responses'],
    // `resume` is a subcommand; clap still accepts the global `-c` overrides
    // that precede it.
    resumeArgs: (id) => (id ? ['resume', id] : ['resume']),
  },
  grok: {
    bin: 'grok',
    label: 'Grok CLI',
    plan: planGrok,
    protocols: ['openai-chat'],
    resumeArgs: (id) => (id ? ['--resume', id] : ['--resume']),
  },
}

// Single lookup chokepoint — this keeps the `| undefined` honest.
export async function buildLaunchPlan(
  harness: string,
  provider: ResolvedProvider,
  model: string,
  options: { effort?: string; resume?: boolean; resumeSessionId?: string } = {},
) {
  const def = getHarness(harness)
  if (!def) throw new Error(`unknown harness "${harness}"`)
  const plan = await def.plan(provider, model, options.effort)
  if (options.resume) plan.args.push(...def.resumeArgs(options.resumeSessionId))
  return plan
}

export function getHarness(name: string) {
  return Object.hasOwn(HARNESSES, name) ? HARNESSES[name] : undefined
}

export function harnessNames() {
  return Object.keys(HARNESSES)
}
