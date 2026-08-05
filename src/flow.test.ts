import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dir, '..')
const tempDirs: string[] = []

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true })
})

describe('profile Gateway routing', () => {
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

function runProfile(options: { model?: string; provider?: string }) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'eh-flow-test-'))
  tempDirs.push(root)
  const configDir = path.join(root, 'xdg', 'eh')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({
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
