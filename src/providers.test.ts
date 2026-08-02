import { expect, test } from 'bun:test'
import { createServer } from 'node:http'

import { listModels } from './providers.js'

test('preserves exact per-model effort options from OpenRouter and Vercel catalogs', async () => {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(
      JSON.stringify({
        data: [
          {
            context_window: 200_000,
            id: 'vercel/reasoning-model',
            reasoning_options: [
              { type: 'toggle' },
              {
                type: 'effort',
                values: ['high', 'minimal', 'future-level'],
              },
            ],
          },
          {
            context_length: 1_000_000,
            id: 'openrouter/reasoning-model',
            reasoning: {
              default_effort: 'high',
              supported_efforts: ['max', 'high', 'low'],
            },
          },
          {
            id: 'provider/non-reasoning-model',
          },
          {
            id: 'openrouter/all-gateway-efforts',
            reasoning: { supported_efforts: null },
          },
        ],
      }),
    )
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('test model server did not bind a TCP port')
  }

  try {
    const models = await listModels({
      baseURL: `http://127.0.0.1:${String(address.port)}`,
      name: 'test-provider',
      type: 'openai-chat',
    })

    expect(models).toEqual([
      {
        efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
        id: 'openrouter/all-gateway-efforts',
      },
      {
        efforts: ['low', 'high', 'max'],
        hint: '977k ctx',
        id: 'openrouter/reasoning-model',
      },
      { id: 'provider/non-reasoning-model' },
      {
        efforts: ['minimal', 'high'],
        hint: '195k ctx',
        id: 'vercel/reasoning-model',
      },
    ])
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }
})
