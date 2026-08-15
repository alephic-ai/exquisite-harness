import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parse } from 'smol-toml'
import { z } from 'zod'

import { prepareGrokApiKeyHome } from './grok-home.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map(async (dir) => rm(dir, { force: true, recursive: true })),
  )
})

describe('prepareGrokApiKeyHome', () => {
  test('isolates session auth while preserving existing user state', async () => {
    const realHome = mkdtempSync(path.join(os.tmpdir(), 'eh-real-grok-'))
    tempDirs.push(realHome)
    mkdirSync(path.join(realHome, 'agents'), { recursive: true })
    mkdirSync(path.join(realHome, 'rules'), { recursive: true })
    mkdirSync(path.join(realHome, 'sessions'), { recursive: true })
    mkdirSync(path.join(realHome, 'skills'), { recursive: true })
    writeFileSync(path.join(realHome, 'agents', 'review.md'), 'agent')
    writeFileSync(path.join(realHome, 'rules', 'review.md'), 'rule')
    writeFileSync(path.join(realHome, 'auth.json'), '{"oauth":"secret"}', {
      mode: 0o600,
    })
    writeFileSync(
      path.join(realHome, 'config.toml'),
      '[ui]\nsimple_mode = true\n',
    )
    writeFileSync(path.join(realHome, 'trusted_folders.toml'), 'ok = true\n')

    const previous = process.env.GROK_HOME
    process.env.GROK_HOME = realHome
    try {
      const prepared = await prepareGrokApiKeyHome(
        'deepseek/deepseek-v4-flash-0731',
      )
      tempDirs.push(prepared.home)

      expect(prepared.home).not.toBe(realHome)
      expect(existsSync(path.join(prepared.home, 'auth.json'))).toBe(false)
      expect(readlinkSync(path.join(prepared.home, 'sessions'))).toBe(
        path.join(realHome, 'sessions'),
      )
      expect(readlinkSync(path.join(prepared.home, 'skills'))).toBe(
        path.join(realHome, 'skills'),
      )
      expect(
        readFileSync(path.join(prepared.home, 'agents', 'review.md'), 'utf8'),
      ).toBe('agent')
      expect(
        readFileSync(path.join(prepared.home, 'rules', 'review.md'), 'utf8'),
      ).toBe('rule')
      expect(
        readFileSync(path.join(prepared.home, 'trusted_folders.toml'), 'utf8'),
      ).toBe('ok = true\n')

      await prepared.cleanup()
      expect(existsSync(prepared.home)).toBe(false)
      // Real home (and its auth) is untouched.
      expect(await readFile(path.join(realHome, 'auth.json'), 'utf8')).toBe(
        '{"oauth":"secret"}',
      )
    } finally {
      if (previous === undefined) delete process.env.GROK_HOME
      else process.env.GROK_HOME = previous
    }
  })

  test('replaces existing selected-model routing and authentication', async () => {
    const realHome = await mkdtemp(path.join(os.tmpdir(), 'eh-real-grok-'))
    tempDirs.push(realHome)
    await writeFile(
      path.join(realHome, 'config.toml'),
      `[ui]
simple_mode = true

[model."vendor/model"]
model = "wrong-model"
base_url = "https://wrong.example/v1"
api_key = "wrong-key"
env_key = "WRONG_KEY"
auth_provider = "wrong-provider"
api_backend = "responses"
context_window = 128000

[model.other]
env_key = "OTHER_KEY"
`,
    )
    const previous = process.env.GROK_HOME
    process.env.GROK_HOME = realHome
    try {
      const prepared = await prepareGrokApiKeyHome('vendor/model')
      tempDirs.push(prepared.home)
      const config = z
        .object({
          model: z.record(z.string(), z.record(z.string(), z.unknown())),
          ui: z.object({ simple_mode: z.boolean() }),
        })
        .parse(
          parse(
            await readFile(path.join(prepared.home, 'config.toml'), 'utf8'),
          ),
        )

      expect(config.ui.simple_mode).toBe(true)
      expect(config.model['vendor/model']).toEqual({
        env_key: 'XAI_API_KEY',
      })
      expect(config.model.other).toEqual({ env_key: 'OTHER_KEY' })
      await prepared.cleanup()
    } finally {
      if (previous === undefined) delete process.env.GROK_HOME
      else process.env.GROK_HOME = previous
    }
  })

  test('lets Grok create its first persisted session', async () => {
    const realHome = await mkdtemp(path.join(os.tmpdir(), 'eh-real-grok-'))
    tempDirs.push(realHome)
    const previous = process.env.GROK_HOME
    process.env.GROK_HOME = realHome
    try {
      const prepared = await prepareGrokApiKeyHome('vendor/model')
      tempDirs.push(prepared.home)
      const sessionDir = path.join(
        prepared.home,
        'sessions',
        'encoded-cwd',
        'session-id',
      )
      await mkdir(sessionDir, { recursive: true })
      await writeFile(path.join(sessionDir, 'summary.json'), '{}')

      expect(
        await readFile(
          path.join(
            realHome,
            'sessions',
            'encoded-cwd',
            'session-id',
            'summary.json',
          ),
          'utf8',
        ),
      ).toBe('{}')
      await prepared.cleanup()
    } finally {
      if (previous === undefined) delete process.env.GROK_HOME
      else process.env.GROK_HOME = previous
    }
  })

  test('serializes quoted model ids as valid TOML keys', async () => {
    const realHome = await mkdtemp(path.join(os.tmpdir(), 'eh-real-grok-'))
    tempDirs.push(realHome)
    const previous = process.env.GROK_HOME
    process.env.GROK_HOME = realHome
    try {
      const model = 'vendor/"weird"/model'
      const prepared = await prepareGrokApiKeyHome(model)
      tempDirs.push(prepared.home)
      const config = z
        .object({
          model: z.record(z.string(), z.record(z.string(), z.unknown())),
        })
        .parse(
          parse(
            await readFile(path.join(prepared.home, 'config.toml'), 'utf8'),
          ),
        )

      expect(config.model[model]).toEqual({ env_key: 'XAI_API_KEY' })
      await prepared.cleanup()
    } finally {
      if (previous === undefined) delete process.env.GROK_HOME
      else process.env.GROK_HOME = previous
    }
  })
})
