import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { Config } from './config.js'

import {
  searchProviderForSelection,
  withDefaultSearchProvider,
} from './config.js'

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
})

function buildConfig(defaultSearchProvider?: string) {
  return {
    ...(defaultSearchProvider ? { defaultSearchProvider } : {}),
    profiles: {} as Config['profiles'],
    providers: {} as Config['providers'],
    recent: [] as Config['recent'],
    searchProviders: {} as Config['searchProviders'],
    version: 1,
  } satisfies Config
}
