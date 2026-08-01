import type { Readable } from 'node:stream'

import { afterAll, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os, { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { z } from 'zod'

const repoRoot = path.resolve(import.meta.dir, '..')
const tempDirs: string[] = []

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true })
})

describe('eh run', () => {
  test('passes the prompt over stdin and emits the normalized NDJSON contract', async () => {
    const fixture = createFakeCodex()
    const child = spawn(
      process.execPath,
      [
        'run',
        'src/main.ts',
        'run',
        'codex',
        'ollama',
        'qwen3-coder',
        '--reasoning-effort',
        'high',
        '--native-args-json',
        '["--sandbox","read-only"]',
        '--resume-session',
        'thread-previous',
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ''}`,
          XDG_CONFIG_HOME: fixture.configDir,
        },
      },
    )
    child.stdin.end('fix the parser')

    const [exitCode, stderr, stdout] = await Promise.all([
      childExitCode(child),
      readStream(child.stderr),
      readStream(child.stdout),
    ])

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)

    const events = stdout
      .trim()
      .split('\n')
      .map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)))
    expect(events).toContainEqual({
      effort: 'high',
      harness: 'codex',
      model: 'qwen3-coder',
      provider: 'ollama',
      type: 'run.started',
      v: 1,
    })
    expect(events).toContainEqual({
      sessionId: 'thread-123',
      type: 'session.started',
      v: 1,
    })
    expect(events).toContainEqual({
      text: 'saw: fix the parser',
      type: 'assistant.text',
      v: 1,
    })
    expect(events).toContainEqual({
      cacheReadTokens: 4,
      cacheWriteTokens: 0,
      cumulative: true,
      inputTokens: 10,
      outputTokens: 2,
      type: 'usage',
      v: 1,
    })
    expect(events).toContainEqual({
      exitCode: 0,
      resultIsError: false,
      type: 'run.completed',
      v: 1,
    })

    const argsEvent = events
      .map((event) =>
        z
          .object({
            event: z.object({
              args: z.array(z.string()),
              type: z.literal('fake.args'),
            }),
            type: z.literal('harness.event'),
          })
          .safeParse(event),
      )
      .find((result) => result.success)
    const args = argsEvent?.data.event.args ?? []
    expect(args.slice(args.indexOf('exec'))).toEqual([
      'exec',
      '--sandbox',
      'read-only',
      'resume',
      'thread-previous',
      '-',
      '--json',
    ])
    expect(args).not.toContain('fix the parser')
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
  })

  test('normalizes a missing harness binary as a failed run', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'eh-headless-test-'))
    tempDirs.push(root)
    const binDir = path.join(root, 'bin')
    const configDir = path.join(root, 'config')
    mkdirSync(binDir, { recursive: true })
    mkdirSync(configDir, { recursive: true })
    const child = spawn(
      process.execPath,
      ['run', 'src/main.ts', 'run', 'codex', 'ollama', 'qwen3-coder'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: binDir,
          XDG_CONFIG_HOME: configDir,
        },
      },
    )
    child.stdin.end('fail to launch')

    const [exitCode, stderr, stdout] = await Promise.all([
      childExitCode(child),
      readStream(child.stderr),
      readStream(child.stdout),
    ])
    const events = parseEvents(stdout)

    expect(stderr).toBe('')
    expect(exitCode).toBe(1)
    expect(events).toHaveLength(3)
    expect(events[0]).toEqual({
      effort: 'auto',
      harness: 'codex',
      model: 'qwen3-coder',
      provider: 'ollama',
      type: 'run.started',
      v: 1,
    })
    expect(events[1]).toEqual({
      message: expect.stringContaining('codex'),
      type: 'run.error',
      v: 1,
    })
    expect(events[2]).toEqual({
      exitCode: 1,
      resultIsError: true,
      type: 'run.completed',
      v: 1,
    })
  })

  test('normalizes Claude session, text, and usage events', async () => {
    const fixture = createFakeClaude()
    const child = spawn(
      process.execPath,
      [
        'run',
        'src/main.ts',
        'run',
        'claude',
        'ollama',
        'qwen3-coder',
        '--native-args-json',
        '["--permission-mode","plan"]',
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ''}`,
          XDG_CONFIG_HOME: fixture.configDir,
        },
      },
    )
    child.stdin.end('review the change')

    const [exitCode, stdout] = await Promise.all([
      childExitCode(child),
      readStream(child.stdout),
      readStream(child.stderr),
    ])
    const events = parseEvents(stdout)

    expect(exitCode).toBe(0)
    expect(events).toContainEqual({
      sessionId: 'claude-session',
      type: 'session.started',
      v: 1,
    })
    expect(events).toContainEqual({
      text: 'saw: review the change',
      type: 'assistant.text',
      v: 1,
    })
    expect(events).toContainEqual({
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
      costUsd: 0.25,
      cumulative: false,
      inputTokens: 9,
      outputTokens: 4,
      type: 'usage',
      v: 1,
    })

    const argsEvent = events
      .map((event) =>
        z
          .object({
            event: z.object({
              args: z.array(z.string()),
              type: z.literal('fake.args'),
            }),
            type: z.literal('harness.event'),
          })
          .safeParse(event),
      )
      .find((result) => result.success)
    const args = argsEvent?.data.event.args ?? []
    expect(args).toContain('--permission-mode')
    expect(args).toContain('plan')
    expect(args).not.toContain('--dangerously-skip-permissions')
  })

  test('uses and removes a private prompt file for Grok', async () => {
    const fixture = createFakeGrok()
    const child = spawn(
      process.execPath,
      [
        'run',
        'src/main.ts',
        'run',
        'grok',
        'ollama',
        'qwen3-coder',
        '--reasoning-effort',
        'high',
        '--native-args-json',
        '["--permission-mode","plan"]',
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ''}`,
          XDG_CONFIG_HOME: fixture.configDir,
        },
      },
    )
    child.stdin.end('inspect the diff')

    const [exitCode, stdout] = await Promise.all([
      childExitCode(child),
      readStream(child.stdout),
      readStream(child.stderr),
    ])
    const events = parseEvents(stdout)
    const fakeEvent = z
      .object({
        event: z.object({
          args: z.array(z.string()),
          pid: z.number().int().positive(),
          prompt: z.string(),
          promptPath: z.string(),
          type: z.literal('fake.args'),
        }),
        type: z.literal('harness.event'),
      })
      .parse(events.find((event) => event.type === 'harness.event'))

    expect(exitCode).toBe(0)
    expect(fakeEvent.event.prompt).toBe('inspect the diff')
    expect(fakeEvent.event.args).toContain('--reasoning-effort')
    expect(fakeEvent.event.args).toContain('--permission-mode')
    expect(fakeEvent.event.args).toContain('plan')
    expect(fakeEvent.event.args).not.toContain('--always-approve')
    expect(existsSync(fakeEvent.event.promptPath)).toBe(false)
    expect(events).toContainEqual({
      sessionId: 'grok-session',
      type: 'session.started',
      v: 1,
    })
    expect(events).toContainEqual({
      text: 'saw: inspect the diff',
      type: 'assistant.text',
      v: 1,
    })
    expect(events).toContainEqual({
      cacheReadTokens: 1,
      cacheWriteTokens: 3,
      cumulative: false,
      inputTokens: 5,
      outputTokens: 2,
      type: 'usage',
      v: 1,
    })
    expect(events).toContainEqual({
      cacheReadTokens: 4,
      cacheWriteTokens: 6,
      costUsd: 0.12,
      cumulative: true,
      inputTokens: 20,
      outputTokens: 8,
      type: 'usage',
      v: 1,
    })
  })

  test('converts a semantic Codex failure into a non-zero wrapper exit', async () => {
    const fixture = createFakeCodex()
    const child = spawn(
      process.execPath,
      ['run', 'src/main.ts', 'run', 'codex', 'ollama', 'qwen3-coder'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          EH_TEST_CODEX_FAIL: '1',
          PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ''}`,
          XDG_CONFIG_HOME: fixture.configDir,
        },
      },
    )
    child.stdin.end('fail this run')

    const [exitCode, stdout] = await Promise.all([
      childExitCode(child),
      readStream(child.stdout),
      readStream(child.stderr),
    ])
    const events = stdout
      .trim()
      .split('\n')
      .map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)))

    expect(exitCode).toBe(1)
    expect(events).toContainEqual({
      message: 'expected failure',
      type: 'run.error',
      v: 1,
    })
    expect(events).toContainEqual({
      exitCode: 1,
      resultIsError: true,
      type: 'run.completed',
      v: 1,
    })
  })

  test('emits a run error when a harness exits non-zero without a semantic error', async () => {
    const fixture = createFakeCodex()
    const child = spawn(
      process.execPath,
      ['run', 'src/main.ts', 'run', 'codex', 'ollama', 'qwen3-coder'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          EH_TEST_CODEX_EXIT_CODE: '7',
          PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ''}`,
          XDG_CONFIG_HOME: fixture.configDir,
        },
      },
    )
    child.stdin.end('exit without an event')

    const [exitCode, stderr, stdout] = await Promise.all([
      childExitCode(child),
      readStream(child.stderr),
      readStream(child.stdout),
    ])
    const events = parseEvents(stdout)

    expect(exitCode).toBe(7)
    expect(stderr).toBe('native failure\n')
    expect(events).toContainEqual({
      message: 'codex exited with code 7',
      type: 'run.error',
      v: 1,
    })
    expect(events).toContainEqual({
      exitCode: 7,
      resultIsError: true,
      type: 'run.completed',
      v: 1,
    })
  })

  test('forwards termination signals and removes the Grok prompt file', async () => {
    const fixture = createFakeGrok()
    const child = spawn(
      process.execPath,
      ['run', 'src/main.ts', 'run', 'grok', 'ollama', 'qwen3-coder'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ''}`,
          XDG_CONFIG_HOME: fixture.configDir,
        },
      },
    )
    const exitCodePromise = childExitCode(child)
    const stderrPromise = readStream(child.stderr)
    const lines = createInterface({ input: child.stdout })
    const events: Record<string, unknown>[] = []
    let fakeArgs: undefined | { pid: number; promptPath: string }
    child.stdin.end('wait for signal')

    try {
      for await (const line of lines) {
        const event = z.record(z.string(), z.unknown()).parse(JSON.parse(line))
        events.push(event)
        const parsed = z
          .object({
            event: z.object({
              pid: z.number().int().positive(),
              promptPath: z.string(),
              type: z.literal('fake.args'),
            }),
            type: z.literal('harness.event'),
          })
          .safeParse(event)
        if (parsed.success && !fakeArgs) {
          fakeArgs = parsed.data.event
          expect(existsSync(fakeArgs.promptPath)).toBe(true)
          child.kill('SIGTERM')
        }
      }

      const [exitCode, stderr] = await Promise.all([
        exitCodePromise,
        stderrPromise,
      ])
      const started = fakeArgs
      expect(started).toBeDefined()
      if (!started) throw new Error('fake Grok process did not start')

      expect(stderr).toBe('')
      expect(exitCode).toBe(128 + os.constants.signals.SIGTERM)
      expect(existsSync(started.promptPath)).toBe(false)
      expect(() => process.kill(started.pid, 0)).toThrow()
      expect(events).toContainEqual({
        message: 'grok exited with signal SIGTERM',
        type: 'run.error',
        v: 1,
      })
      expect(events).toContainEqual({
        exitCode: 128 + os.constants.signals.SIGTERM,
        resultIsError: true,
        type: 'run.completed',
        v: 1,
      })
    } finally {
      if (fakeArgs) {
        try {
          process.kill(fakeArgs.pid, 'SIGKILL')
        } catch {
          // The expected path already reaped the fake process.
        }
        rmSync(path.dirname(fakeArgs.promptPath), {
          force: true,
          recursive: true,
        })
      }
    }
  })
})

async function childExitCode(child: ReturnType<typeof spawn>) {
  return new Promise<number>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code !== null) {
        resolve(code)
        return
      }
      const signalNumber = signal ? os.constants.signals[signal] : undefined
      resolve(signalNumber ? 128 + signalNumber : 1)
    })
  })
}

function createFakeClaude() {
  return createFakeHarness(
    'claude',
    `const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const prompt = Buffer.concat(chunks).toString('utf8')
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n')
emit({ type: 'fake.args', args: process.argv.slice(2) })
emit({ type: 'system', session_id: 'claude-session' })
emit({
  type: 'assistant',
  message: { content: [{ type: 'text', text: 'saw: ' + prompt }] },
})
emit({
  type: 'result',
  session_id: 'claude-session',
  total_cost_usd: 0.25,
  usage: {
    cache_creation_input_tokens: 2,
    cache_read_input_tokens: 3,
    input_tokens: 9,
    output_tokens: 4,
  },
})`,
  )
}

function createFakeCodex() {
  return createFakeHarness(
    'codex',
    `const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const prompt = Buffer.concat(chunks).toString('utf8')
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n')
emit({ type: 'thread.started', thread_id: 'thread-123' })
emit({ type: 'fake.args', args: process.argv.slice(2) })
if (process.env.EH_TEST_CODEX_EXIT_CODE) {
  process.stderr.write('native failure\\n')
  process.exit(Number(process.env.EH_TEST_CODEX_EXIT_CODE))
}
if (process.env.EH_TEST_CODEX_FAIL === '1') {
  emit({ type: 'turn.failed', error: { message: 'expected failure' } })
  process.exit(0)
}
emit({
  type: 'item.completed',
  item: { type: 'agent_message', text: 'saw: ' + prompt },
})
emit({
  type: 'turn.completed',
  usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 },
})`,
  )
}

function createFakeGrok() {
  return createFakeHarness(
    'grok',
    `const { readFileSync } = require('node:fs')
const args = process.argv.slice(2)
const promptPath = args[args.indexOf('--prompt-file') + 1]
const prompt = readFileSync(promptPath, 'utf8')
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n')
emit({ type: 'fake.args', args, pid: process.pid, prompt, promptPath })
if (prompt === 'wait for signal') {
  setInterval(() => {}, 1000)
} else {
emit({ type: 'text', data: 'saw: ' + prompt })
emit({
  type: 'usage',
  usage: {
    cache_creation_input_tokens: 3,
    cache_read_input_tokens: 1,
    input_tokens: 5,
    output_tokens: 2,
  },
})
emit({
  type: 'end',
  sessionId: 'grok-session',
  total_cost_usd: 0.12,
  usage: {
    cache_creation_input_tokens: 6,
    cache_read_input_tokens: 4,
    input_tokens: 20,
    output_tokens: 8,
  },
})
}`,
  )
}

function createFakeHarness(name: string, body: string) {
  const root = mkdtempSync(path.join(tmpdir(), 'eh-headless-test-'))
  tempDirs.push(root)
  const binDir = path.join(root, 'bin')
  const configDir = path.join(root, 'config')
  const binary = path.join(binDir, name)
  mkdirSync(binDir, { recursive: true })
  mkdirSync(configDir, { recursive: true })
  writeFileSync(
    binary,
    `#!/usr/bin/env node
${body}
`,
    { mode: 0o755 },
  )
  chmodSync(binary, 0o755)
  return { binDir, configDir }
}

function parseEvents(stdout: string) {
  return stdout
    .trim()
    .split('\n')
    .map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)))
}

async function readStream(stream: Readable) {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  return Buffer.concat(chunks).toString('utf8')
}
