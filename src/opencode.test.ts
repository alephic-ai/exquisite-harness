import { describe, expect, test } from 'bun:test'
import { createServer } from 'node:http'
import { z } from 'zod'

import type { ResolvedProvider } from './config.js'

import { buildLaunchPlan } from './harnesses.js'
import { opencodeConfigContent } from './opencode.js'

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

// The contract opencode (and these tests) rely on. Strict: an unexpected key
// (e.g. a context-only `limit`, which opencode rejects) fails the parse.
const configSchema = z.object({
  provider: z.record(
    z.string(),
    z.object({
      models: z.record(
        z.string(),
        z
          .object({
            cost: z
              .object({
                cache_read: z.number().optional(),
                cache_write: z.number().optional(),
                input: z.number(),
                output: z.number(),
              })
              .optional(),
            name: z.string(),
          })
          .strict(),
      ),
      name: z.string(),
      npm: z.string(),
      options: z.object({ apiKey: z.string(), baseURL: z.string() }),
    }),
  ),
})

function buildConfig(provider: ResolvedProvider, model: string) {
  return configSchema.parse(
    JSON.parse(opencodeConfigContent(provider, model, undefined)),
  )
}

describe('opencodeConfigContent', () => {
  // The payload rides in OPENCODE_CONFIG_CONTENT (env) and shows up in
  // --print-env, so it must reference keys by env var — never carry one.
  test('references the key by env var, never a literal value', () => {
    const config = buildConfig(openrouter, 'anthropic/claude-fable-5')
    const entry = config.provider['eh-openrouter']
    expect(entry.npm).toBe('@ai-sdk/openai-compatible')
    expect(entry.options.apiKey).toBe('{env:OPENROUTER_API_KEY}')
    expect(entry.options.baseURL).toBe('https://openrouter.ai/api/v1')
    expect(entry.models['anthropic/claude-fable-5'].name).toBe(
      'anthropic/claude-fable-5',
    )
  })

  test('keyless providers get a placeholder key', () => {
    const config = buildConfig(ollama, 'qwen3.5:latest')
    expect(config.provider['eh-ollama'].options.apiKey).toBe('eh')
  })

  test('omits cost when provider rates are unavailable', () => {
    const config = buildConfig(openrouter, 'anthropic/claude-fable-5')
    expect(
      config.provider['eh-openrouter'].models['anthropic/claude-fable-5'].cost,
    ).toBeUndefined()
  })

  test('includes provider rates in the model config', async () => {
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.url === '/v1/models') {
        response.end(
          JSON.stringify({
            data: [
              {
                id: 'test/model',
                pricing: {
                  cacheCreationInputTokens: '0.00000075',
                  cachedInputTokens: '0.0000005',
                  input: '0.000001',
                  output: '0.000005',
                },
              },
            ],
          }),
        )
        return
      }
      response.end(JSON.stringify({ data: { endpoints: [] } }))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      server.close()
      throw new Error('test pricing server did not bind a TCP port')
    }

    try {
      const provider = {
        baseURL: `http://127.0.0.1:${String(address.port)}`,
        name: 'test-gateway',
        type: 'vercel-gateway' as const,
      }
      const plan = await buildLaunchPlan('opencode', provider, 'test/model')
      const config = configSchema.parse(
        JSON.parse(plan.env.OPENCODE_CONFIG_CONTENT),
      )

      expect(
        config.provider['eh-test-gateway'].models['test/model'].cost,
      ).toEqual({ cache_read: 0.5, cache_write: 0.75, input: 1, output: 5 })
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      })
    }
  })
})
