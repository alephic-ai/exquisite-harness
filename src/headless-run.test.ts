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
import { createServer } from 'node:http'
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

  test('applies the global approval default to headless runs', async () => {
    const fixture = createFakeCodex()
    const ehConfigDir = path.join(fixture.configDir, 'eh')
    mkdirSync(ehConfigDir, { recursive: true })
    writeFileSync(
      path.join(ehConfigDir, 'config.json'),
      JSON.stringify({ defaultApprovalMode: 'auto', version: 1 }),
    )
    const child = spawn(
      process.execPath,
      ['run', 'src/main.ts', 'run', 'codex', 'ollama', 'qwen3-coder'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ''}`,
          XDG_CONFIG_HOME: fixture.configDir,
        },
      },
    )
    child.stdin.end('approve this run')

    const [exitCode, stdout] = await Promise.all([
      childExitCode(child),
      readStream(child.stdout),
      readStream(child.stderr),
    ])
    const events = parseEvents(stdout)
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

    expect(exitCode).toBe(0)
    expect(argsEvent?.data.event.args).toContain('--approve-for-me')
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
    expect(exitCode).toBe(65)
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
      exitCode: 65,
      resultIsError: true,
      type: 'run.completed',
      v: 1,
    })
  })

  test.each([
    [
      'empty stdin',
      'codex',
      'ollama',
      '',
      [],
      'none',
      'eh run expects a prompt on stdin',
    ],
    [
      'malformed native args',
      'codex',
      'ollama',
      'run the task',
      ['--native-args-json', 'not-json'],
      'none',
      '--native-args-json must be a JSON array of strings',
    ],
    [
      'invalid effort',
      'codex',
      'ollama',
      'run the task',
      ['--reasoning-effort', 'extreme'],
      'none',
      'unknown effort "extreme"',
    ],
    [
      'Claude-rejected none',
      'claude',
      'ollama',
      'run the task',
      ['--reasoning-effort', 'none'],
      'none',
      'effort "none" is not available',
    ],
    [
      'unknown harness',
      'missing-harness',
      'ollama',
      'run the task',
      [],
      'none',
      'unknown harness "missing-harness"',
    ],
    [
      'unknown provider',
      'codex',
      'missing-provider',
      'run the task',
      [],
      'none',
      'unknown provider "missing-provider"',
    ],
    [
      'Pi provider incompatibility',
      'pi',
      'ollama',
      'run the task',
      [],
      'missing-pi-provider',
      'pi can\'t serve provider "ollama"',
    ],
    [
      'missing provider key',
      'grok',
      'missing-key',
      'run the task',
      [],
      'missing-key',
      'no API key for "missing-key"',
    ],
  ] as const)(
    'normalizes the %s preflight failure',
    async (
      _name,
      harness,
      provider,
      prompt,
      extraArgs,
      setup,
      expectedMessage,
    ) => {
      const root = mkdtempSync(path.join(tmpdir(), 'eh-headless-test-'))
      tempDirs.push(root)
      const configDir = path.join(root, 'config')
      const piDir = path.join(root, 'pi')
      mkdirSync(configDir, { recursive: true })
      mkdirSync(piDir, { recursive: true })
      if (setup === 'missing-key') {
        const ehConfigDir = path.join(configDir, 'eh')
        mkdirSync(ehConfigDir, { recursive: true })
        writeFileSync(
          path.join(ehConfigDir, 'config.json'),
          JSON.stringify({
            profiles: {},
            providers: {
              'missing-key': {
                baseURL: 'https://missing-key.invalid/v1',
                envKey: 'EH_HEADLESS_MISSING_KEY',
                type: 'openai-chat',
              },
            },
            recent: [],
            version: 1,
          }),
        )
      }

      const child = spawn(
        process.execPath,
        [
          'run',
          'src/main.ts',
          'run',
          harness,
          provider,
          'qwen3-coder',
          ...extraArgs,
        ],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            EH_HEADLESS_GATEWAY_KEY: 'qa-key',
            EH_HEADLESS_MISSING_KEY: '',
            PI_CODING_AGENT_DIR:
              setup === 'missing-pi-provider' ? piDir : undefined,
            XDG_CONFIG_HOME: configDir,
          },
        },
      )
      child.stdin.end(prompt)

      const [exitCode, stderr, stdout] = await Promise.all([
        childExitCode(child),
        readStream(child.stderr),
        readStream(child.stdout),
      ])

      expect(stderr).toBe('')
      expect(exitCode).toBe(64)
      expect(parseEvents(stdout)).toEqual([
        {
          message: expect.stringContaining(
            setup === 'missing-pi-provider'
              ? path.join(piDir, 'models.json')
              : expectedMessage,
          ),
          type: 'run.error',
          v: 1,
        },
        {
          exitCode: 64,
          resultIsError: true,
          type: 'run.completed',
          v: 1,
        },
      ])
    },
  )

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
    expect(events.filter((event) => event.type === 'session.started')).toEqual([
      {
        sessionId: 'claude-session',
        type: 'session.started',
        v: 1,
      },
    ])
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

  test('keeps a Gateway provider pin supplied after the run arguments', async () => {
    const fixture = createFakeClaude()
    const gateway = await startGatewayStub()
    const ehConfigDir = path.join(fixture.configDir, 'eh')
    mkdirSync(ehConfigDir, { recursive: true })
    writeFileSync(
      path.join(ehConfigDir, 'config.json'),
      JSON.stringify({
        profiles: {},
        providers: {
          'test-gateway': {
            baseURL: gateway.baseURL,
            envKey: 'EH_TEST_GATEWAY_KEY',
            type: 'vercel-gateway',
          },
        },
        recent: [],
        version: 1,
      }),
    )
    const child = spawn(
      process.execPath,
      [
        'run',
        'src/main.ts',
        'run',
        'claude',
        'test-gateway',
        'test-model',
        '--gateway-provider',
        'bedrock',
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          EH_TEST_GATEWAY_KEY: 'qa-key',
          PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ''}`,
          XDG_CONFIG_HOME: fixture.configDir,
        },
      },
    )
    child.stdin.end('verify routing')

    const [exitCode, stderr, stdout] = await Promise.all([
      childExitCode(child),
      readStream(child.stderr),
      readStream(child.stdout),
    ])
    await gateway.close()
    const events = parseEvents(stdout)

    expect(exitCode).toBe(0)
    expect(stderr).toBe('')
    expect(events).toContainEqual({
      effort: 'auto',
      gatewayProvider: 'bedrock',
      harness: 'claude',
      model: 'test-model',
      provider: 'test-gateway',
      type: 'run.started',
      v: 1,
    })
    const fakeEvent = z
      .object({
        event: z.object({
          anthropicBaseUrl: z.string(),
          type: z.literal('fake.args'),
        }),
        type: z.literal('harness.event'),
      })
      .parse(events.find((event) => event.type === 'harness.event'))
    expect(fakeEvent.event.anthropicBaseUrl).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+$/,
    )
  })

  test('routes an opencode Gateway provider pin through the proxy', async () => {
    const fixture = createFakeOpencode()
    const gateway = await startGatewayStub()
    const ehConfigDir = path.join(fixture.configDir, 'eh')
    mkdirSync(ehConfigDir, { recursive: true })
    writeFileSync(
      path.join(ehConfigDir, 'config.json'),
      JSON.stringify({
        profiles: {},
        providers: {
          'test-gateway': {
            baseURL: gateway.baseURL,
            envKey: 'EH_TEST_GATEWAY_KEY',
            type: 'vercel-gateway',
          },
        },
        recent: [],
        version: 1,
      }),
    )
    const child = spawn(
      process.execPath,
      [
        'run',
        'src/main.ts',
        'run',
        'opencode',
        'test-gateway',
        'test-model',
        '--gateway-provider',
        'bedrock',
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          EH_TEST_GATEWAY_KEY: 'qa-key',
          PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ''}`,
          XDG_CONFIG_HOME: fixture.configDir,
        },
      },
    )
    child.stdin.end('verify opencode routing')

    const [exitCode, stderr, stdout] = await Promise.all([
      childExitCode(child),
      readStream(child.stderr),
      readStream(child.stdout),
    ])
    await gateway.close()
    const events = parseEvents(stdout)

    expect(exitCode).toBe(0)
    expect(stderr).toBe('')
    expect(events).toContainEqual({
      effort: 'auto',
      gatewayProvider: 'bedrock',
      harness: 'opencode',
      model: 'test-model',
      provider: 'test-gateway',
      type: 'run.started',
      v: 1,
    })
    const fakeEvent = z
      .object({
        event: z.object({
          opencodeConfigContent: z.string(),
          type: z.literal('fake.args'),
        }),
        type: z.literal('harness.event'),
      })
      .parse(events.find((event) => event.type === 'harness.event'))
    const config = z
      .object({
        provider: z.record(
          z.string(),
          z.object({
            options: z.object({ baseURL: z.string() }),
          }),
        ),
      })
      .parse(JSON.parse(fakeEvent.event.opencodeConfigContent))
    const routedBaseURL = config.provider['eh-test-gateway'].options.baseURL
    expect(routedBaseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/)
  })

  test('routes a Pi Gateway provider pin through the proxy', async () => {
    const fixture = createFakePi()
    const gateway = await startGatewayStub()
    // Point pi's `test-gateway` provider at the stub so eh's provider matches.
    writeFileSync(
      path.join(fixture.configDir, 'models.json'),
      JSON.stringify({
        providers: {
          'test-gateway': {
            api: 'openai-completions',
            apiKey: 'pi-gateway-key',
            baseUrl: `${gateway.baseURL}/v1`,
            models: [{ id: 'test-model' }],
          },
        },
      }),
    )
    const ehConfigDir = path.join(fixture.configDir, 'eh')
    mkdirSync(ehConfigDir, { recursive: true })
    writeFileSync(
      path.join(ehConfigDir, 'config.json'),
      JSON.stringify({
        profiles: {},
        providers: {
          'test-gateway': {
            baseURL: gateway.baseURL,
            envKey: 'EH_TEST_GATEWAY_KEY',
            type: 'vercel-gateway',
          },
        },
        recent: [],
        version: 1,
      }),
    )
    const child = spawn(
      process.execPath,
      [
        'run',
        'src/main.ts',
        'run',
        'pi',
        'test-gateway',
        'test-model',
        '--gateway-provider',
        'bedrock',
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          EH_TEST_GATEWAY_KEY: 'qa-key',
          PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ''}`,
          PI_CODING_AGENT_DIR: fixture.configDir,
          XDG_CONFIG_HOME: fixture.configDir,
        },
      },
    )
    child.stdin.end('verify pi routing')

    const [exitCode, stderr, stdout] = await Promise.all([
      childExitCode(child),
      readStream(child.stderr),
      readStream(child.stdout),
    ])
    await gateway.close()
    const events = parseEvents(stdout)

    expect(exitCode).toBe(0)
    expect(stderr).toBe('')
    expect(events).toContainEqual({
      effort: 'auto',
      gatewayProvider: 'bedrock',
      harness: 'pi',
      model: 'test-model',
      provider: 'test-gateway',
      type: 'run.started',
      v: 1,
    })
    const fakeEvent = z
      .object({
        event: z.object({
          args: z.array(z.string()),
          piProxyUrl: z.union([z.string(), z.undefined()]),
          type: z.literal('fake.args'),
        }),
        type: z.literal('harness.event'),
      })
      .parse(
        events.find(
          (event) =>
            event.type === 'harness.event' &&
            asRecord(event.event)?.type === 'fake.args',
        ),
      )
    const extensionArg = fakeEvent.event.args.findIndex(
      (arg) => arg === '--extension',
    )
    expect(extensionArg).toBeGreaterThan(-1)
    const extensionPath = fakeEvent.event.args[extensionArg + 1]
    expect(extensionPath).toMatch(/^\/.*eh-pi-.*gateway-routing\.js$/)
    expect(fakeEvent.event.piProxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(existsSync(extensionPath)).toBe(false)
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
          GROK_API_KEY: 'parent-grok-api-key',
          GROK_BASE_URL: 'parent-grok-base-url',
          GROK_MODELS_BASE_URL: 'parent-grok-models-base-url',
          PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ''}`,
          XAI_API_KEY: 'parent-xai-api-key',
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
          grokApiKey: z.string(),
          grokBaseUrl: z.string(),
          grokHome: z.string(),
          grokHomeHasAuth: z.boolean(),
          grokModelsBaseUrl: z.string(),
          pid: z.number().int().positive(),
          prompt: z.string(),
          promptPath: z.string(),
          type: z.literal('fake.args'),
          xaiApiKey: z.string(),
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
    expect(fakeEvent.event.grokModelsBaseUrl).toBe('http://localhost:11434/v1')
    expect(fakeEvent.event.xaiApiKey).toBe('ollama')
    expect(fakeEvent.event.grokBaseUrl).toBe('parent-grok-base-url')
    expect(fakeEvent.event.grokApiKey).toBe('parent-grok-api-key')
    expect(fakeEvent.event.grokHome.length).toBeGreaterThan(0)
    expect(fakeEvent.event.grokHomeHasAuth).toBe(false)
    expect(existsSync(fakeEvent.event.promptPath)).toBe(false)
    expect(existsSync(fakeEvent.event.grokHome)).toBe(false)
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
    expect(events.filter((event) => event.type === 'assistant.text')).toEqual([
      {
        text: 'saw: inspect the diff',
        type: 'assistant.text',
        v: 1,
      },
    ])
    const assistantTextIndex = events.findIndex(
      (event) => event.type === 'assistant.text',
    )
    const nativeUsageIndex = events.findIndex(
      (event) =>
        z
          .object({
            event: z.object({ type: z.literal('usage') }),
            type: z.literal('harness.event'),
          })
          .safeParse(event).success,
    )
    expect(assistantTextIndex).toBeGreaterThan(-1)
    expect(nativeUsageIndex).toBeGreaterThan(assistantTextIndex)
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

  test('normalizes Pi session, text, and usage events', async () => {
    const fixture = createFakePi()
    const child = spawn(
      process.execPath,
      [
        'run',
        'src/main.ts',
        'run',
        'pi',
        'ollama',
        'qwen3-coder',
        '--reasoning-effort',
        'high',
        '--native-args-json',
        '["--no-tools"]',
        '--resume-session',
        'pi-previous',
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ''}`,
          PI_CODING_AGENT_DIR: fixture.configDir,
          XDG_CONFIG_HOME: fixture.configDir,
        },
      },
    )
    child.stdin.end('inspect the parser')

    const [exitCode, stderr, stdout] = await Promise.all([
      childExitCode(child),
      readStream(child.stderr),
      readStream(child.stdout),
    ])
    const events = parseEvents(stdout)

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(events).toContainEqual({
      sessionId: 'pi-session',
      type: 'session.started',
      v: 1,
    })
    expect(events).toContainEqual({
      text: 'saw: inspect the parser',
      type: 'assistant.text',
      v: 1,
    })
    expect(events).toContainEqual({
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      costUsd: 0.02,
      cumulative: false,
      inputTokens: 11,
      outputTokens: 3,
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
    expect(argsEvent?.data.event.args).toEqual([
      '--provider',
      'ollama',
      '--model',
      'qwen3-coder',
      '--thinking',
      'high',
      '--no-tools',
      '--mode',
      'json',
      '--session',
      'pi-previous',
    ])
    expect(argsEvent?.data.event.args).not.toContain('inspect the parser')
  })

  test('normalizes OpenCode session, text, and usage events', async () => {
    const fixture = createFakeOpencode()
    const child = spawn(
      process.execPath,
      [
        'run',
        'src/main.ts',
        'run',
        'opencode',
        'ollama',
        'qwen3-coder',
        '--native-args-json',
        '["--pure"]',
        '--resume-session',
        'opencode-previous',
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
    child.stdin.end('review the adapter')

    const [exitCode, stderr, stdout] = await Promise.all([
      childExitCode(child),
      readStream(child.stderr),
      readStream(child.stdout),
    ])
    const events = parseEvents(stdout)

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(events).toContainEqual({
      sessionId: 'opencode-session',
      type: 'session.started',
      v: 1,
    })
    expect(events).toContainEqual({
      text: 'saw: review the adapter',
      type: 'assistant.text',
      v: 1,
    })
    expect(events).toContainEqual({
      cacheReadTokens: 4,
      cacheWriteTokens: 2,
      costUsd: 0.03,
      cumulative: false,
      inputTokens: 12,
      outputTokens: 5,
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
    expect(argsEvent?.data.event.args).toEqual([
      'run',
      '-m',
      'eh-ollama/qwen3-coder',
      '--pure',
      '--format',
      'json',
      '--session',
      'opencode-previous',
    ])
    expect(argsEvent?.data.event.args).not.toContain('review the adapter')
  })

  test.each([
    ['pi', createFakePi],
    ['opencode', createFakeOpencode],
  ] as const)(
    'converts a semantic %s failure into a non-zero wrapper exit',
    async (harness, createFixture) => {
      const fixture = createFixture()
      const child = spawn(
        process.execPath,
        ['run', 'src/main.ts', 'run', harness, 'ollama', 'qwen3-coder'],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            EH_TEST_HEADLESS_FAIL: '1',
            PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ''}`,
            PI_CODING_AGENT_DIR: fixture.configDir,
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
      const events = parseEvents(stdout)

      expect(exitCode).toBe(66)
      expect(events).toContainEqual({
        message: `expected ${harness} failure`,
        type: 'run.error',
        v: 1,
      })
      expect(events).toContainEqual({
        exitCode: 66,
        resultIsError: true,
        type: 'run.completed',
        v: 1,
      })
    },
  )

  test('flushes buffered Grok text when the stream ends', async () => {
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
    child.stdin.end('text only')

    const [exitCode, stdout] = await Promise.all([
      childExitCode(child),
      readStream(child.stdout),
      readStream(child.stderr),
    ])
    const events = parseEvents(stdout)
    const assistantTextIndex = events.findIndex(
      (event) => event.type === 'assistant.text',
    )
    const completedIndex = events.findIndex(
      (event) => event.type === 'run.completed',
    )

    expect(exitCode).toBe(0)
    expect(events.filter((event) => event.type === 'assistant.text')).toEqual([
      { text: 'saw: text only', type: 'assistant.text', v: 1 },
    ])
    expect(assistantTextIndex).toBeGreaterThan(-1)
    expect(completedIndex).toBeGreaterThan(assistantTextIndex)
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

    expect(exitCode).toBe(66)
    expect(events).toContainEqual({
      message: 'expected failure',
      type: 'run.error',
      v: 1,
    })
    expect(events).toContainEqual({
      exitCode: 66,
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

function asRecord(value: unknown) {
  const parsed = z.record(z.string(), z.unknown()).safeParse(value)
  return parsed.success ? parsed.data : undefined
}

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
emit({
  type: 'fake.args',
  args: process.argv.slice(2),
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,
})
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
emit({
  type: 'fake.args',
  args,
  grokApiKey: process.env.GROK_API_KEY,
  grokBaseUrl: process.env.GROK_BASE_URL,
  grokHome: process.env.GROK_HOME,
  grokHomeHasAuth: require('node:fs').existsSync(
    require('node:path').join(process.env.GROK_HOME ?? '', 'auth.json'),
  ),
  grokModelsBaseUrl: process.env.GROK_MODELS_BASE_URL,
  pid: process.pid,
  prompt,
  promptPath,
  xaiApiKey: process.env.XAI_API_KEY,
})
if (prompt === 'wait for signal') {
  setInterval(() => {}, 1000)
} else if (prompt === 'text only') {
  emit({ type: 'text', data: 'saw: ' })
  emit({ type: 'text', data: prompt })
} else {
emit({ type: 'text', data: 'saw: ' })
emit({ type: 'text', data: prompt })
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

function createFakeOpencode() {
  return createFakeHarness(
    'opencode',
    `const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const prompt = Buffer.concat(chunks).toString('utf8')
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n')
emit({
  type: 'fake.args',
  args: process.argv.slice(2),
  opencodeConfigContent: process.env.OPENCODE_CONFIG_CONTENT,
})
if (process.env.EH_TEST_HEADLESS_FAIL === '1') {
  emit({
    type: 'error',
    sessionID: 'opencode-session',
    error: { name: 'ProviderError', data: { message: 'expected opencode failure' } },
  })
  process.exit(0)
}
emit({
  type: 'step_start',
  sessionID: 'opencode-session',
  part: { type: 'step-start' },
})
emit({
  type: 'text',
  sessionID: 'opencode-session',
  part: { type: 'text', text: 'saw: ' + prompt },
})
emit({
  type: 'step_finish',
  sessionID: 'opencode-session',
  part: {
    type: 'step-finish',
    cost: 0.03,
    tokens: {
      input: 12,
      output: 5,
      cache: { read: 4, write: 2 },
    },
  },
})`,
  )
}

function createFakePi() {
  const fixture = createFakeHarness(
    'pi',
    `const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const prompt = Buffer.concat(chunks).toString('utf8')
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n')
emit({ type: 'session', id: 'pi-session', version: 3 })
emit({
  type: 'fake.args',
  args: process.argv.slice(2),
  piProxyUrl: process.env.EH_PI_PROXY_URL,
})
if (process.env.EH_TEST_HEADLESS_FAIL === '1') {
  emit({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'expected pi failure',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { total: 0 },
      },
    },
  })
  process.exit(0)
}
emit({
  type: 'message_end',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: 'saw: ' + prompt }],
    stopReason: 'stop',
    usage: {
      input: 11,
      output: 3,
      cacheRead: 2,
      cacheWrite: 1,
      cost: { total: 0.02 },
    },
  },
})`,
  )
  writeFileSync(
    path.join(fixture.configDir, 'models.json'),
    JSON.stringify({
      providers: {
        ollama: {
          api: 'openai-completions',
          apiKey: 'ollama',
          baseUrl: 'http://127.0.0.1:11434/v1',
          models: [{ id: 'qwen3-coder' }],
        },
      },
    }),
  )
  return fixture
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

async function startGatewayStub() {
  const server = createServer((request, response) => {
    if (request.url?.endsWith('/endpoints')) {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          data: { endpoints: [{ provider_name: 'bedrock', status: 0 }] },
        }),
      )
      return
    }
    response.statusCode = 500
    response.end('unexpected request')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Gateway stub did not bind a TCP port')
  }
  return {
    baseURL: `http://127.0.0.1:${String(address.port)}`,
    close: async () => {
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      })
      server.closeAllConnections()
      await closed
    },
  }
}
