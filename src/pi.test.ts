import { describe, expect, test } from 'bun:test'

import type { ResolvedProvider } from './config.js'

import { parsePiModelsJson } from './pi-models-json.js'
import { matchPiProvider } from './pi.js'

const ollama: ResolvedProvider = {
  baseURL: 'http://localhost:11434',
  name: 'ollama',
  type: 'ollama',
}

const openrouter: ResolvedProvider = {
  baseURL: 'https://openrouter.ai/api/v1',
  envKey: 'OPENROUTER_API_KEY',
  name: 'openrouter',
  type: 'openai-chat',
}

const gateway: ResolvedProvider = {
  baseURL: 'https://ai-gateway.vercel.sh/v1',
  envKey: 'AI_GATEWAY_API_KEY',
  name: 'vercel-ai-gateway',
  type: 'vercel-gateway',
}

const noCustom = { providers: {} }

function customPiProvider(baseUrl: string, apiKey = 'local') {
  return {
    api: 'openai-completions',
    apiKey,
    baseUrl,
    models: [{ id: 'qwen3-coder' }],
  }
}

describe('matchPiProvider', () => {
  test('maps built-in providers to their native pi ids and key env vars', () => {
    expect(matchPiProvider(noCustom, openrouter)).toEqual({
      keyEnvVar: 'OPENROUTER_API_KEY',
      piName: 'openrouter',
    })
    expect(matchPiProvider(noCustom, gateway)).toEqual({
      keyEnvVar: 'AI_GATEWAY_API_KEY',
      piName: 'vercel-ai-gateway',
    })
  })

  test('skips the native map when the baseURL was repointed', () => {
    const proxied: ResolvedProvider = {
      ...openrouter,
      baseURL: 'https://proxy.corp.example/v1',
    }
    expect(matchPiProvider(noCustom, proxied)).toBeUndefined()
  })

  test('lets a same-id models.json entry override native authentication', () => {
    expect(
      matchPiProvider(
        {
          providers: {
            openrouter: { apiKey: '$CUSTOM_AI_KEY' },
          },
        },
        openrouter,
      ),
    ).toEqual({
      keyEnvVar: 'CUSTOM_AI_KEY',
      piName: 'openrouter',
    })
  })

  test('matches a models.json entry by baseUrl (loopback, /v1 insensitive)', () => {
    const modelsJson = {
      providers: {
        ollama: customPiProvider('http://127.0.0.1:11434/v1', 'ollama'),
      },
    }
    // Literal apiKey → pi already has it; nothing for eh to inject.
    expect(matchPiProvider(modelsJson, ollama)).toEqual({
      keyEnvVar: undefined,
      piName: 'ollama',
    })
  })

  // eh's ollama default is localhost:11434; entries spell it every way.
  test.each([
    'http://127.0.0.1:11434',
    'http://127.0.0.1:11434/v1',
    'http://localhost:11434/',
    'http://localhost:11434/v1/',
  ])('entry with baseUrl %s matches', (baseUrl) => {
    expect(
      matchPiProvider({ providers: { x: customPiProvider(baseUrl) } }, ollama),
    ).toEqual({ keyEnvVar: undefined, piName: 'x' })
  })

  test.each(['http://127.0.0.1:11435', 'https://other.example/v1'])(
    'entry with baseUrl %s does not match',
    (baseUrl) => {
      expect(
        matchPiProvider(
          { providers: { x: customPiProvider(baseUrl) } },
          ollama,
        ),
      ).toBeUndefined()
    },
  )

  test.each([
    ['http://example.com', 'http://example.com:80'],
    ['https://example.com', 'https://example.com:443/'],
  ])('default ports are equivalent: %s ≡ %s', (providerBase, entryBase) => {
    const provider: ResolvedProvider = {
      baseURL: providerBase,
      name: 'custom',
      type: 'openai-chat',
    }
    expect(
      matchPiProvider(
        { providers: { x: customPiProvider(entryBase) } },
        provider,
      ),
    ).toEqual({ keyEnvVar: undefined, piName: 'x' })
  })

  test('rejects a custom provider that pi cannot load', () => {
    expect(
      matchPiProvider(
        {
          providers: {
            ollama: { baseUrl: 'http://127.0.0.1:11434/v1' },
          },
        },
        ollama,
      ),
    ).toBeUndefined()
  })

  test('rejects a custom provider without configured request authentication', () => {
    expect(
      matchPiProvider(
        {
          providers: {
            ollama: {
              api: 'openai-completions',
              baseUrl: 'http://127.0.0.1:11434/v1',
              models: [{ id: 'qwen3-coder' }],
            },
          },
        },
        ollama,
      ),
    ).toBeUndefined()
  })

  test('prefers an exact provider name when base URLs collide', () => {
    expect(
      matchPiProvider(
        {
          providers: Object.fromEntries([
            [
              'other',
              customPiProvider('http://127.0.0.1:11434/v1', '$OTHER_KEY'),
            ],
            [
              'ollama',
              customPiProvider('http://127.0.0.1:11434/v1', '$OLLAMA_KEY'),
            ],
          ]),
        },
        ollama,
      ),
    ).toEqual({ keyEnvVar: 'OLLAMA_KEY', piName: 'ollama' })
  })

  test('rejects an ambiguous base URL match', () => {
    const provider: ResolvedProvider = {
      baseURL: 'http://localhost:11434',
      name: 'custom',
      type: 'openai-chat',
    }

    expect(
      matchPiProvider(
        {
          providers: {
            first: customPiProvider('http://127.0.0.1:11434/v1', '$FIRST_KEY'),
            second: customPiProvider(
              'http://127.0.0.1:11434/v1',
              '$SECOND_KEY',
            ),
          },
        },
        provider,
      ),
    ).toBeUndefined()
  })

  test('parses comments in models.json before matching providers', () => {
    const modelsJson = parsePiModelsJson(`{
      // Pi accepts comments in this file.
      "providers": {
        "ollama": {
          "api": "openai-completions",
          "apiKey": "ollama",
          "baseUrl": "http://127.0.0.1:11434/v1",
          "models": [{ "id": "qwen3-coder" }]
        }
      }
    }`)

    expect(modelsJson).toBeDefined()
    expect(matchPiProvider(modelsJson ?? noCustom, ollama)).toEqual({
      keyEnvVar: undefined,
      piName: 'ollama',
    })
  })

  test('parses trailing commas in models.json', () => {
    const modelsJson = parsePiModelsJson(`{
      "providers": {
        "ollama": {
          "api": "openai-completions",
          "apiKey": "ollama",
          "baseUrl": "http://127.0.0.1:11434/v1",
          "models": [{ "id": "qwen3-coder" }],
        },
      },
    }`)

    expect(modelsJson).toBeDefined()
    expect(matchPiProvider(modelsJson ?? noCustom, ollama)).toEqual({
      keyEnvVar: undefined,
      piName: 'ollama',
    })
  })

  test.each([
    ['$CUSTOM_AI_KEY', 'CUSTOM_AI_KEY'],
    [`\${CUSTOM_AI_KEY}`, 'CUSTOM_AI_KEY'],
    [`\${KEY_PREFIX}_\${KEY_SUFFIX}`, undefined],
    ['$$literal-dollar-prefix', undefined],
    ['literal-key', undefined],
    ['!security find-generic-password', undefined],
  ])(
    'extracts an env var only from an exact reference: %s',
    (apiKey, keyEnvVar) => {
      const modelsJson = {
        providers: {
          custom: customPiProvider('http://127.0.0.1:11434/v1', apiKey),
        },
      }
      expect(matchPiProvider(modelsJson, ollama)).toEqual({
        keyEnvVar,
        piName: 'custom',
      })
    },
  )

  test('returns undefined when nothing matches', () => {
    expect(matchPiProvider(noCustom, ollama)).toBeUndefined()
  })
})
