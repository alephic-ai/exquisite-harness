import { expect, test } from 'bun:test'
import { createServer } from 'node:http'

import { fetchModelMeta } from './pricing.js'

test('reports the full active gateway rate range including context tiers', async () => {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.url === '/v1/models') {
      response.end(
        JSON.stringify({
          data: [
            {
              context_window: 1_000_000,
              id: 'test/model',
              pricing: { input: '0.000001', output: '0.000005' },
            },
          ],
        }),
      )
      return
    }
    response.end(
      JSON.stringify({
        data: {
          endpoints: [
            {
              pricing: {
                completion: '0.000005',
                completion_tiers: [
                  { cost: '0.000005', max: 200_001, min: 0 },
                  { cost: '0.000009', min: 200_001 },
                ],
                prompt: '0.000001',
                prompt_tiers: [
                  { cost: '0.000001', max: 200_001, min: 0 },
                  { cost: '0.000004', min: 200_001 },
                ],
              },
              provider_name: 'fireworks',
              status: 0,
            },
            {
              pricing: { completion: '0.000007', prompt: '0.000002' },
              provider_name: 'bedrock',
              status: 0,
            },
            {
              pricing: { completion: '0.9', prompt: '0.8' },
              provider_name: 'fireworks',
              status: 1,
            },
          ],
        },
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
    throw new Error('test pricing server did not bind a TCP port')
  }

  try {
    const provider = {
      baseURL: `http://127.0.0.1:${String(address.port)}`,
      name: 'test-gateway',
      type: 'vercel-gateway' as const,
    }
    const meta = await fetchModelMeta({
      modelId: 'test/model',
      provider,
    })
    expect(meta).toEqual({
      contextWindow: 1_000_000,
      rateLabel: '$1–4/$5–9',
      rates: {
        cacheReadPerMillion: undefined,
        cacheWritePerMillion: undefined,
        inputPerMillion: 1,
        outputPerMillion: 5,
      },
    })

    const pinnedMeta = await fetchModelMeta({
      gatewayProvider: 'bedrock',
      modelId: 'test/model',
      provider,
    })
    expect(pinnedMeta).toEqual({
      contextWindow: 1_000_000,
      rateLabel: '$2/$7',
      rates: {
        cacheReadPerMillion: undefined,
        cacheWritePerMillion: undefined,
        inputPerMillion: 1,
        outputPerMillion: 5,
      },
    })
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }
})

test('pins OpenRouter rate labels to the endpoint tag, not the display name', async () => {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.url === '/v1/models') {
      response.end(
        JSON.stringify({
          data: [
            {
              context_length: 200_000,
              id: 'anthropic/claude-sonnet-4.6',
              pricing: { completion: '0.000025', prompt: '0.000005' },
            },
          ],
        }),
      )
      return
    }
    response.end(
      JSON.stringify({
        data: {
          endpoints: [
            {
              pricing: { completion: '0.000025', prompt: '0.000005' },
              provider_name: 'Amazon Bedrock',
              status: 0,
              tag: 'amazon-bedrock/global',
            },
            {
              pricing: { completion: '0.00003', prompt: '0.000006' },
              provider_name: 'Anthropic',
              status: 0,
              tag: 'anthropic',
            },
          ],
        },
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
    throw new Error('test pricing server did not bind a TCP port')
  }

  try {
    const provider = {
      baseURL: `http://127.0.0.1:${String(address.port)}`,
      name: 'openrouter',
      type: 'openrouter' as const,
    }
    const pinned = await fetchModelMeta({
      gatewayProvider: 'amazon-bedrock',
      modelId: 'anthropic/claude-sonnet-4.6',
      provider,
    })
    expect(pinned.rateLabel).toBe('$5/$25')
    expect(pinned.contextWindow).toBe(200_000)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }
})
