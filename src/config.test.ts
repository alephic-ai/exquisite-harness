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
import { fileURLToPath } from 'node:url'

import type { Config } from './config.js'

import {
  pushRecent,
  reservedProfileNameMessage,
  searchProviderForSelection,
  withDefaultSearchProvider,
} from './config.js'
import { selectionFromRecent } from './ui/home.js'

describe('search provider defaults', () => {
  test('resolves explicit selection, Claude default, and non-Claude fallback', () => {
    const config = buildConfig('firecrawl')

    expect(
      searchProviderForSelection(config, {
        harness: 'claude',
        searchProvider: 'native',
      }),
    ).toBe('native')
    expect(searchProviderForSelection(config, { harness: 'claude' })).toBe(
      'firecrawl',
    )
    expect(searchProviderForSelection(config, { harness: 'codex' })).toBe(
      'native',
    )
  })

  test('retargets recent shortcuts without rewriting saved profiles', () => {
    const config = buildConfig('native')
    config.profiles.pinned = {
      harness: 'claude',
      model: 'qwen3-coder',
      provider: 'ollama',
      searchProvider: 'native',
    }
    config.recent = [
      {
        ...config.profiles.pinned,
        usedAt: '2026-07-31T20:09:24.220Z',
      },
    ]

    const next = withDefaultSearchProvider(config, 'firecrawl')

    expect(next.defaultSearchProvider).toBe('firecrawl')
    expect(next.recent[0]?.searchProvider).toBe('firecrawl')
    expect(next.profiles.pinned.searchProvider).toBe('native')
  })

  test('deduplicates shortcuts that collapse when the default changes', () => {
    const config = buildConfig('native')
    const selection = {
      harness: 'claude',
      model: 'qwen3-coder',
      provider: 'ollama',
    }
    config.recent = [
      {
        ...selection,
        searchProvider: 'native',
        usedAt: '2026-07-31T20:10:00.000Z',
      },
      {
        ...selection,
        searchProvider: 'firecrawl',
        usedAt: '2026-07-31T20:09:00.000Z',
      },
    ]

    const next = withDefaultSearchProvider(config, 'firecrawl')

    expect(next.recent).toHaveLength(1)
    expect(next.recent[0]?.usedAt).toBe('2026-07-31T20:10:00.000Z')
    expect(next.recent[0]?.searchProvider).toBe('firecrawl')
  })

  test('legacy recent inherits the configured search default', () => {
    const config = buildConfig('firecrawl')
    const recent = {
      harness: 'claude',
      model: 'qwen3-coder',
      provider: 'ollama',
      usedAt: '2026-07-31T20:09:24.220Z',
    }

    const provider = selectionFromRecent(config, recent).searchProvider

    expect(provider).toBe('firecrawl')
  })

  test('new launch replaces a legacy shortcut using the configured default', () => {
    const config = buildConfig('firecrawl')
    config.recent = [
      {
        harness: 'claude',
        model: 'qwen3-coder',
        provider: 'ollama',
        usedAt: '2026-07-31T20:09:24.220Z',
      },
    ]

    const next = pushRecent(config, {
      harness: 'claude',
      model: 'qwen3-coder',
      provider: 'ollama',
      searchProvider: 'firecrawl',
    })

    expect(next.recent).toHaveLength(1)
  })

  test('loading config preserves an explicit recent search choice', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'eh-config-test-'))
    try {
      const config = buildConfig('firecrawl')
      config.recent = [
        {
          harness: 'claude',
          model: 'qwen3-coder',
          provider: 'ollama',
          searchProvider: 'native',
          usedAt: '2026-07-31T20:09:24.220Z',
        },
      ]
      const configDirectory = path.join(directory, 'eh')
      mkdirSync(configDirectory)
      writeFileSync(
        path.join(configDirectory, 'config.json'),
        `${JSON.stringify(config)}\n`,
      )

      const moduleURL = new URL('./config.ts', import.meta.url).href
      const result = spawnSync(
        process.execPath,
        [
          '-e',
          `import { loadConfig } from ${JSON.stringify(moduleURL)}; console.log(loadConfig().recent[0]?.searchProvider)`,
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, XDG_CONFIG_HOME: directory },
        },
      )

      expect(result.status).toBe(0)
      expect(result.stdout.trim()).toBe('native')
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  test('profile save pins the effective provider from a legacy recent', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'eh-profile-test-'))
    try {
      const config = buildConfig('firecrawl')
      config.recent = [
        {
          harness: 'claude',
          model: 'qwen3-coder',
          provider: 'ollama',
          usedAt: '2026-07-31T20:09:24.220Z',
        },
      ]
      const configDirectory = path.join(directory, 'eh')
      const configFile = path.join(configDirectory, 'config.json')
      mkdirSync(configDirectory)
      writeFileSync(configFile, `${JSON.stringify(config)}\n`)

      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('./main.ts', import.meta.url)),
          'profile',
          'save',
          'legacy',
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, XDG_CONFIG_HOME: directory },
        },
      )
      const saved: unknown = JSON.parse(readFileSync(configFile, 'utf8'))

      expect(result.status).toBe(0)
      expect(saved).toHaveProperty(
        'profiles.legacy.searchProvider',
        'firecrawl',
      )
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })
})

test('legacy config defaults approvals to the platform behavior', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'eh-config-test-'))
  try {
    const configDirectory = path.join(directory, 'eh')
    mkdirSync(configDirectory)
    writeFileSync(
      path.join(configDirectory, 'config.json'),
      `${JSON.stringify({ version: 1 })}\n`,
    )

    const moduleURL = new URL('./config.ts', import.meta.url).href
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `import { loadConfig } from ${JSON.stringify(moduleURL)}; console.log(loadConfig().defaultApprovalMode)`,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, XDG_CONFIG_HOME: directory },
      },
    )

    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('platform')
  } finally {
    rmSync(directory, { force: true, recursive: true })
  }
})

test('saveConfig round-trips and leaves no staged temp files', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'eh-config-test-'))
  try {
    const moduleURL = new URL('./config.ts', import.meta.url).href
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `import { loadConfig, saveConfig } from ${JSON.stringify(moduleURL)}; const config = loadConfig(); config.profiles.pinned = { harness: 'claude', model: 'qwen3-coder', provider: 'ollama' }; saveConfig(config); console.log(loadConfig().profiles.pinned?.model)`,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, XDG_CONFIG_HOME: directory },
      },
    )

    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('qwen3-coder')
    expect(readdirSync(path.join(directory, 'eh'))).toEqual(['config.json'])
  } finally {
    rmSync(directory, { force: true, recursive: true })
  }
})

function buildConfig(defaultSearchProvider?: string) {
  return {
    defaultApprovalMode: 'platform',
    ...(defaultSearchProvider ? { defaultSearchProvider } : {}),
    profiles: {} as Config['profiles'],
    providers: {} as Config['providers'],
    recent: [] as Config['recent'],
    searchProviders: {} as Config['searchProviders'],
    version: 1,
  } satisfies Config
}

test('run is a reserved profile name', () => {
  expect(reservedProfileNameMessage('run')).toBe(
    '"run" is a subcommand — pick another profile name',
  )
})
