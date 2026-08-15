import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dir, '..')
const tempDirs: string[] = []

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true })
})

describe('profile Gateway routing', () => {
  test('applies the current approval default without storing it in the profile', () => {
    const result = runProfile({ approvalMode: 'auto' })

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('--approve-for-me')
  })

  test('keeps the saved provider pin when the model is unchanged', () => {
    const result = runProfile({})

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('# gateway provider: fireworks')
  })

  test('keeps the pin for explicit unchanged provider and model overrides', () => {
    const result = runProfile({
      model: 'moonshotai/kimi-k3-fast',
      provider: 'vercel-ai-gateway',
    })

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('# gateway provider: fireworks')
  })

  test('drops the saved provider pin when the model is overridden', () => {
    const result = runProfile({ model: 'alibaba/qwen3.7-plus' })

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).not.toContain('# gateway provider:')
    expect(result.stdout).toContain('model="alibaba/qwen3.7-plus"')
  })

  test('drops the saved pin when the provider is overridden', () => {
    const result = runProfile({
      model: 'moonshotai/kimi-k3-fast',
      provider: 'ollama',
    })

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).not.toContain('# gateway provider:')
    expect(result.stdout).toContain('base_url="http://localhost:11434/v1"')
  })
})

describe('--print-env temporary launch artifacts', () => {
  test('rejects Grok exports and removes the isolated home', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'eh-flow-test-'))
    tempDirs.push(root)
    const grokHome = path.join(root, 'grok')
    const processTemp = path.join(root, 'tmp')
    mkdirSync(grokHome, { recursive: true })
    mkdirSync(processTemp, { recursive: true })

    const result = spawnSync(
      process.execPath,
      ['run', 'src/main.ts', '--print-env', 'grok', 'ollama', 'qwen3-coder'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          GROK_HOME: grokHome,
          TMPDIR: processTemp,
          XDG_CONFIG_HOME: path.join(root, 'xdg'),
        },
      },
    )

    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(
      '--print-env cannot expose temporary launch artifacts — launch through eh instead',
    )
    expect(readdirSync(processTemp)).toEqual([])
  })
})

function runProfile(options: {
  approvalMode?: 'auto' | 'platform'
  model?: string
  provider?: string
}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'eh-flow-test-'))
  tempDirs.push(root)
  const configDir = path.join(root, 'xdg', 'eh')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({
      ...(options.approvalMode
        ? { defaultApprovalMode: options.approvalMode }
        : {}),
      profiles: {
        'gateway-fireworks': {
          gatewayProvider: 'fireworks',
          harness: 'codex',
          model: 'moonshotai/kimi-k3-fast',
          provider: 'vercel-ai-gateway',
        },
      },
      providers: {},
      recent: [],
      version: 1,
    }),
  )
  const args = ['run', 'src/main.ts', 'gateway-fireworks', '--print-env']
  if (options.provider) args.push('--provider', options.provider)
  if (options.model) args.push('--model', options.model)
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      AI_GATEWAY_API_KEY: 'test-key',
      XDG_CONFIG_HOME: path.join(root, 'xdg'),
    },
  })
  return {
    exitCode: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  }
}
