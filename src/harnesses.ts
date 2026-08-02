import type { ResolvedProvider } from './config.js'
import type { LaunchPlan, ModelEffortLevel, Protocol } from './types.js'

import { fetchModelMeta } from './pricing.js'
import {
  anthropicBaseURLFor,
  codexWireApiFor,
  openAIBaseURLFor,
  resolveKey,
} from './providers.js'
import { statuslineEnv, writeClaudeStatuslineSettings } from './statusline.js'
import { MODEL_EFFORT_LEVELS } from './types.js'

export interface HarnessDef {
  bin: string
  efforts: readonly ModelEffortLevel[]
  label: string
  plan: (
    provider: ResolvedProvider,
    model: string,
    options: { effort?: string; statusline?: boolean },
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
// display with provider/model/effort/rates + an exact gateway session total.
async function planClaude(
  provider: ResolvedProvider,
  model: string,
  options: { effort?: string; statusline?: boolean },
) {
  const { effort, statusline = true } = options
  const baseURL = anthropicBaseURLFor(provider)
  if (!baseURL) {
    throw new Error(
      `provider "${provider.name}" cannot serve the Anthropic protocol (needs the eh router, phase 2)`,
    )
  }
  // Meta fetch and key resolve are independent — run together so launch
  // doesn't pay two sequential round-trips.
  const [meta, authToken] = await Promise.all([
    statusline
      ? fetchModelMeta(provider, model)
      : Promise.resolve({
          contextWindow: undefined,
          rateLabel: undefined,
          rates: undefined,
        }),
    authTokenFor(provider),
  ])
  const env: Record<string, string> = {
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_AUTH_TOKEN: authToken,
    ANTHROPIC_BASE_URL: baseURL,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: model,
    ...(statusline
      ? statuslineEnv({
          contextWindow: meta.contextWindow,
          effort,
          model,
          provider: provider.name,
          rateLabel: meta.rateLabel,
          rates: meta.rates,
        })
      : {}),
  }
  const notes: string[] = statusline
    ? ['statusline: eh (provider rates, context window, session cost)']
    : []
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
    args: statusline ? ['--settings', writeClaudeStatuslineSettings()] : [],
    bin: 'claude',
    env,
    ...(statusline && isVercelGatewayURL(baseURL)
      ? {
          gatewayCostCapture: {
            resumed: false,
          },
        }
      : {}),
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
  options: { effort?: string },
) {
  const { effort } = options
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
    args.push('-c', `model_reasoning_effort=${tomlString(effort)}`)
  }
  return { args, bin: 'codex', env, notes }
}

// grok-cli is OpenAI-compatible: point GROK_BASE_URL at any /v1 endpoint.
async function planGrok(
  provider: ResolvedProvider,
  model: string,
  options: { effort?: string },
) {
  const { effort } = options
  const args = ['--model', model]
  if (effort && effort !== 'auto') {
    args.push('--reasoning-effort', effort)
  }
  return {
    args,
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
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    label: 'Claude Code',
    plan: planClaude,
    protocols: ['anthropic'],
    resumeArgs: (id) => (id ? ['--resume', id] : ['--resume']),
  },
  codex: {
    bin: 'codex',
    efforts: MODEL_EFFORT_LEVELS,
    label: 'Codex CLI',
    plan: planCodex,
    protocols: ['openai-chat', 'openai-responses'],
    // `resume` is a subcommand; clap still accepts the global `-c` overrides
    // that precede it.
    resumeArgs: (id) => (id ? ['resume', id] : ['resume']),
  },
  grok: {
    bin: 'grok',
    efforts: MODEL_EFFORT_LEVELS,
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
  options: {
    effort?: string
    resume?: boolean
    resumeSessionId?: string
    statusline?: boolean
  } = {},
) {
  const def = getHarness(harness)
  if (!def) throw new Error(`unknown harness "${harness}"`)
  const plan = await def.plan(provider, model, {
    effort: options.effort,
    statusline: options.statusline,
  })
  return {
    ...plan,
    args: options.resume
      ? [...plan.args, ...def.resumeArgs(options.resumeSessionId)]
      : plan.args,
    ...(plan.gatewayCostCapture
      ? {
          gatewayCostCapture: {
            ...plan.gatewayCostCapture,
            resumed: options.resume ?? false,
          },
        }
      : {}),
  }
}

export function getHarness(name: string) {
  return Object.hasOwn(HARNESSES, name) ? HARNESSES[name] : undefined
}

export function harnessNames() {
  return Object.keys(HARNESSES)
}

function isVercelGatewayURL(baseURL: string) {
  try {
    return new URL(baseURL).hostname === 'ai-gateway.vercel.sh'
  } catch {
    return false
  }
}
