import { spawn } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { z } from 'zod'

import type { EffortLevel, LaunchPlan } from './types.js'

import { withCleanup } from './cleanup.js'
import { getProvider, loadConfig } from './config.js'
import { withGatewayRouting } from './gateway-routing.js'
import {
  assertEffortAllowed,
  buildLaunchPlan,
  getHarness,
  resolveAvailableEfforts,
} from './harnesses.js'
import { EFFORT_LEVELS } from './types.js'

const PROTOCOL_VERSION = 1
// Reserved eh exit codes for eh-detected failure categories — a contiguous
// block at >=64 (sysexits.h's EX_ range). Raw child codes pass through
// unchanged when eh has no category, so a harness's own code may only collide
// with this block in the passthrough case. Documented in README's "Exit codes".
const EH_EXIT_PREFLIGHT = 64
const EH_EXIT_SPAWN = 65
const EH_EXIT_HARNESS_ERROR = 66
const TIMEOUT_KILL_GRACE_MS = 10_000
const PROMPT_STDIN_HELP =
  "eh run expects a prompt on stdin; pipe one in, for example: printf 'fix the parser' | eh run codex ollama qwen3-coder"
const recordSchema = z.record(z.string(), z.unknown())

export interface HeadlessRunOptions {
  cwd?: string
  effort: string
  gatewayProvider?: string
  harness: string
  model: string
  nativeArgsJson?: string
  provider: string
  readOnly?: boolean
  resumeSessionId?: string
  timeout?: string
}

interface NormalizerState {
  pendingGrokText: string
  resultIsError: boolean
  sessionId: string | undefined
}

interface ResolvedHeadlessRunOptions {
  cwd: string | undefined
  effort: EffortLevel
  gatewayProvider: string | undefined
  harness: string
  model: string
  nativeArgs: string[]
  provider: string
  readOnly: boolean
  resumeSessionId: string | undefined
  timeoutSeconds: number | undefined
}

export async function runHeadless(options: HeadlessRunOptions) {
  // Set after spawn so pre-spawn setup (including withGatewayRouting
  // validation) still maps to 64. After spawn, rethrow so teardown cannot
  // emit a second run.completed.
  const state = { executionStarted: false }
  try {
    const prompt = readPrompt()
    const effort = EFFORT_LEVELS.find((level) => level === options.effort)
    if (effort === undefined) {
      throw new Error(
        `unknown effort "${options.effort}" (known: ${EFFORT_LEVELS.join(', ')})`,
      )
    }
    const resolved: ResolvedHeadlessRunOptions = {
      cwd: options.cwd,
      effort,
      gatewayProvider: options.gatewayProvider,
      harness: options.harness,
      model: options.model,
      nativeArgs:
        options.nativeArgsJson === undefined
          ? []
          : parseNativeArgsJson(options.nativeArgsJson),
      provider: options.provider,
      readOnly: options.readOnly ?? false,
      resumeSessionId: options.resumeSessionId,
      timeoutSeconds: parseTimeoutSeconds(options.timeout),
    }
    if (resolved.cwd !== undefined) assertRunnableCwd(resolved.cwd)
    const config = loadConfig()
    const provider = getProvider(config, resolved.provider)
    if (!provider) throw new Error(`unknown provider "${resolved.provider}"`)
    const def = getHarness(resolved.harness)
    if (!def) throw new Error(`unknown harness "${resolved.harness}"`)
    if (resolved.effort !== 'auto' && def.effort !== false) {
      assertEffortAllowed(
        resolved.effort,
        await resolveAvailableEfforts(def, provider, resolved.model),
      )
    }
    const plan = await buildLaunchPlan(
      resolved.harness,
      provider,
      resolved.model,
      {
        approvalMode: config.defaultApprovalMode,
        effort: resolved.effort,
        gatewayProvider: resolved.gatewayProvider,
        readOnly: resolved.readOnly,
        statusline: false,
      },
    )
    return await withCleanup(plan.cleanup, async () => {
      const prepared = await prepareHeadlessPlan({
        options: resolved,
        plan,
        prompt,
      })
      return withCleanup(prepared.cleanup, async () => {
        emit({
          effort: resolved.effort,
          ...(resolved.gatewayProvider === undefined
            ? {}
            : { gatewayProvider: resolved.gatewayProvider }),
          harness: resolved.harness,
          model: resolved.model,
          provider: provider.name,
          type: 'run.started',
        })

        return executeHeadlessPlan({
          cwd: resolved.cwd,
          harness: resolved.harness,
          markSpawned: () => {
            state.executionStarted = true
          },
          plan: prepared.plan,
          stdin: prepared.stdin,
          timeoutSeconds: resolved.timeoutSeconds,
        })
      })
    })
  } catch (error) {
    if (state.executionStarted) throw error
    emit({ message: errorMessage(error), type: 'run.error' })
    emit({
      exitCode: EH_EXIT_PREFLIGHT,
      resultIsError: true,
      type: 'run.completed',
    })
    return EH_EXIT_PREFLIGHT
  }
}

function asRecord(value: unknown) {
  const parsed = recordSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

function assertRunnableCwd(cwd: string) {
  let stats
  try {
    stats = statSync(cwd)
  } catch {
    throw new Error(`--cwd "${cwd}" does not exist`)
  }
  if (!stats.isDirectory()) {
    throw new Error(`--cwd "${cwd}" is not a directory`)
  }
}

function emit(event: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify({ ...event, v: PROTOCOL_VERSION })}\n`)
}

function emitGrokUsage(event: Record<string, unknown>, cumulative: boolean) {
  const usage = asRecord(event.usage)
  if (!usage) return
  emitUsage({
    cacheReadTokens: numberField(usage, 'cache_read_input_tokens'),
    cacheWriteTokens: numberField(usage, 'cache_creation_input_tokens'),
    costUsd:
      optionalNumberField(event, 'total_cost_usd') ??
      optionalNumberField(event, 'cost_usd'),
    cumulative,
    inputTokens: numberField(usage, 'input_tokens'),
    outputTokens: numberField(usage, 'output_tokens'),
  })
}

function emitNewSession(value: unknown, state: NormalizerState) {
  if (typeof value !== 'string' || value === state.sessionId) return state
  return { ...state, sessionId: emitSession(value, state.sessionId) }
}

function emitRunError(event: Record<string, unknown>, fallback: string) {
  const nested = asRecord(event.error)
  const data = nested ? asRecord(nested.data) : undefined
  const message =
    (typeof event.message === 'string' && event.message) ||
    (typeof event.errorMessage === 'string' && event.errorMessage) ||
    (typeof nested?.message === 'string' && nested.message) ||
    (typeof data?.message === 'string' && data.message) ||
    (typeof event.result === 'string' && event.result) ||
    fallback
  emit({ message, type: 'run.error' })
}

function emitSession(value: unknown, current: string | undefined) {
  if (typeof value === 'string' && value !== current) {
    emit({ sessionId: value, type: 'session.started' })
    return value
  }
  return current
}

function emitUsage(usage: {
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number | undefined
  cumulative: boolean
  inputTokens: number
  outputTokens: number
}) {
  emit({
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
    cumulative: usage.cumulative,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    type: 'usage',
  })
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

async function executeHeadlessPlan(options: {
  cwd?: string
  harness: string
  markSpawned: () => void
  plan: LaunchPlan
  stdin?: string
  timeoutSeconds?: number
}) {
  return withGatewayRouting(options.plan, async (plan) =>
    executePreparedHeadlessPlan({ ...options, plan }),
  )
}

async function executePreparedHeadlessPlan(options: {
  cwd?: string
  harness: string
  markSpawned: () => void
  plan: LaunchPlan
  stdin?: string
  timeoutSeconds?: number
}) {
  const child = spawn(options.plan.bin, options.plan.args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.plan.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  options.markSpawned()
  const lines = createInterface({ input: child.stdout })
  const completion = new Promise<
    | { code: null | number; signal: keyof typeof os.constants.signals | null }
    | { error: Error }
  >((resolve) => {
    child.on('error', (error) => {
      lines.close()
      resolve({ error })
    })
    child.on('close', (code, signal) => resolve({ code, signal }))
  })
  const signalHandlers = (['SIGINT', 'SIGTERM'] as const).map((signal) => {
    const handler = () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal)
      }
    }
    process.on(signal, handler)
    return { handler, signal }
  })

  // Held in an object so the deferred callback's mutation is visible to the
  // read below — a plain `let` boolean would be narrowed to its initial value.
  const timeout = { fired: false }
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined
  let killTimer: ReturnType<typeof setTimeout> | undefined

  try {
    child.stderr.pipe(process.stderr)
    child.stdin.on('error', () => undefined)
    child.stdin.end(options.stdin)

    if (options.timeoutSeconds !== undefined) {
      timeoutTimer = setTimeout(() => {
        // Only act while the child is still running; if it already finished, the
        // timer is a no-op and the normal completion path reports the real exit.
        if (child.exitCode === null && child.signalCode === null) {
          timeout.fired = true
          emit({
            message: `${options.harness} exceeded the --timeout limit of ${options.timeoutSeconds}s`,
            type: 'run.error',
          })
          child.kill('SIGTERM')
          killTimer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill('SIGKILL')
            }
          }, timeoutKillGraceMs())
        }
      }, options.timeoutSeconds * 1000)
    }

    let state: NormalizerState = {
      pendingGrokText: '',
      resultIsError: false,
      sessionId: undefined,
    }
    for await (const line of lines) {
      state = normalizeHarnessLine({
        harness: options.harness,
        line,
        state,
      })
    }
    if (options.harness === 'grok') state = flushGrokText(state)

    const completed = await completion
    if ('error' in completed) {
      emit({
        message:
          completed.error.message || `Failed to spawn "${options.plan.bin}"`,
        type: 'run.error',
      })
      emit({
        exitCode: EH_EXIT_SPAWN,
        resultIsError: true,
        type: 'run.completed',
      })
      return EH_EXIT_SPAWN
    }
    const signalNumber = completed.signal
      ? os.constants.signals[completed.signal]
      : undefined
    const childExitCode =
      completed.code ?? (signalNumber ? 128 + signalNumber : 1)
    if (!state.resultIsError && childExitCode !== 0 && !timeout.fired) {
      emit({
        message: completed.signal
          ? `${options.harness} exited with signal ${completed.signal}`
          : `${options.harness} exited with code ${childExitCode}`,
        type: 'run.error',
      })
    }
    const resultIsError =
      state.resultIsError || childExitCode !== 0 || timeout.fired
    const exitCode =
      resultIsError && childExitCode === 0
        ? EH_EXIT_HARNESS_ERROR
        : childExitCode
    emit({ exitCode, resultIsError, type: 'run.completed' })
    return exitCode
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer)
    if (killTimer) clearTimeout(killTimer)
    for (const { handler, signal } of signalHandlers) {
      process.off(signal, handler)
    }
  }
}

function flushGrokText(state: NormalizerState) {
  if (!state.pendingGrokText) return state
  emit({ text: state.pendingGrokText, type: 'assistant.text' })
  return { ...state, pendingGrokText: '' }
}

function isGrokTextDelta(
  event: Record<string, unknown>,
): event is Record<string, unknown> & { data: string } {
  return event.type === 'text' && typeof event.data === 'string'
}

function normalizeClaudeEvent(
  event: Record<string, unknown>,
  state: NormalizerState,
) {
  let sessionId = state.sessionId
  if (event.type === 'system') {
    sessionId = emitSession(event.session_id, sessionId)
  }

  if (event.type === 'assistant') {
    const message = asRecord(event.message)
    if (message && Array.isArray(message.content)) {
      for (const rawBlock of message.content) {
        const block = asRecord(rawBlock)
        if (block?.type === 'text' && typeof block.text === 'string') {
          emit({ text: block.text, type: 'assistant.text' })
        }
      }
    }
  }

  if (event.type !== 'result') return { ...state, sessionId }
  sessionId = emitSession(event.session_id, sessionId)
  const usage = asRecord(event.usage)
  if (usage) {
    emitUsage({
      cacheReadTokens: numberField(usage, 'cache_read_input_tokens'),
      cacheWriteTokens: numberField(usage, 'cache_creation_input_tokens'),
      costUsd: optionalNumberField(event, 'total_cost_usd'),
      cumulative: false,
      inputTokens: numberField(usage, 'input_tokens'),
      outputTokens: numberField(usage, 'output_tokens'),
    })
  }
  const resultIsError =
    event.is_error === true ||
    (typeof event.subtype === 'string' && event.subtype !== 'success')
  if (resultIsError) emitRunError(event, 'Claude reported a failed result')
  return {
    ...state,
    resultIsError: state.resultIsError || resultIsError,
    sessionId,
  }
}

function normalizeCodexEvent(
  event: Record<string, unknown>,
  state: NormalizerState,
) {
  const sessionId =
    event.type === 'thread.started'
      ? emitSession(event.thread_id, state.sessionId)
      : state.sessionId

  if (event.type === 'item.completed') {
    const item = asRecord(event.item)
    if (item?.type === 'agent_message' && typeof item.text === 'string') {
      emit({ text: item.text, type: 'assistant.text' })
    }
  }

  if (event.type === 'turn.completed') {
    const usage = asRecord(event.usage)
    if (usage) {
      emitUsage({
        cacheReadTokens: numberField(usage, 'cached_input_tokens'),
        cacheWriteTokens: 0,
        costUsd:
          optionalNumberField(event, 'total_cost_usd') ??
          optionalNumberField(event, 'cost_usd'),
        cumulative: true,
        inputTokens: numberField(usage, 'input_tokens'),
        outputTokens: numberField(usage, 'output_tokens'),
      })
    }
  }

  if (event.type === 'turn.failed' || event.type === 'error') {
    emitRunError(event, 'Codex reported a failed turn')
    return { ...state, resultIsError: true, sessionId }
  }

  return { ...state, sessionId }
}

function normalizeGrokEvent(
  event: Record<string, unknown>,
  state: NormalizerState,
) {
  if (isGrokTextDelta(event)) {
    return { ...state, pendingGrokText: state.pendingGrokText + event.data }
  }
  let nextState = state
  if (event.type === 'usage') emitGrokUsage(event, false)
  if (event.type === 'end') {
    nextState = {
      ...nextState,
      sessionId: emitSession(event.sessionId, nextState.sessionId),
    }
    emitGrokUsage(event, true)
  }
  if (event.type === 'error') {
    emitRunError(event, 'Grok reported an error')
    return { ...nextState, resultIsError: true }
  }
  return nextState
}

function normalizeHarnessLine(options: {
  harness: string
  line: string
  state: NormalizerState
}) {
  let decoded: unknown
  try {
    decoded = JSON.parse(options.line)
  } catch {
    const state =
      options.harness === 'grok' ? flushGrokText(options.state) : options.state
    emit({ text: options.line, type: 'harness.output' })
    return state
  }

  const parsed = recordSchema.safeParse(decoded)
  if (!parsed.success) {
    const state =
      options.harness === 'grok' ? flushGrokText(options.state) : options.state
    emit({ text: options.line, type: 'harness.output' })
    return state
  }

  const event = parsed.data
  const state =
    options.harness === 'grok' && !isGrokTextDelta(event)
      ? flushGrokText(options.state)
      : options.state
  emit({ event, harness: options.harness, type: 'harness.event' })

  switch (options.harness) {
    case 'claude':
      return normalizeClaudeEvent(event, state)
    case 'codex':
      return normalizeCodexEvent(event, state)
    case 'grok':
      return normalizeGrokEvent(event, state)
    case 'opencode':
      return normalizeOpencodeEvent(event, state)
    case 'pi':
      return normalizePiEvent(event, state)
    default:
      return state
  }
}

function normalizeOpencodeEvent(
  event: Record<string, unknown>,
  state: NormalizerState,
) {
  const nextState = emitNewSession(event.sessionID, state)
  const part = asRecord(event.part)

  if (
    event.type === 'text' &&
    part?.type === 'text' &&
    typeof part.text === 'string'
  ) {
    emit({ text: part.text, type: 'assistant.text' })
  }

  if (event.type === 'step_finish' && part?.type === 'step-finish') {
    const tokens = asRecord(part.tokens)
    const cache = tokens ? asRecord(tokens.cache) : undefined
    if (tokens) {
      emitUsage({
        cacheReadTokens: cache ? numberField(cache, 'read') : 0,
        cacheWriteTokens: cache ? numberField(cache, 'write') : 0,
        costUsd: optionalNumberField(part, 'cost'),
        cumulative: false,
        inputTokens: numberField(tokens, 'input'),
        outputTokens: numberField(tokens, 'output'),
      })
    }
  }

  if (event.type === 'error') {
    emitRunError(event, 'OpenCode reported an error')
    return { ...nextState, resultIsError: true }
  }
  return nextState
}

function normalizePiEvent(
  event: Record<string, unknown>,
  state: NormalizerState,
) {
  const nextState = emitNewSession(event.id, state)
  if (event.type !== 'message_end') return nextState

  const message = asRecord(event.message)
  if (message?.role !== 'assistant') return nextState
  if (Array.isArray(message.content)) {
    for (const rawBlock of message.content) {
      const block = asRecord(rawBlock)
      if (block?.type === 'text' && typeof block.text === 'string') {
        emit({ text: block.text, type: 'assistant.text' })
      }
    }
  }

  const usage = asRecord(message.usage)
  if (usage) {
    const cost = asRecord(usage.cost)
    emitUsage({
      cacheReadTokens: numberField(usage, 'cacheRead'),
      cacheWriteTokens: numberField(usage, 'cacheWrite'),
      costUsd: cost ? optionalNumberField(cost, 'total') : undefined,
      cumulative: false,
      inputTokens: numberField(usage, 'input'),
      outputTokens: numberField(usage, 'output'),
    })
  }

  const resultIsError =
    message.stopReason === 'error' || message.stopReason === 'aborted'
  if (resultIsError) emitRunError(message, 'Pi reported a failed result')
  return {
    ...nextState,
    resultIsError: nextState.resultIsError || resultIsError,
  }
}

function numberField(value: Record<string, unknown>, key: string) {
  return optionalNumberField(value, key) ?? 0
}

function optionalNumberField(value: Record<string, unknown>, key: string) {
  const raw = Reflect.get(value, key)
  const numeric = typeof raw === 'number' ? raw : Number.NaN
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : undefined
}

function parseNativeArgsJson(value: string) {
  let decoded: unknown
  try {
    decoded = JSON.parse(value)
  } catch {
    throw new Error('--native-args-json must be a JSON array of strings')
  }

  const parsed = z.array(z.string()).safeParse(decoded)
  if (!parsed.success) {
    throw new Error('--native-args-json must be a JSON array of strings')
  }
  return parsed.data
}

function parseTimeoutSeconds(value: string | undefined) {
  if (value === undefined) return undefined
  const seconds = Number(value)
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new Error(
      `--timeout must be a positive integer number of seconds (got "${value}")`,
    )
  }
  return seconds
}

async function prepareHeadlessPlan(options: {
  options: ResolvedHeadlessRunOptions
  plan: LaunchPlan
  prompt: string
}) {
  const { effort, harness, model, nativeArgs, resumeSessionId } =
    options.options
  const effortArgs = effort === 'auto' ? [] : ['--effort', effort]

  if (harness === 'claude') {
    return {
      cleanup: async () => Promise.resolve(),
      plan: {
        ...options.plan,
        args: [
          ...options.plan.args,
          ...nativeArgs,
          '-p',
          '--model',
          model,
          ...effortArgs,
          '--output-format',
          'stream-json',
          '--verbose',
          ...(resumeSessionId ? ['--resume', resumeSessionId] : []),
        ],
      },
      stdin: options.prompt,
    }
  }

  if (harness === 'codex') {
    const command = resumeSessionId
      ? ['exec', ...nativeArgs, 'resume', resumeSessionId, '-']
      : ['exec', ...nativeArgs, '-']
    return {
      cleanup: async () => Promise.resolve(),
      plan: {
        ...options.plan,
        args: [...options.plan.args, ...command, '--json'],
      },
      stdin: options.prompt,
    }
  }

  if (harness === 'grok') {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'eh-run-'))
    const promptPath = path.join(dir, 'prompt.txt')
    await writeFile(promptPath, options.prompt, { mode: 0o600 })
    return {
      cleanup: async () => rm(dir, { force: true, recursive: true }),
      plan: {
        ...options.plan,
        args: [
          ...options.plan.args,
          ...nativeArgs,
          '--prompt-file',
          promptPath,
          '--output-format',
          'streaming-json',
          '--no-auto-update',
          ...(resumeSessionId ? ['--resume', resumeSessionId] : []),
        ],
      },
    }
  }

  if (harness === 'pi') {
    return {
      cleanup: async () => Promise.resolve(),
      plan: {
        ...options.plan,
        args: [
          ...options.plan.args,
          ...nativeArgs,
          '--mode',
          'json',
          ...(resumeSessionId ? ['--session', resumeSessionId] : []),
        ],
      },
      stdin: options.prompt,
    }
  }

  if (harness === 'opencode') {
    return {
      cleanup: async () => Promise.resolve(),
      plan: {
        ...options.plan,
        args: [
          'run',
          ...options.plan.args,
          ...nativeArgs,
          '--format',
          'json',
          ...(resumeSessionId ? ['--session', resumeSessionId] : []),
        ],
      },
      stdin: options.prompt,
    }
  }

  throw new Error(`unknown harness "${harness}"`)
}

function readPrompt() {
  if (process.stdin.isTTY) throw new Error(PROMPT_STDIN_HELP)
  const prompt = readFileSync(0, 'utf8')
  if (!prompt.trim()) throw new Error(PROMPT_STDIN_HELP)
  return prompt
}

// The grace period between SIGTERM and SIGKILL. Overridable via the env var so
// the escalation test doesn't have to sleep the full 10 real seconds.
function timeoutKillGraceMs() {
  const raw = process.env.EH_TIMEOUT_KILL_GRACE_MS
  if (raw === undefined) return TIMEOUT_KILL_GRACE_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : TIMEOUT_KILL_GRACE_MS
}
