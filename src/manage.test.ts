import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { Config } from './config.js'

import { profileRemove } from './manage.js'

function buildConfig() {
  return {
    defaultApprovalMode: 'platform',
    profiles: {
      work: {
        harness: 'codex',
        model: 'gpt-5.6',
        provider: 'openai-chat',
      },
    },
    providers: {} as Config['providers'],
    recent: [] as Config['recent'],
    searchProviders: {} as Config['searchProviders'],
    version: 1,
  } satisfies Config
}

// profileRemove persists through saveConfig, which writes to configPath().
// Point XDG_CONFIG_HOME at a scratch dir so tests never touch the real
// ~/.config/eh — including the buggy run of the prototype-name test, which
// reaches saveConfig.
function withScratchConfig<T>(run: (root: string) => T) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'eh-manage-test-'))
  const previous = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = root
  try {
    return run(root)
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous
    rmSync(root, { force: true, recursive: true })
  }
}

describe('profile remove', () => {
  test('removes an existing profile and persists the change', () => {
    withScratchConfig((root) => {
      profileRemove(buildConfig(), 'work')
      const saved: unknown = JSON.parse(
        readFileSync(path.join(root, 'eh', 'config.json'), 'utf8'),
      )
      expect(saved).toHaveProperty('version', 1)
      expect(saved).toHaveProperty('profiles', {})
    })
  })

  test('refuses a profile that does not exist', () => {
    expect(() => profileRemove(buildConfig(), 'nope')).toThrow(
      'no profile named "nope"',
    )
  })

  test('refuses prototype names instead of false-success', () => {
    withScratchConfig(() => {
      expect(() => profileRemove(buildConfig(), 'constructor')).toThrow(
        'no profile named "constructor"',
      )
      expect(() => profileRemove(buildConfig(), 'toString')).toThrow(
        'no profile named "toString"',
      )
    })
  })
})
