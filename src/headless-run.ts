import { spawn } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { z } from 'zod'

import type { HeadlessRateCard, NormalizedUsage } from './pricing.js'
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
import { fetchHeadlessRateCard, headlessCost } from './pricing.js'
import { EFFORT_LEVELS } from './types.js'

const PROTOCOL_VERSION = 2
// Reserved eh exit codes for eh-detected failure categories — a contiguous
// block at >=64 (sysexits.h's EX_ range). Raw child codes pass through
// unchanged when eh has no category, so a harness's own code may only collide
// with this block in the passthrough case. Documented in README's "Exit codes".
const EH_EXIT_PREFLIGHT = 64
const EH_EXIT_SPAWN = 65
const EH_EXIT_HARNESS_ERROR = 66
const TIMEOUT_KILL_GRACE_MS = 10_000
// After the --timeout machinery force-closes the harness stream, how long the
// real exit events still have to arrive before eh settles the completion
// itself: Bun withholds them (and even exitCode) while any other process
// holds the stdout pipe, e.g. a detached grandchild that inherited it.
const TIMEOUT_RESCUE_GRACE_MS = 1_000
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
  resultFile?: string
  resumeSessionId?: string
  timeout?: string
}

interface NormalizerState {
  assistantText: string
  nativeResult: string | undefined
  pendingGrokText: string
  resultIsError: boolean
  sessionId: string | undefined
  usage: UsageAccumulator
}

interface ResolvedHeadlessRunOptions {
  cwd: string | undefined
  effort: EffortLevel
  gatewayProvider: string | undefined
  harness: string
  model: string
  nativeArgs: string[]
  provider: string
  resultFile: string | undefined
  resumeSessionId: string | undefined
  timeoutSeconds: number | undefined
}

// eh's per-run usage accumulator: a cumulative total (when the harness reports
// one) or the sum of per-event deltas, each with the harness's own cost.
interface UsageAccumulator {
  cumulative: NormalizedUsage | undefined
  cumulativeHarnessCostUsd: number | undefined
  delta: NormalizedUsage
  deltaHarnessCostUsd: number | undefined
}

// A single normalized usage event before it is emitted and folded.
interface UsageEvent {
  cacheReadTokens: number
  cacheWriteTokens: number
  cumulative: boolean
  harnessCostUsd: number | undefined
  inputTokens: number
  outputTokens: number
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
      resultFile: options.resultFile,
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
    // Resolve rates here (headless never installs the statusline that would
    // otherwise fetch them) so the final usage event can carry a computed cost.
    const rateCard = await fetchHeadlessRateCard({
      gatewayProvider: resolved.gatewayProvider,
      modelId: resolved.model,
      provider,
    })
    const plan = await buildLaunchPlan(
      resolved.harness,
      provider,
      resolved.model,
      {
        approvalMode: config.defaultApprovalMode,
        effort: resolved.effort,
        gatewayProvider: resolved.gatewayProvider,
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
          rateCard,
          resultFile: resolved.resultFile,
          stdin: prepared.stdin,
          timeoutSeconds: resolved.timeoutSeconds,
        })
      })
    })
  } catch (error) {
    if (state.executionStarted) throw error
    await writeResultFile(options.resultFile, '')
    emit({ message: errorMessage(error), type: 'run.error' })
    emit({
      exitCode: EH_EXIT_PREFLIGHT,
      resultIsError: true,
      type: 'run.completed',
    })
    return EH_EXIT_PREFLIGHT
  }
}

function addOptional(a: number | undefined, b: number | undefined) {
  if (a === undefined && b === undefined) return undefined
  return (a ?? 0) + (b ?? 0)
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

function emitAssistantText(text: string, state: NormalizerState) {
  emit({ text, type: 'assistant.text' })
  return {
    ...state,
    assistantText:
      state.assistantText === '' ? text : `${state.assistantText}\n${text}`,
  }
}

function emitGrokUsage(
  state: NormalizerState,
  event: Record<string, unknown>,
  cumulative: boolean,
) {
  const usage = asRecord(event.usage)
  if (!usage) return state
  return recordUsage(state, {
    cacheReadTokens: numberField(usage, 'cache_read_input_tokens'),
    cacheWriteTokens: numberField(usage, 'cache_creation_input_tokens'),
    cumulative,
    harnessCostUsd:
      optionalNumberField(event, 'total_cost_usd') ??
      optionalNumberField(event, 'cost_usd'),
    inputTokens: numberField(usage, 'input_tokens'),
    outputTokens: numberField(usage, 'output_tokens'),
  })
}

function emitNewSession(value: unknown, state: NormalizerState) {
  if (typeof value !== 'string' || value === state.sessionId) return state
  return { ...state, sessionId: emitSession(value, state.sessionId) }
}

// First human-readable message the harness event carries, or undefined. The
// trailing `|| undefined` also maps an empty string to undefined so callers
// can fall back with `??`.
type ChildCompletion =
  | { code: null | number; signal: keyof typeof os.constants.signals | null }
  | { error: Error }

function emitRunError(event: Record<string, unknown>, fallback: string) {
  emit({ message: eventMessage(event) ?? fallback, type: 'run.error' })
}

function emitSession(value: unknown, current: string | undefined) {
  if (typeof value === 'string' && value !== current) {
    emit({ sessionId: value, type: 'session.started' })
    return value
  }
  return current
}

function eventMessage(event: Record<string, unknown>) {
  const nested = asRecord(event.error)
  const data = nested ? asRecord(nested.data) : undefined
  return (
    (typeof event.message === 'string' && event.message) ||
    (typeof event.errorMessage === 'string' && event.errorMessage) ||
    (typeof nested?.message === 'string' && nested.message) ||
    (typeof data?.message === 'string' && data.message) ||
    (typeof event.result === 'string' && event.result) ||
    undefined
  )
}

// Per-event usage carries the harness's own cost estimate as harnessCostUsd —
// never as costUsd. eh's authoritative computed cost is emitted once, on the
// final summary usage event, so the two are never conflated.
function emitUsage(usage: UsageEvent) {
  emit({
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    cumulative: usage.cumulative,
    ...(usage.harnessCostUsd === undefined
      ? {}
      : { harnessCostUsd: usage.harnessCostUsd }),
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
  rateCard: HeadlessRateCard
  resultFile?: string
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
  rateCard: HeadlessRateCard
  resultFile?: string
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
  // Settled either by the child's own exit/close events or, when those are
  // withheld by a held-open stdout pipe, by the --timeout rescue below.
  let settleCompletion: ((value: ChildCompletion) => void) | undefined
  const completion = new Promise<ChildCompletion>((resolve) => {
    settleCompletion = resolve
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
  let rescueTimer: ReturnType<typeof setTimeout> | undefined

  try {
    child.stderr.pipe(process.stderr)
    child.stdin.on('error', () => undefined)
    child.stdin.end(options.stdin)

    if (options.timeoutSeconds !== undefined) {
      timeoutTimer = setTimeout(() => {
        // A finished harness normally ends the read loop at EOF, clearing
        // this timer via the finally below. If it fires anyway with the
        // child already reaped, a detached grandchild is holding the stdout
        // pipe open (Bun withholds the close event): finish the run with the
        // real exit status instead of waiting on the orphan.
        if (child.exitCode !== null || child.signalCode !== null) {
          lines.close()
          settleCompletion?.({
            code: child.exitCode,
            signal: child.signalCode,
          })
          return
        }
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
          // EOF never arrives while a grandchild holds the pipe; close the
          // read side ourselves so the loop can finish.
          lines.close()
          // Give the real close event a final chance after the kill; if the
          // pipe is still held it will never come, so settle with whatever
          // exit status was reaped.
          rescueTimer = setTimeout(() => {
            settleCompletion?.({
              code: child.exitCode,
              signal: child.signalCode,
            })
          }, TIMEOUT_RESCUE_GRACE_MS)
        }, timeoutKillGraceMs())
      }, options.timeoutSeconds * 1000)
    }

    let state: NormalizerState = {
      assistantText: '',
      nativeResult: undefined,
      pendingGrokText: '',
      resultIsError: false,
      sessionId: undefined,
      usage: {
        cumulative: undefined,
        cumulativeHarnessCostUsd: undefined,
        delta: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        deltaHarnessCostUsd: undefined,
      },
    }
    for await (const line of lines) {
      state = normalizeHarnessLine({
        harness: options.harness,
        line,
        state,
      })
    }
    if (options.harness === 'grok') state = flushGrokText(state)
    const resultText = state.nativeResult ?? state.assistantText

    const completed = await completion
    if ('error' in completed) {
      emit({
        message:
          completed.error.message || `Failed to spawn "${options.plan.bin}"`,
        type: 'run.error',
      })
      await writeResultFile(options.resultFile, resultText)
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
    const resultWriteOk = await writeResultFile(options.resultFile, resultText)
    emitCostSummary(state.usage, options.rateCard)
    const finalExitCode = resultWriteOk ? exitCode : EH_EXIT_HARNESS_ERROR
    emit({
      exitCode: finalExitCode,
      resultIsError: resultIsError || !resultWriteOk,
      type: 'run.completed',
    })
    return finalExitCode
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer)
    if (killTimer) clearTimeout(killTimer)
    if (rescueTimer) clearTimeout(rescueTimer)
    for (const { handler, signal } of signalHandlers) {
      process.off(signal, handler)
    }
    // A detached grandchild can inherit the harness's stdout and stderr and
    // keep both pipes open forever, which would keep this process alive
    // after the run has already finished. The run is over — release our ends.
    child.stdout.destroy()
    child.stderr.destroy()
  }
}

// Emit the per-event usage and fold it into the run accumulator.
function recordUsage(state: NormalizerState, usage: UsageEvent) {
  emitUsage(usage)
  return { ...state, usage: foldUsage(state.usage, usage) }
}

// Total usage for the summary event, or undefined when the run reported none
// (e.g. a spawn/timeout kill before any usage) — so no phantom $0 is emitted.
function finalUsage(acc: UsageAccumulator) {
  if (acc.cumulative) {
    return {
      harnessCostUsd: acc.cumulativeHarnessCostUsd,
      usage: acc.cumulative,
    }
  }
  const { cacheRead, cacheWrite, input, output } = acc.delta
  if (
    cacheRead === 0 &&
    cacheWrite === 0 &&
    input === 0 &&
    output === 0 &&
    acc.deltaHarnessCostUsd === undefined
  ) {
    return undefined
  }
  return { harnessCostUsd: acc.deltaHarnessCostUsd, usage: acc.delta }
}

// Accumulate eh's own normalized usage. A cumulative:true total wins outright;
// otherwise per-event deltas are summed. This avoids double-counting harnesses
// (grok) that emit both per-step deltas and a final cumulative total.
function foldUsage(acc: UsageAccumulator, usage: UsageEvent): UsageAccumulator {
  const tokens: NormalizedUsage = {
    cacheRead: usage.cacheReadTokens,
    cacheWrite: usage.cacheWriteTokens,
    input: usage.inputTokens,
    output: usage.outputTokens,
  }
  if (usage.cumulative) {
    return {
      ...acc,
      cumulative: tokens,
      cumulativeHarnessCostUsd: usage.harnessCostUsd,
    }
  }
  return {
    ...acc,
    delta: {
      cacheRead: acc.delta.cacheRead + tokens.cacheRead,
      cacheWrite: acc.delta.cacheWrite + tokens.cacheWrite,
      input: acc.delta.input + tokens.input,
      output: acc.delta.output + tokens.output,
    },
    deltaHarnessCostUsd: addOptional(
      acc.deltaHarnessCostUsd,
      usage.harnessCostUsd,
    ),
  }
}

// Emit the final summary usage event: eh's own cumulative normalized usage with
// the cost it computed from the resolved gateway rates (costUsd + costSource),
// plus the harness's own estimate preserved separately as harnessCostUsd.
function emitCostSummary(acc: UsageAccumulator, rateCard: HeadlessRateCard) {
  const final = finalUsage(acc)
  if (!final) return
  const { costSource, costUsd } = headlessCost(rateCard, final.usage)
  emit({
    cacheReadTokens: final.usage.cacheRead,
    cacheWriteTokens: final.usage.cacheWrite,
    costSource,
    ...(costUsd === undefined ? {} : { costUsd }),
    cumulative: true,
    ...(final.harnessCostUsd === undefined
      ? {}
      : { harnessCostUsd: final.harnessCostUsd }),
    inputTokens: final.usage.input,
    outputTokens: final.usage.output,
    type: 'usage',
  })
}

function flushGrokText(state: NormalizerState) {
  if (!state.pendingGrokText) return state
  return emitAssistantText(state.pendingGrokText, {
    ...state,
    pendingGrokText: '',
  })
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
  let next = state
  if (event.type === 'system') {
    next = { ...next, sessionId: emitSession(event.session_id, next.sessionId) }
  }

  if (event.type === 'assistant') {
    const message = asRecord(event.message)
    if (message && Array.isArray(message.content)) {
      for (const rawBlock of message.content) {
        const block = asRecord(rawBlock)
        if (block?.type === 'text' && typeof block.text === 'string') {
          next = emitAssistantText(block.text, next)
        }
      }
    }
  }

  if (event.type !== 'result') return next
  next = { ...next, sessionId: emitSession(event.session_id, next.sessionId) }
  const usage = asRecord(event.usage)
  let nextState = next
  if (usage) {
    nextState = recordUsage(nextState, {
      cacheReadTokens: numberField(usage, 'cache_read_input_tokens'),
      cacheWriteTokens: numberField(usage, 'cache_creation_input_tokens'),
      cumulative: false,
      harnessCostUsd: optionalNumberField(event, 'total_cost_usd'),
      inputTokens: numberField(usage, 'input_tokens'),
      outputTokens: numberField(usage, 'output_tokens'),
    })
  }
  const resultIsError =
    event.is_error === true ||
    (typeof event.subtype === 'string' && event.subtype !== 'success')
  if (resultIsError) emitRunError(event, 'Claude reported a failed result')
  return {
    ...nextState,
    nativeResult:
      typeof event.result === 'string' ? event.result : nextState.nativeResult,
    resultIsError: nextState.resultIsError || resultIsError,
  }
}

function normalizeCodexEvent(
  event: Record<string, unknown>,
  state: NormalizerState,
) {
  let next =
    event.type === 'thread.started'
      ? { ...state, sessionId: emitSession(event.thread_id, state.sessionId) }
      : state

  if (event.type === 'item.completed') {
    const item = asRecord(event.item)
    if (item?.type === 'agent_message' && typeof item.text === 'string') {
      next = emitAssistantText(item.text, next)
    }
  }

  let nextState = next
  if (event.type === 'turn.completed') {
    const usage = asRecord(event.usage)
    if (usage) {
      // Codex cached_input_tokens and cache_write_input_tokens both come
      // from OpenAI's input_tokens_details, so each is a subset of
      // input_tokens, not a disjoint bucket. Subtract both so the four
      // usage fields stay exclusive.
      const cacheReadTokens = numberField(usage, 'cached_input_tokens')
      const cacheWriteTokens = numberField(usage, 'cache_write_input_tokens')
      const inputTokens = numberField(usage, 'input_tokens')
      nextState = recordUsage(nextState, {
        cacheReadTokens,
        cacheWriteTokens,
        cumulative: true,
        harnessCostUsd:
          optionalNumberField(event, 'total_cost_usd') ??
          optionalNumberField(event, 'cost_usd'),
        inputTokens: Math.max(
          0,
          inputTokens - cacheReadTokens - cacheWriteTokens,
        ),
        outputTokens: numberField(usage, 'output_tokens'),
      })
    }
  }

  if (event.type === 'turn.failed') {
    emitRunError(event, 'Codex reported a failed turn')
    return { ...nextState, resultIsError: true }
  }
  if (event.type === 'error') {
    // Bare error events can be transient (stream reconnects, e.g.
    // "Reconnecting... 1/5") — codex retries and can still exit 0. Surface
    // them on stderr; real failures arrive as turn.failed or a non-zero
    // exit, both of which already fail the run.
    process.stderr.write(
      `codex: ${eventMessage(event) ?? JSON.stringify(event)}\n`,
    )
    return nextState
  }

  return nextState
}

function normalizeGrokEvent(
  event: Record<string, unknown>,
  state: NormalizerState,
) {
  if (isGrokTextDelta(event)) {
    return { ...state, pendingGrokText: state.pendingGrokText + event.data }
  }
  let nextState = state
  if (event.type === 'usage') nextState = emitGrokUsage(nextState, event, false)
  if (event.type === 'end') {
    nextState = {
      ...nextState,
      sessionId: emitSession(event.sessionId, nextState.sessionId),
    }
    nextState = emitGrokUsage(nextState, event, true)
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
  let nextState = emitNewSession(event.sessionID, state)
  const part = asRecord(event.part)

  if (
    event.type === 'text' &&
    part?.type === 'text' &&
    typeof part.text === 'string'
  ) {
    nextState = emitAssistantText(part.text, nextState)
  }

  if (event.type === 'step_finish' && part?.type === 'step-finish') {
    const tokens = asRecord(part.tokens)
    const cache = tokens ? asRecord(tokens.cache) : undefined
    if (tokens) {
      nextState = recordUsage(nextState, {
        cacheReadTokens: cache ? numberField(cache, 'read') : 0,
        cacheWriteTokens: cache ? numberField(cache, 'write') : 0,
        cumulative: false,
        harnessCostUsd: optionalNumberField(part, 'cost'),
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
  let nextState = emitNewSession(event.id, state)
  if (event.type !== 'message_end') return nextState

  const message = asRecord(event.message)
  if (message?.role !== 'assistant') return nextState
  if (Array.isArray(message.content)) {
    for (const rawBlock of message.content) {
      const block = asRecord(rawBlock)
      if (block?.type === 'text' && typeof block.text === 'string') {
        nextState = emitAssistantText(block.text, nextState)
      }
    }
  }

  const usage = asRecord(message.usage)
  if (usage) {
    const cost = asRecord(usage.cost)
    nextState = recordUsage(nextState, {
      cacheReadTokens: numberField(usage, 'cacheRead'),
      cacheWriteTokens: numberField(usage, 'cacheWrite'),
      cumulative: false,
      harnessCostUsd: cost ? optionalNumberField(cost, 'total') : undefined,
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
  // setTimeout saturates above 2^31-1 ms (Node and Bun clamp to 1 ms), which
  // would kill the harness instantly instead of after the requested wait.
  if (seconds > 2_147_483) {
    throw new Error(
      `--timeout too large (max 2147483s ≈ 24.8 days, got "${value}")`,
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

async function writeResultFile(
  resultFile: string | undefined,
  text: string,
) {
  if (resultFile === undefined) return true
  try {
    await writeFile(resultFile, text)
    return true
  } catch (error) {
    emit({
      message: `failed to write --result-file "${resultFile}": ${errorMessage(error)}`,
      type: 'run.error',
    })
    return false
  }
}
