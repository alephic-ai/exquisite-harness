import { expect, test } from 'bun:test'
import { createServer } from 'node:http'

import type { EndpointPricing } from './pricing.js'

import {
  endpointRates,
  fetchHeadlessRateCard,
  fetchModelMeta,
  gatewayCostUsd,
  headlessCost,
} from './pricing.js'

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

test('fetchHeadlessRateCard resolves per-endpoint pricing for a gateway pin', async () => {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.url === '/v1/models') {
      response.end(
        JSON.stringify({
          data: [
            {
              context_window: 1_000_000,
              id: 'test/model',
              pricing: { input: '0.000001', output: '0.000004' },
            },
          ],
        }),
      )
      return
    }
    if (request.url?.endsWith('/endpoints')) {
      response.end(
        JSON.stringify({
          data: {
            endpoints: [
              {
                pricing: { completion: '0.0000044', prompt: '0.0000014' },
                provider_name: 'nebius',
                status: 0,
              },
              {
                pricing: { completion: '0.000009', prompt: '0.000008' },
                provider_name: 'fireworks',
                status: 0,
              },
            ],
          },
        }),
      )
      return
    }
    response.statusCode = 500
    response.end('unexpected request')
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
    const usage = {
      cacheRead: 0,
      cacheWrite: 0,
      input: 1_000_000,
      output: 1_000_000,
    }

    const pinned = await fetchHeadlessRateCard({
      gatewayProvider: 'nebius',
      modelId: 'test/model',
      provider,
    })
    expect(pinned.kind).toBe('endpoint')
    // The pin bills the nebius endpoint's rates ($1.4 + $4.4), not the
    // model-aggregate ($1 + $4) — proof the pin drives per-endpoint pricing.
    expect(headlessCost(pinned, usage).costUsd).toBeCloseTo(5.8, 10)

    const unpinned = await fetchHeadlessRateCard({
      modelId: 'test/model',
      provider,
    })
    expect(unpinned).toEqual({
      kind: 'rates',
      rates: {
        cacheReadPerMillion: undefined,
        cacheWritePerMillion: undefined,
        inputPerMillion: 1,
        outputPerMillion: 4,
      },
    })

    const unknown = await fetchHeadlessRateCard({
      modelId: 'missing/model',
      provider,
    })
    expect(unknown).toEqual({ kind: 'unavailable' })

    // A pin that matches no endpoint must not fall back to the model-aggregate
    // rates on /v1/models ($1/$4) and label them gateway-rates.
    const missingPin = await fetchHeadlessRateCard({
      gatewayProvider: 'missing',
      modelId: 'test/model',
      provider,
    })
    expect(missingPin).toEqual({ kind: 'unavailable' })
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }
})

test('fetchHeadlessRateCard is free for ollama without any network', async () => {
  // An unreachable baseURL proves the ollama branch returns before any fetch;
  // a network attempt would resolve to `unavailable`, not `free`.
  const card = await fetchHeadlessRateCard({
    modelId: 'qwen3-coder',
    provider: {
      baseURL: 'http://127.0.0.1:1',
      name: 'ollama',
      type: 'ollama',
    },
  })
  expect(card).toEqual({ kind: 'free' })
})

test('gatewayCostUsd bills input, output, and cache tokens per million', () => {
  const rates = { inputPerMillion: 1.4, outputPerMillion: 4.4 }
  // 200k input * $1.4/1M = $0.28; 50k output * $4.4/1M = $0.22.
  expect(
    gatewayCostUsd(rates, {
      cacheRead: 0,
      cacheWrite: 0,
      input: 200_000,
      output: 50_000,
    }),
  ).toBeCloseTo(0.5, 10)
})

test('gatewayCostUsd bills cache tokens at the input rate when unpublished', () => {
  const rates = { inputPerMillion: 1.4, outputPerMillion: 4.4 }
  // No cache rate → 100k cache reads bill at the $1.4/1M input rate = $0.14.
  expect(
    gatewayCostUsd(rates, {
      cacheRead: 100_000,
      cacheWrite: 0,
      input: 0,
      output: 0,
    }),
  ).toBeCloseTo(0.14, 10)
  // A published cache-read rate is used instead: 100k * $0.14/1M = $0.014.
  expect(
    gatewayCostUsd(
      { ...rates, cacheReadPerMillion: 0.14 },
      { cacheRead: 100_000, cacheWrite: 0, input: 0, output: 0 },
    ),
  ).toBeCloseTo(0.014, 10)
})

test('endpointRates selects the tier bracket containing the token count', () => {
  const pricing: EndpointPricing = {
    completion: '0.000005',
    prompt_tiers: [
      { cost: '0.000001', max: 200_001, min: 0 },
      { cost: '0.000004', min: 200_001 },
    ],
  }
  expect(
    endpointRates(pricing, {
      cacheRead: 0,
      cacheWrite: 0,
      input: 1_000,
      output: 1_000,
    })?.inputPerMillion,
  ).toBe(1)
  expect(
    endpointRates(pricing, {
      cacheRead: 0,
      cacheWrite: 0,
      input: 300_000,
      output: 1_000,
    })?.inputPerMillion,
  ).toBe(4)
})

test('endpointRates keys the prompt tier on the full context including cache', () => {
  const pricing: EndpointPricing = {
    completion: '0.000005',
    prompt_tiers: [
      { cost: '0.000001', max: 200_001, min: 0 },
      { cost: '0.000004', min: 200_001 },
    ],
  }
  // 100k input + 150k cache reads cross the 200_001 bracket boundary even
  // though the input alone stays in the cheaper bracket — the cached long
  // context must be billed at the matched tier, not under-billed.
  expect(
    endpointRates(pricing, {
      cacheRead: 150_000,
      cacheWrite: 0,
      input: 100_000,
      output: 1_000,
    })?.inputPerMillion,
  ).toBe(4)
})

test('endpointRates falls back to the base rate, then undefined', () => {
  const usage = { cacheRead: 0, cacheWrite: 0, input: 1_000, output: 1_000 }
  expect(
    endpointRates({ completion: '0.000005', prompt: '0.000001' }, usage),
  ).toEqual({
    cacheReadPerMillion: undefined,
    cacheWritePerMillion: undefined,
    inputPerMillion: 1,
    outputPerMillion: 5,
  })
  // No prompt rate and no prompt tiers → no input rate → whole card undefined.
  expect(endpointRates({ completion: '0.000005' }, usage)).toBeUndefined()
})

test('headlessCost classifies the source and never fabricates cost', () => {
  const usage = {
    cacheRead: 0,
    cacheWrite: 0,
    input: 1_000_000,
    output: 1_000_000,
  }
  expect(headlessCost({ kind: 'free' }, usage)).toEqual({
    costSource: 'free',
    costUsd: 0,
  })
  expect(headlessCost({ kind: 'unavailable' }, usage)).toEqual({
    costSource: 'unavailable',
    costUsd: undefined,
  })
  // All-zero paid rates collapse to free, not a $0 gateway-rates bill.
  expect(
    headlessCost(
      { kind: 'rates', rates: { inputPerMillion: 0, outputPerMillion: 0 } },
      usage,
    ),
  ).toEqual({ costSource: 'free', costUsd: 0 })
  const paid = headlessCost(
    { kind: 'rates', rates: { inputPerMillion: 1.4, outputPerMillion: 4.4 } },
    usage,
  )
  expect(paid.costSource).toBe('gateway-rates')
  expect(paid.costUsd).toBeCloseTo(5.8, 10)
})
