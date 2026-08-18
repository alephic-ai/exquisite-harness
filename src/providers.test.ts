import type { RequestListener } from 'node:http'

import { expect, test } from 'bun:test'
import { createServer } from 'node:http'

import {
  fetchGatewayModelThroughput,
  listGatewayProviders,
  listModels,
} from './providers.js'

test('lists active Gateway providers with cost and throughput', async () => {
  let requestedPath = ''
  const upstream = await startUpstream((request, response) => {
    requestedPath = request.url ?? ''
    response.setHeader('content-type', 'application/json')
    response.end(
      JSON.stringify({
        data: {
          endpoints: [
            {
              pricing: { completion: '0.0000004', prompt: '0.0000002' },
              provider_name: 'bedrock',
              status: 0,
              throughput_last_1h: { p50: 148 },
            },
            { provider_name: 'anthropic', status: 1 },
            {
              pricing: { completion: '0.0000004', prompt: '0.0000002' },
              provider_name: 'bedrock',
              status: 0,
              throughput_last_1h: { p50: 148 },
            },
            { provider_name: 'vertex' },
          ],
        },
      }),
    )
  })

  try {
    const providers = await listGatewayProviders(
      {
        baseURL: `${upstream.baseURL}/gateway`,
        name: 'test-gateway',
        type: 'vercel-gateway',
      },
      'anthropic/model with spaces',
    )

    expect(providers.map((p) => p.name)).toEqual(['bedrock', 'vertex'])
    expect(providers[0]?.costInputPerMillion).toBeCloseTo(0.2, 6)
    expect(providers[0]?.costOutputPerMillion).toBeCloseTo(0.4, 6)
    expect(providers[0]?.throughputTokensPerSec).toBe(148)
    expect(providers[1]).toEqual({
      costInputPerMillion: undefined,
      costOutputPerMillion: undefined,
      name: 'vertex',
      throughputTokensPerSec: undefined,
    })
    expect(requestedPath).toBe(
      '/gateway/v1/models/anthropic/model%20with%20spaces/endpoints',
    )
  } finally {
    await upstream.close()
  }
})

test('lists Gateway models with cost and context hints (throughput is lazy)', async () => {
  const upstream = await startUpstream((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(
      JSON.stringify({
        data: [
          {
            context_window: 1_000_000,
            id: 'anthropic/claude-sonnet-4.6',
            pricing: { input: '0.000003', output: '0.000015' },
          },
          {
            context_window: 40960,
            id: 'openai/gpt-5',
            pricing: { input: '0.000001', output: '0.000004' },
          },
        ],
      }),
    )
  })

  try {
    const models = await listModels({
      baseURL: `${upstream.baseURL}/gateway`,
      name: 'test-gateway',
      type: 'vercel-gateway',
    })
    expect(models).toEqual([
      {
        costLabel: '$3/$15',
        hint: '977k ctx',
        id: 'anthropic/claude-sonnet-4.6',
      },
      {
        costLabel: '$1/$4',
        hint: '40k ctx',
        id: 'openai/gpt-5',
      },
    ])
  } finally {
    await upstream.close()
  }
})

test('tolerates endpoints whose throughput_last_1h is null', async () => {
  const upstream = await startUpstream((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(
      JSON.stringify({
        data: {
          endpoints: [
            { provider_name: 'anthropic', status: 0, throughput_last_1h: null },
            {
              provider_name: 'bedrock',
              status: 0,
              throughput_last_1h: { p50: 80 },
            },
          ],
        },
      }),
    )
  })

  try {
    const providers = await listGatewayProviders(
      {
        baseURL: `${upstream.baseURL}/gateway`,
        name: 'test-gateway',
        type: 'vercel-gateway',
      },
      'anthropic/model',
    )
    expect(providers.map((p) => p.name)).toEqual(['anthropic', 'bedrock'])
    expect(providers[0]?.throughputTokensPerSec).toBeUndefined()
    expect(providers[1]?.throughputTokensPerSec).toBe(80)
  } finally {
    await upstream.close()
  }
})

test('fetches a single Gateway model throughput on demand', async () => {
  const upstream = await startUpstream((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(
      JSON.stringify({
        data: {
          endpoints: [
            {
              provider_name: 'anthropic',
              status: 0,
              throughput_last_1h: { p50: 49.5 },
            },
            { provider_name: 'bedrock', status: 1 },
          ],
        },
      }),
    )
  })

  try {
    const label = await fetchGatewayModelThroughput(
      {
        baseURL: `${upstream.baseURL}/gateway`,
        name: 'test-gateway',
        type: 'vercel-gateway',
      },
      'anthropic/claude-sonnet-4.6',
    )
    expect(label).toBe('50 tps')
  } finally {
    await upstream.close()
  }
})

test('treats a missing Gateway /endpoints model as no throughput', async () => {
  const upstream = await startUpstream((_request, response) => {
    response.statusCode = 404
    response.end('not found')
  })

  try {
    expect(
      await fetchGatewayModelThroughput(
        {
          baseURL: `${upstream.baseURL}/v1`,
          name: 'vercel-ai-gateway',
          type: 'vercel-gateway',
        },
        'zai/glm-4.6x',
      ),
    ).toBeUndefined()
  } finally {
    await upstream.close()
  }
})

test('skips an active endpoint with null throughput for one that has a p50', async () => {
  const upstream = await startUpstream((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(
      JSON.stringify({
        data: {
          endpoints: [
            { provider_name: 'anthropic', status: 0, throughput_last_1h: null },
            {
              provider_name: 'bedrock',
              status: 0,
              throughput_last_1h: { p50: 80 },
            },
          ],
        },
      }),
    )
  })

  try {
    const label = await fetchGatewayModelThroughput(
      {
        baseURL: `${upstream.baseURL}/gateway`,
        name: 'test-gateway',
        type: 'vercel-gateway',
      },
      'anthropic/model',
    )
    expect(label).toBe('80 tps')
  } finally {
    await upstream.close()
  }
})

test('lists OpenRouter models with cost and context hints', async () => {
  const upstream = await startUpstream((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(
      JSON.stringify({
        data: [
          {
            context_length: 200_000,
            id: 'anthropic/claude-sonnet-4.6',
            pricing: { completion: '0.000015', prompt: '0.000003' },
          },
          {
            context_length: 128_000,
            id: 'openai/gpt-5',
            pricing: { completion: '0.00001', prompt: '0.00000125' },
          },
        ],
      }),
    )
  })

  try {
    const models = await listModels({
      baseURL: `${upstream.baseURL}/api/v1`,
      name: 'openrouter',
      type: 'openrouter',
    })
    expect(models).toEqual([
      {
        costLabel: '$3/$15',
        hint: '195k ctx',
        id: 'anthropic/claude-sonnet-4.6',
      },
      {
        costLabel: '$1.25/$10',
        hint: '125k ctx',
        id: 'openai/gpt-5',
      },
    ])
  } finally {
    await upstream.close()
  }
})

test('lists OpenRouter models with supported_efforts, null, and mandatory', async () => {
  const upstream = await startUpstream((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(
      JSON.stringify({
        data: [
          {
            id: 'openai/gpt-5',
            reasoning: { supported_efforts: ['high', 'medium', 'low'] },
          },
          {
            id: 'openai/o3',
            reasoning: { supported_efforts: null },
          },
          {
            id: 'google/gemini-3.5-flash',
            reasoning: {
              mandatory: true,
              supported_efforts: ['high', 'medium', 'low', 'none'],
            },
          },
          {
            id: 'vendor/empty',
            reasoning: { supported_efforts: [] },
          },
          {
            id: 'vendor/none-only',
            reasoning: { mandatory: true, supported_efforts: ['none'] },
          },
          { id: 'meta/llama-3' },
        ],
      }),
    )
  })

  try {
    const models = await listModels({
      baseURL: `${upstream.baseURL}/api/v1`,
      name: 'openrouter',
      type: 'openrouter',
    })
    expect(models).toEqual([
      {
        efforts: ['low', 'medium', 'high'],
        id: 'google/gemini-3.5-flash',
      },
      { id: 'meta/llama-3' },
      {
        efforts: ['low', 'medium', 'high'],
        id: 'openai/gpt-5',
      },
      {
        efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
        id: 'openai/o3',
      },
      {
        efforts: [],
        id: 'vendor/empty',
      },
      {
        efforts: [],
        id: 'vendor/none-only',
      },
    ])
  } finally {
    await upstream.close()
  }
})

test('lists Gateway models with reasoning_options effort values', async () => {
  const upstream = await startUpstream((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(
      JSON.stringify({
        data: [
          {
            id: 'openai/gpt-5',
            reasoning_options: [
              { type: 'effort', values: ['minimal', 'low', 'medium', 'high'] },
            ],
          },
          { id: 'anthropic/claude-sonnet-4.6' },
        ],
      }),
    )
  })

  try {
    const models = await listModels({
      baseURL: `${upstream.baseURL}/gateway`,
      name: 'test-gateway',
      type: 'vercel-gateway',
    })
    expect(models).toEqual([
      { id: 'anthropic/claude-sonnet-4.6' },
      {
        efforts: ['minimal', 'low', 'medium', 'high'],
        id: 'openai/gpt-5',
      },
    ])
  } finally {
    await upstream.close()
  }
})

test('lists OpenRouter endpoints by tag with 30m throughput', async () => {
  let requestedPath = ''
  const upstream = await startUpstream((request, response) => {
    requestedPath = request.url ?? ''
    response.setHeader('content-type', 'application/json')
    response.end(
      JSON.stringify({
        data: {
          endpoints: [
            {
              pricing: { completion: '0.000025', prompt: '0.000005' },
              provider_name: 'Amazon Bedrock',
              status: 0,
              tag: 'amazon-bedrock',
              throughput_last_30m: { p50: 36 },
            },
            {
              pricing: { completion: '0.000025', prompt: '0.000005' },
              provider_name: 'Anthropic',
              status: 0,
              tag: 'anthropic',
              throughput_last_30m: { p50: 34 },
            },
            {
              provider_name: 'Google Vertex',
              status: -1,
              tag: 'google-vertex/us-east5',
            },
          ],
        },
      }),
    )
  })

  try {
    const providers = await listGatewayProviders(
      {
        baseURL: `${upstream.baseURL}/api/v1`,
        name: 'openrouter',
        type: 'openrouter',
      },
      'anthropic/claude-sonnet-4.6',
    )
    expect(providers).toEqual([
      {
        costInputPerMillion: 5,
        costOutputPerMillion: 25,
        label: 'Amazon Bedrock',
        name: 'amazon-bedrock',
        throughputTokensPerSec: 36,
      },
      {
        costInputPerMillion: 5,
        costOutputPerMillion: 25,
        label: 'Anthropic',
        name: 'anthropic',
        throughputTokensPerSec: 34,
      },
    ])
    expect(requestedPath).toBe(
      '/api/v1/models/anthropic/claude-sonnet-4.6/endpoints',
    )
  } finally {
    await upstream.close()
  }
})

test('lets a Gateway /endpoints 500 propagate so the picker can retry', async () => {
  const upstream = await startUpstream((_request, response) => {
    response.statusCode = 500
    response.end('upstream error')
  })

  try {
    let message = ''
    try {
      await fetchGatewayModelThroughput(
        {
          baseURL: `${upstream.baseURL}/v1`,
          name: 'vercel-ai-gateway',
          type: 'vercel-gateway',
        },
        'zai/glm-5.2',
      )
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toMatch(/^HTTP 500 /)
  } finally {
    await upstream.close()
  }
})

async function startUpstream(listener: RequestListener) {
  const server = createServer(listener)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('test upstream did not bind a TCP port')
  }
  return {
    baseURL: `http://127.0.0.1:${String(address.port)}`,
    close: async () => {
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      })
      server.closeAllConnections()
      await closed
    },
  }
}
