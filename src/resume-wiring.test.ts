import { describe, expect, test } from 'bun:test'

import { resolveResumeWiring } from './resume-wiring.js'

describe('resolveResumeWiring', () => {
  test('uses the selected provider recent when another provider ran the source model', () => {
    const result = resolveResumeWiring({
      config: {
        profiles: {},
        providers: {},
        recent: [
          {
            cwd: process.cwd(),
            harness: 'codex',
            model: 'source-model',
            provider: 'openrouter',
            usedAt: '2026-07-24T20:00:00.000Z',
          },
          {
            cwd: process.cwd(),
            harness: 'codex',
            model: 'target-model',
            provider: 'ollama',
            usedAt: '2026-07-24T19:00:00.000Z',
          },
        ],
        version: 1,
      },
      selection: { harness: 'codex', provider: 'ollama' },
      session: {
        harness: 'claude',
        id: 'session-id',
        model: 'source-model',
        source: '/tmp/session.jsonl',
        title: 'source session',
        updatedAt: '2026-07-24T18:00:00.000Z',
      },
    })

    expect(result.provider).toBe('ollama')
    expect(result.model).toBe('target-model')
  })

  test('does not carry a foreign model when the selected provider has no recent', () => {
    const result = resolveResumeWiring({
      config: {
        profiles: {},
        providers: {},
        recent: [
          {
            cwd: process.cwd(),
            harness: 'codex',
            model: 'source-model',
            provider: 'openrouter',
            usedAt: '2026-07-24T20:00:00.000Z',
          },
        ],
        version: 1,
      },
      selection: { harness: 'codex', provider: 'ollama' },
      session: {
        harness: 'claude',
        id: 'session-id',
        model: 'source-model',
        source: '/tmp/session.jsonl',
        title: 'source session',
        updatedAt: '2026-07-24T18:00:00.000Z',
      },
    })

    expect(result.provider).toBe('ollama')
    expect(result.model).toBeUndefined()
  })
})
