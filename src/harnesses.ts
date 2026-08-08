import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { ResolvedProvider } from './config.js'
import type {
  ApprovalMode,
  LaunchPlan,
  Protocol,
  SearchBackend,
} from './types.js'

import { approvalArgsForHarness } from './approval-mode.js'
import { opencodeConfigContent, opencodeProviderId } from './opencode.js'
import { piModelsJsonHint, piProviderCompat, resolvePiProvider } from './pi.js'
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
  // false = the interactive picker skips effort; explicit options may still
  // be handled by the launch plan (grok) or ignored with a note (opencode).
  effort?: false
  label: string
  plan: (
    provider: ResolvedProvider,
    model: string,
    options: HarnessPlanOptions,
  ) => Promise<LaunchPlan>
  protocols: Protocol[]
  // Instance-level gate beyond protocol intersection (pi: the provider must
  // exist in pi's catalog or the user's models.json). A block always carries
  // its reason — it renders on the picker row and in launch-time errors.
  providerCompat?: (
    provider: ResolvedProvider,
  ) => { hint: string; ok: false } | { ok: true }
  // Appended to the plan's args for `eh -r`. With a session id, resumes that
  // exact session; without one (the --print-env path), falls back to the
  // harness's own picker / most recent.
  resumeArgs: (sessionId?: string) => string[]
}

interface HarnessPlanOptions {
  approvalMode?: ApprovalMode
  effort?: string
  gatewayProvider?: string
  gatewayZdr?: boolean
  statusline?: boolean
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
  options: HarnessPlanOptions,
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
      ? fetchModelMeta({
          gatewayProvider: options.gatewayProvider,
          modelId: model,
          provider,
        })
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
  const args = statusline ? ['--settings', writeClaudeStatuslineSettings()] : []
  args.push(...approvalArgsForHarness('claude', options.approvalMode))
  return {
    args,
    bin: 'claude',
    env,
    ...(statusline && isVercelGatewayURL(baseURL)
      ? {
          gatewayCostCapture: {
            resumed: false,
          },
        }
      : {}),
    gatewayRouting: gatewayRoutingFor(
      provider,
      options.gatewayProvider,
      baseURL,
      model,
      options.gatewayZdr,
    ),
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
  options: HarnessPlanOptions,
) {
  const { effort } = options
  const baseURL = openAIBaseURLFor(provider)
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
    `model_providers.eh.base_url=${tomlString(baseURL)}`,
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
  args.push(...approvalArgsForHarness('codex', options.approvalMode))
  return {
    args,
    bin: 'codex',
    env,
    gatewayRouting: gatewayRoutingFor(
      provider,
      options.gatewayProvider,
      baseURL,
      model,
      options.gatewayZdr,
    ),
    notes,
  }
}

// Grok Build discovers custom OpenAI-compatible models from their /v1 endpoint.
async function planGrok(
  provider: ResolvedProvider,
  model: string,
  options: HarnessPlanOptions,
) {
  const { effort } = options
  const baseURL = openAIBaseURLFor(provider)
  const args = ['--model', model]
  if (effort && effort !== 'auto') {
    args.push('--reasoning-effort', effort)
  }
  args.push(...approvalArgsForHarness('grok', options.approvalMode))
  return {
    args,
    bin: 'grok',
    env: {
      GROK_MODELS_BASE_URL: baseURL,
      XAI_API_KEY: await authTokenFor(provider),
    },
    gatewayRouting: gatewayRoutingFor(
      provider,
      options.gatewayProvider,
      baseURL,
      model,
      options.gatewayZdr,
    ),
    notes: [],
  }
}

function tomlString(value: string) {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

// pi speaks OpenAI chat / Anthropic Messages through its own provider catalog:
// the eh provider must exist there natively or in ~/.pi/agent/models.json
// (providerCompat gates the picker; this throw is the flag-driven path's
// version). Model ids pass through — pi warns and uses generic limits for
// models it doesn't know. For a Gateway provider pin or ZDR-only routing, eh
// points pi's native vercel-ai-gateway provider at the eh loopback proxy via a
// temporary `--extension` that overrides its baseUrl — no models.json mutation.
async function planPi(
  provider: ResolvedProvider,
  model: string,
  options: HarnessPlanOptions,
) {
  const { effort } = options
  // pi's SDK appends its own /v1 (Anthropic) or /chat/completions (OpenAI) to
  // the provider base URL, so the Gateway target drops /v1 — the proxy accepts
  // both prefixed and unprefixed inference paths.
  const baseURL = openAIBaseURLFor(provider).replace(/\/v1$/, '')
  const match = resolvePiProvider(provider)
  if (!match) {
    throw new Error(
      `pi can't serve provider "${provider.name}" — ${piModelsJsonHint()}`,
    )
  }
  const env: Record<string, string> = {}
  if (match.keyEnvVar && !process.env[match.keyEnvVar]) {
    // Same injection pattern as codex: the key lives in our store, pi reads
    // the var from its own environment. Never --api-key (argv exposure).
    env[match.keyEnvVar] = await authTokenFor(provider)
  }
  const args = ['--provider', match.piName, '--model', model]
  // pi's thinking levels are eh's effort levels (auto = send nothing).
  if (effort && effort !== 'auto') args.push('--thinking', effort)
  args.push(...approvalArgsForHarness('pi', options.approvalMode))
  const gatewayRouting = gatewayRoutingFor(
    provider,
    options.gatewayProvider,
    baseURL,
    model,
    options.gatewayZdr,
  )
  if (!gatewayRouting) return { args, bin: 'pi', env, notes: [] }

  // Route pi's native provider through eh's loopback proxy. The extension
  // reads the proxy URL from the child env (rewritten by the routing proxy at
  // launch); the temp file is removed once the run finishes.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'eh-pi-'))
  const extensionPath = path.join(dir, 'gateway-routing.js')
  await writeFile(
    extensionPath,
    `export default function (pi) {
  pi.registerProvider(${JSON.stringify(match.piName)}, { baseUrl: process.env.EH_PI_PROXY_URL })
}
`,
    { mode: 0o600 },
  )
  env.EH_PI_PROXY_URL = baseURL
  return {
    args: [...args, '--extension', extensionPath],
    bin: 'pi',
    cleanup: async () => rm(dir, { force: true, recursive: true }),
    env,
    gatewayRouting,
    notes: ['gateway routing via pi extension override'],
  }
}

// opencode speaks OpenAI chat to anything via @ai-sdk/openai-compatible. The
// provider definition rides as inline JSON in OPENCODE_CONFIG_CONTENT, which
// merges over the user's own config — nothing written to disk. Its baseURL
// lives in that JSON, so the gateway routing proxy's baseURL rewrite reaches
// it the same way it reaches grok's env var.
async function planOpencode(
  provider: ResolvedProvider,
  model: string,
  options: HarnessPlanOptions,
) {
  const { effort } = options
  const baseURL = openAIBaseURLFor(provider)
  const notes: string[] = []
  if (effort && effort !== 'auto') {
    notes.push('opencode has no CLI effort knob — ignoring')
  }
  const meta = await fetchModelMeta({ modelId: model, provider })
  const env: Record<string, string> = {
    OPENCODE_CONFIG_CONTENT: opencodeConfigContent(provider, model, meta.rates),
  }
  if (provider.envKey && !process.env[provider.envKey]) {
    // Same injection pattern as codex: the key lives in our store, opencode
    // reads the var from its own environment via the {env:VAR} indirection.
    env[provider.envKey] = await authTokenFor(provider)
  }
  const args = ['-m', `${opencodeProviderId(provider)}/${model}`]
  args.push(...approvalArgsForHarness('opencode', options.approvalMode))
  return {
    args,
    bin: 'opencode',
    env,
    gatewayRouting: gatewayRoutingFor(
      provider,
      options.gatewayProvider,
      baseURL,
      model,
      options.gatewayZdr,
    ),
    notes,
  }
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
    label: 'Grok Build',
    plan: planGrok,
    protocols: ['openai-chat'],
    resumeArgs: (id) => (id ? ['--resume', id] : ['--resume']),
  },
  opencode: {
    bin: 'opencode',
    effort: false,
    label: 'opencode',
    plan: planOpencode,
    protocols: ['openai-chat'],
    resumeArgs: (id) => (id ? ['--session', id] : ['--continue']),
  },
  pi: {
    bin: 'pi',
    label: 'pi',
    plan: planPi,
    protocols: ['openai-chat'],
    providerCompat: piProviderCompat,
    resumeArgs: (id) => (id ? ['--session', id] : ['--continue']),
  },
}

// Single lookup chokepoint — this keeps the `| undefined` honest.
export async function buildLaunchPlan(
  harness: string,
  provider: ResolvedProvider,
  model: string,
  options: {
    approvalMode?: ApprovalMode
    effort?: string
    gatewayProvider?: string
    gatewayZdr?: boolean
    resume?: boolean
    resumeSessionId?: string
    searchBackend?: SearchBackend
    statusline?: boolean
  } = {},
) {
  const def = getHarness(harness)
  if (!def) throw new Error(`unknown harness "${harness}"`)
  const planned = await def.plan(provider, model, {
    approvalMode: options.approvalMode,
    effort: options.effort,
    gatewayProvider: options.gatewayProvider,
    gatewayZdr: options.gatewayZdr,
    statusline: options.statusline,
  })
  const plan = {
    ...planned,
    args: options.resume
      ? [...planned.args, ...def.resumeArgs(options.resumeSessionId)]
      : planned.args,
    ...(planned.gatewayRouting
      ? {
          notes: [
            ...planned.notes,
            planned.gatewayRouting.provider
              ? `gateway provider pinned: ${planned.gatewayRouting.provider}`
              : 'gateway routing: ZDR only',
          ],
        }
      : {}),
    ...(planned.gatewayCostCapture
      ? {
          gatewayCostCapture: {
            ...planned.gatewayCostCapture,
            resumed: options.resume ?? false,
          },
        }
      : {}),
  }
  if (!options.searchBackend) return plan
  const upstreamBaseURL = plan.env.ANTHROPIC_BASE_URL
  if (!upstreamBaseURL) {
    throw new Error(
      `search provider "${options.searchBackend.type}" is only supported by Claude Code`,
    )
  }
  return {
    ...plan,
    searchProxy: { ...options.searchBackend, upstreamBaseURL },
  }
}

export function getHarness(name: string) {
  return Object.hasOwn(HARNESSES, name) ? HARNESSES[name] : undefined
}

export function harnessNames() {
  return Object.keys(HARNESSES)
}

function gatewayRoutingFor(
  provider: ResolvedProvider,
  gatewayProvider: string | undefined,
  targetBaseURL: string,
  model: string,
  gatewayZdr: boolean | undefined,
) {
  if (gatewayProvider === undefined && gatewayZdr !== true) return undefined
  if (provider.type !== 'vercel-gateway') {
    throw new Error(
      gatewayProvider === undefined
        ? 'ZDR-only routing requires a Vercel AI Gateway provider'
        : '--gateway-provider requires a Vercel AI Gateway provider',
    )
  }
  if (
    gatewayProvider !== undefined &&
    !/^[A-Za-z0-9._-]+$/.test(gatewayProvider)
  ) {
    throw new Error(
      `invalid gateway provider "${gatewayProvider}" (use its Vercel provider slug)`,
    )
  }
  // A pin wins over ZDR-only routing: pinning a provider replaces the
  // ZDR restriction, it doesn't combine with it.
  return {
    apiKeyEnvKey: provider.envKey,
    model,
    provider: gatewayProvider,
    targetBaseURL,
    zdr: gatewayProvider === undefined && gatewayZdr === true,
  }
}

function isVercelGatewayURL(baseURL: string) {
  try {
    return new URL(baseURL).hostname === 'ai-gateway.vercel.sh'
  } catch {
    return false
  }
}
