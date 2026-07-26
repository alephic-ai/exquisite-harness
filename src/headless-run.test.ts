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
import { tmpdir } from 'node:os'
import path from 'node:path'
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
        '["-c","model_auto_compact_token_limit=240000"]',
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
    expect(argsEvent?.data.event.args).toContain('-')
    expect(argsEvent?.data.event.args).not.toContain('fix the parser')
    expect(argsEvent?.data.event.args).toContain(
      'model_auto_compact_token_limit=240000',
    )
  })

  test('normalizes Claude session, text, and usage events', async () => {
    const fixture = createFakeClaude()
    const child = spawn(
      process.execPath,
      ['run', 'src/main.ts', 'run', 'claude', 'ollama', 'qwen3-coder'],
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
})

async function childExitCode(child: ReturnType<typeof spawn>) {
  return new Promise<number>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 1))
  })
}

function createFakeClaude() {
  return createFakeHarness(
    'claude',
    `const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const prompt = Buffer.concat(chunks).toString('utf8')
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n')
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
emit({ type: 'fake.args', args, prompt, promptPath })
emit({ type: 'text', data: 'saw: ' + prompt })
emit({ type: 'end', sessionId: 'grok-session' })`,
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
