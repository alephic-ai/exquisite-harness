import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dir, '..')
const tempDirs: string[] = []

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true })
})

// A flag and a positional naming the same slot must error instead of the flag
// silently winning: commander fills positionals left-to-right, so
// `eh claude -p ollama qwen3-coder` used to drop the model and open a picker.
describe('root command slot conflicts', () => {
  test('harness flag plus positional errors', () => {
    const result = runMain([
      '--print-env',
      '--harness',
      'codex',
      'claude',
      'ollama',
      'qwen3-coder',
    ])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('harness specified twice')
  })

  test('provider flag plus positional errors', () => {
    const result = runMain([
      '--print-env',
      'codex',
      'openrouter',
      '-p',
      'ollama',
      'qwen3-coder',
    ])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('provider specified twice')
  })

  test('model flag plus positional errors', () => {
    const result = runMain([
      '--print-env',
      'codex',
      'ollama',
      'qwen3-coder',
      '-m',
      'qwen3.5-coder',
    ])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('model specified twice')
  })

  test('flags without positionals still launch', () => {
    const result = runMain([
      '--print-env',
      '--harness',
      'codex',
      '-p',
      'ollama',
      '-m',
      'qwen3-coder',
    ])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('model="qwen3-coder"')
  })
})

// main.ts self-executes parseAsync at import, so the only safe boundary is
// spawning the CLI. --print-env keeps every shape non-interactive.
function runMain(args: string[]) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'eh-main-test-'))
  tempDirs.push(root)
  const result = spawnSync(process.execPath, ['run', 'src/main.ts', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      XDG_CONFIG_HOME: path.join(root, 'xdg'),
    },
    timeout: 30_000,
  })
  return {
    exitCode: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  }
}
