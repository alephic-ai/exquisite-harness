import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { z } from 'zod'

import type { EffortLevel, LaunchPlan } from './types.js'

import { getProvider, loadConfig } from './config.js'
import { buildLaunchPlan } from './harnesses.js'

const PROTOCOL_VERSION = 1
const recordSchema = z.record(z.string(), z.unknown())

export interface HeadlessRunOptions {
  effort: EffortLevel
  harness: string
  model: string
  nativeArgs?: string[]
  provider: string
  resumeSessionId?: string
}

interface NormalizerState {
  resultIsError: boolean
}

export function parseNativeArgsJson(value: string) {
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

export async function runHeadless(options: HeadlessRunOptions) {
  const prompt = readPrompt()
  if (!prompt.trim()) throw new Error('eh run requires a prompt on stdin')

  const provider = getProvider(loadConfig(), options.provider)
  if (!provider) throw new Error(`unknown provider "${options.provider}"`)
  const plan = await buildLaunchPlan(options.harness, provider, options.model, {
    effort: options.effort,
    statusline: false,
  })
  const prepared = await prepareHeadlessPlan({ options, plan, prompt })

  emit({
    effort: options.effort,
    harness: options.harness,
    model: options.model,
    provider: provider.name,
    type: 'run.started',
  })

  try {
    const exitCode = await executeHeadlessPlan({
      harness: options.harness,
      plan: prepared.plan,
      stdin: prepared.stdin,
    })
    return exitCode
  } finally {
    await prepared.cleanup()
  }
}

function asRecord(value: unknown) {
  const parsed = recordSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
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

function emitRunError(event: Record<string, unknown>, fallback: string) {
  const nested = asRecord(event.error)
  const message =
    (typeof event.message === 'string' && event.message) ||
    (typeof nested?.message === 'string' && nested.message) ||
    (typeof event.result === 'string' && event.result) ||
    fallback
  emit({ message, type: 'run.error' })
}

function emitSession(value: unknown) {
  if (typeof value === 'string') {
    emit({ sessionId: value, type: 'session.started' })
  }
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

async function executeHeadlessPlan(options: {
  harness: string
  plan: LaunchPlan
  stdin?: string
}) {
  const child = spawn(options.plan.bin, options.plan.args, {
    env: { ...process.env, ...options.plan.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
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

  try {
    child.stderr.pipe(process.stderr)
    child.stdin.on('error', () => undefined)
    child.stdin.end(options.stdin)

    let state: NormalizerState = { resultIsError: false }
    for await (const line of lines) {
      state = normalizeHarnessLine({
        harness: options.harness,
        line,
        state,
      })
    }

    const completed = await completion
    if ('error' in completed) {
      emit({
        message:
          completed.error.message || `Failed to spawn "${options.plan.bin}"`,
        type: 'run.error',
      })
      emit({ exitCode: 1, resultIsError: true, type: 'run.completed' })
      return 1
    }
    const signalNumber = completed.signal
      ? os.constants.signals[completed.signal]
      : undefined
    const childExitCode =
      completed.code ?? (signalNumber ? 128 + signalNumber : 1)
    if (!state.resultIsError && childExitCode !== 0) {
      emit({
        message: completed.signal
          ? `${options.harness} exited with signal ${completed.signal}`
          : `${options.harness} exited with code ${childExitCode}`,
        type: 'run.error',
      })
    }
    const resultIsError = state.resultIsError || childExitCode !== 0
    const exitCode = resultIsError && childExitCode === 0 ? 1 : childExitCode
    emit({ exitCode, resultIsError, type: 'run.completed' })
    return exitCode
  } finally {
    for (const { handler, signal } of signalHandlers) {
      process.off(signal, handler)
    }
  }
}

function normalizeClaudeEvent(
  event: Record<string, unknown>,
  state: NormalizerState,
) {
  if (event.type === 'system') emitSession(event.session_id)

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

  if (event.type !== 'result') return state
  emitSession(event.session_id)
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
  return { resultIsError: state.resultIsError || resultIsError }
}

function normalizeCodexEvent(
  event: Record<string, unknown>,
  state: NormalizerState,
) {
  if (event.type === 'thread.started') emitSession(event.thread_id)

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
    return { resultIsError: true }
  }

  return state
}

function normalizeGrokEvent(
  event: Record<string, unknown>,
  state: NormalizerState,
) {
  if (event.type === 'text' && typeof event.data === 'string') {
    emit({ text: event.data, type: 'assistant.text' })
  }
  if (event.type === 'usage') emitGrokUsage(event, false)
  if (event.type === 'end') {
    emitSession(event.sessionId)
    emitGrokUsage(event, true)
  }
  if (event.type === 'error') {
    emitRunError(event, 'Grok reported an error')
    return { resultIsError: true }
  }
  return state
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
    emit({ text: options.line, type: 'harness.output' })
    return options.state
  }

  const parsed = recordSchema.safeParse(decoded)
  if (!parsed.success) {
    emit({ text: options.line, type: 'harness.output' })
    return options.state
  }

  const event = parsed.data
  emit({ event, harness: options.harness, type: 'harness.event' })

  switch (options.harness) {
    case 'claude':
      return normalizeClaudeEvent(event, options.state)
    case 'codex':
      return normalizeCodexEvent(event, options.state)
    case 'grok':
      return normalizeGrokEvent(event, options.state)
    default:
      return options.state
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

async function prepareHeadlessPlan(options: {
  options: HeadlessRunOptions
  plan: LaunchPlan
  prompt: string
}) {
  const {
    effort,
    harness,
    model,
    nativeArgs = [],
    resumeSessionId,
  } = options.options
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

  throw new Error(`unknown harness "${harness}"`)
}

function readPrompt() {
  return readFileSync(0, 'utf8')
}
