import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The keys module shells out to platform credential stores (macOS
// `security`, Linux `secret-tool`). Pointing PATH at a directory with no
// binaries makes every backend unusable, so each test exercises the file
// store deterministically on any platform.
function runKeysScript(
  body: string,
  directory: string,
  extraEnv: Record<string, string> = {},
) {
  const moduleURL = new URL('./keys.ts', import.meta.url).href
  return spawnSync(
    process.execPath,
    ['-e', `import * as keys from ${JSON.stringify(moduleURL)}; ${body}`],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: path.join(directory, 'no-bin'),
        XDG_CONFIG_HOME: directory,
        ...extraEnv,
      },
    },
  )
}

function writeSecretsFile(directory: string, contents: string) {
  const configDirectory = path.join(directory, 'eh')
  mkdirSync(configDirectory, { recursive: true })
  const file = path.join(configDirectory, 'secrets.json')
  writeFileSync(file, contents)
  return file
}

describe('file-backed secrets store', () => {
  test('storeApiKey merges into a valid secrets file and leaves no temp files', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'eh-keys-test-'))
    try {
      const secretsFile = writeSecretsFile(directory, '{"other":"keep"}')

      const result = runKeysScript(
        `keys.storeApiKey('ollama', 'v').then((source) => console.log(source))`,
        directory,
      )

      expect(result.status).toBe(0)
      expect(result.stdout.trim()).toBe('file')
      expect(JSON.parse(readFileSync(secretsFile, 'utf8'))).toEqual({
        ollama: 'v',
        other: 'keep',
      })
      expect(readdirSync(path.dirname(secretsFile))).toEqual(['secrets.json'])
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  test('storeApiKey refuses to overwrite an unparseable secrets file', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'eh-keys-test-'))
    try {
      const secretsFile = writeSecretsFile(directory, '{"ollama": ')

      const result = runKeysScript(
        `keys.storeApiKey('ollama', 'v').then((source) => console.log(source), (error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1) })`,
        directory,
      )

      expect(result.status).toBe(1)
      expect(result.stderr).toContain(
        'refusing to overwrite unreadable secrets',
      )
      expect(readFileSync(secretsFile, 'utf8')).toBe('{"ollama": ')
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  test('storeApiKey refuses to overwrite a schema-invalid secrets file', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'eh-keys-test-'))
    try {
      const secretsFile = writeSecretsFile(directory, '{"ollama": 123}')

      const result = runKeysScript(
        `keys.storeApiKey('ollama', 'v').then((source) => console.log(source), (error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1) })`,
        directory,
      )

      expect(result.status).toBe(1)
      expect(result.stderr).toContain(
        'refusing to overwrite unreadable secrets',
      )
      expect(readFileSync(secretsFile, 'utf8')).toBe('{"ollama": 123}')
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  test('resolveApiKey stays best-effort when the secrets file is corrupt', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'eh-keys-test-'))
    try {
      writeSecretsFile(directory, '{"ollama": ')

      const fromEnv = runKeysScript(
        `keys.resolveApiKey('EH_TEST_KEY', 'ollama').then((key) => console.log(key.source))`,
        directory,
        { EH_TEST_KEY: 'v' },
      )
      expect(fromEnv.status).toBe(0)
      expect(fromEnv.stdout.trim()).toBe('env')

      const fromNothing = runKeysScript(
        `keys.resolveApiKey(undefined, 'ollama').then((key) => console.log(key.source))`,
        directory,
      )
      expect(fromNothing.status).toBe(0)
      expect(fromNothing.stdout.trim()).toBe('none')
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })
})
