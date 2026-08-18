import type { RequestListener } from 'node:http'

import { describe, expect, test } from 'bun:test'
import { createServer, request as httpRequest } from 'node:http'

import { withGatewayRouting } from './gateway-routing.js'
import { buildLaunchPlan } from './harnesses.js'
import { anthropicBaseURLFor } from './providers.js'

describe('gateway provider routing', () => {
  test.each(['/messages', '/responses', '/chat/completions'])(
    'pins the chosen provider for %s without changing the response',
    async (path) => {
      let receivedBody = ''
      const responseBody = 'data: {"type":"response.completed"}\n\n'
      const upstream = await startUpstream(async (request, response) => {
        if (request.url?.endsWith('/endpoints')) {
          response.setHeader('content-type', 'application/json')
          response.end(
            JSON.stringify({
              data: { endpoints: [{ provider_name: 'bedrock', status: 0 }] },
            }),
          )
          return
        }
        receivedBody = await readBody(request)
        response.setHeader('content-type', 'text/event-stream')
        response.end(responseBody)
      })
      const targetBaseURL = `${upstream.baseURL}/v1`

      try {
        await withGatewayRouting(
          {
            args: [`base_url="${targetBaseURL}"`],
            bin: 'test-harness',
            env: { TEST_GATEWAY_BASE_URL: targetBaseURL },
            gatewayRouting: {
              model: 'anthropic/claude-sonnet-4.6',
              provider: 'bedrock',
              targetBaseURL,
            },
            notes: [],
          },
          async (plan) => {
            const response = await fetch(
              `${plan.env.TEST_GATEWAY_BASE_URL}${path}`,
              {
                body: JSON.stringify({
                  model: 'anthropic/claude-sonnet-4.6',
                  providerOptions: {
                    anthropic: { effort: 'high' },
                    gateway: { order: ['anthropic'], tags: ['eh'] },
                  },
                }),
                headers: { 'content-type': 'application/json' },
                method: 'POST',
              },
            )

            expect(await response.text()).toBe(responseBody)
            expect(plan.args.at(0)).not.toContain(targetBaseURL)
            expect(plan.gatewayRouting).toBeUndefined()
          },
        )
        expect(JSON.parse(receivedBody)).toEqual({
          model: 'anthropic/claude-sonnet-4.6',
          providerOptions: {
            anthropic: { effort: 'high' },
            gateway: {
              only: ['bedrock'],
              order: ['anthropic'],
              tags: ['eh'],
            },
          },
        })
      } finally {
        await upstream.close()
      }
    },
  )

  test('preserves a configured gateway base path prefix in routes', async () => {
    let receivedPath = ''
    const responseBody = 'data: {"type":"response.completed"}\n\n'
    const upstream = await startUpstream((request, response) => {
      if (request.url?.endsWith('/endpoints')) {
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            data: { endpoints: [{ provider_name: 'bedrock', status: 0 }] },
          }),
        )
        return
      }
      receivedPath = request.url ?? ''
      response.setHeader('content-type', 'text/event-stream')
      response.end(responseBody)
    })
    // Custom base path, not just /v1: https://host/gateway/v1
    const targetBaseURL = `${upstream.baseURL}/gateway/v1`

    try {
      await withGatewayRouting(
        {
          args: [`base_url="${targetBaseURL}"`],
          bin: 'test-harness',
          env: { TEST_GATEWAY_BASE_URL: targetBaseURL },
          gatewayRouting: {
            model: 'anthropic/claude-sonnet-4.6',
            provider: 'bedrock',
            targetBaseURL,
          },
          notes: [],
        },
        async (plan) => {
          const response = await fetch(
            `${plan.env.TEST_GATEWAY_BASE_URL}/chat/completions`,
            {
              body: JSON.stringify({
                model: 'anthropic/claude-sonnet-4.6',
                providerOptions: { gateway: { order: ['anthropic'] } },
              }),
              headers: { 'content-type': 'application/json' },
              method: 'POST',
            },
          )
          expect(await response.text()).toBe(responseBody)
        },
      )
      // The upstream sees the full configured base path, not a collapsed /v1.
      expect(receivedPath).toBe('/gateway/v1/chat/completions')
    } finally {
      await upstream.close()
    }
  })

  test('pins an OpenRouter provider without changing the response', async () => {
    let receivedBody = ''
    const responseBody = 'data: {"type":"message_delta"}\n\n'
    const upstream = await startUpstream(async (request, response) => {
      if (request.url?.endsWith('/endpoints')) {
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            data: {
              endpoints: [
                {
                  provider_name: 'Amazon Bedrock',
                  status: 0,
                  tag: 'amazon-bedrock',
                },
              ],
            },
          }),
        )
        return
      }
      receivedBody = await readBody(request)
      response.setHeader('content-type', 'text/event-stream')
      response.end(responseBody)
    })
    const targetBaseURL = `${upstream.baseURL}/api/v1`

    try {
      await withGatewayRouting(
        {
          args: [`base_url="${targetBaseURL}"`],
          bin: 'test-harness',
          env: { TEST_GATEWAY_BASE_URL: targetBaseURL },
          gatewayRouting: {
            kind: 'openrouter',
            model: 'anthropic/claude-sonnet-4.6',
            provider: 'amazon-bedrock',
            targetBaseURL,
          },
          notes: [],
        },
        async (plan) => {
          const response = await fetch(
            `${plan.env.TEST_GATEWAY_BASE_URL}/chat/completions`,
            {
              body: JSON.stringify({
                model: 'anthropic/claude-sonnet-4.6',
                provider: { ignore: ['together'] },
              }),
              headers: { 'content-type': 'application/json' },
              method: 'POST',
            },
          )
          expect(await response.text()).toBe(responseBody)
        },
      )
      expect(JSON.parse(receivedBody)).toEqual({
        model: 'anthropic/claude-sonnet-4.6',
        provider: {
          allow_fallbacks: false,
          ignore: ['together'],
          only: ['amazon-bedrock'],
        },
      })
    } finally {
      await upstream.close()
    }
  })

  test('OpenRouter ZDR-only routing injects provider.zdr without pinning', async () => {
    let receivedBody = ''
    const upstream = await startUpstream(async (request, response) => {
      receivedBody = await readBody(request)
      response.end('data: {"type":"response.completed"}\n\n')
    })
    const targetBaseURL = `${upstream.baseURL}/v1`

    try {
      await withGatewayRouting(
        {
          args: [`base_url="${targetBaseURL}"`],
          bin: 'test-harness',
          env: { TEST_GATEWAY_BASE_URL: targetBaseURL },
          gatewayRouting: {
            kind: 'openrouter',
            model: 'anthropic/claude-sonnet-4.6',
            targetBaseURL,
            zdr: true,
          },
          notes: [],
        },
        async (plan) => {
          await fetch(`${plan.env.TEST_GATEWAY_BASE_URL}/messages`, {
            body: JSON.stringify({ model: 'anthropic/claude-sonnet-4.6' }),
            headers: { 'content-type': 'application/json' },
            method: 'POST',
          })
        },
      )
      expect(JSON.parse(receivedBody)).toEqual({
        model: 'anthropic/claude-sonnet-4.6',
        provider: { zdr: true },
      })
    } finally {
      await upstream.close()
    }
  })

  test('accepts an OpenRouter base slug when only regional tags are listed', async () => {
    let receivedBody = ''
    const upstream = await startUpstream(async (request, response) => {
      if (request.url?.endsWith('/endpoints')) {
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            data: {
              endpoints: [
                {
                  provider_name: 'Amazon Bedrock',
                  status: 0,
                  tag: 'amazon-bedrock/global',
                },
              ],
            },
          }),
        )
        return
      }
      receivedBody = await readBody(request)
      response.end('ok')
    })
    const targetBaseURL = `${upstream.baseURL}/api/v1`

    try {
      await withGatewayRouting(
        {
          args: [`base_url="${targetBaseURL}"`],
          bin: 'test-harness',
          env: { TEST_GATEWAY_BASE_URL: targetBaseURL },
          gatewayRouting: {
            kind: 'openrouter',
            model: 'anthropic/claude-sonnet-4.6',
            provider: 'amazon-bedrock',
            targetBaseURL,
          },
          notes: [],
        },
        async (plan) => {
          const response = await fetch(
            `${plan.env.TEST_GATEWAY_BASE_URL}/chat/completions`,
            {
              body: JSON.stringify({ model: 'anthropic/claude-sonnet-4.6' }),
              headers: { 'content-type': 'application/json' },
              method: 'POST',
            },
          )
          expect(await response.text()).toBe('ok')
        },
      )
      expect(JSON.parse(receivedBody)).toEqual({
        model: 'anthropic/claude-sonnet-4.6',
        provider: {
          allow_fallbacks: false,
          only: ['amazon-bedrock'],
        },
      })
    } finally {
      await upstream.close()
    }
  })

  test('ZDR-only routing injects zeroDataRetention without pinning a provider', async () => {
    let receivedBody = ''
    const upstream = await startUpstream(async (request, response) => {
      receivedBody = await readBody(request)
      response.end('data: {"type":"response.completed"}\n\n')
    })
    const targetBaseURL = `${upstream.baseURL}/v1`

    try {
      await withGatewayRouting(
        {
          args: [`base_url="${targetBaseURL}"`],
          bin: 'test-harness',
          env: { TEST_GATEWAY_BASE_URL: targetBaseURL },
          gatewayRouting: {
            model: 'anthropic/claude-sonnet-4.6',
            targetBaseURL,
            zdr: true,
          },
          notes: [],
        },
        async (plan) => {
          const response = await fetch(
            `${plan.env.TEST_GATEWAY_BASE_URL}/messages`,
            {
              body: JSON.stringify({
                model: 'anthropic/claude-sonnet-4.6',
                providerOptions: { gateway: { order: ['anthropic'] } },
              }),
              headers: { 'content-type': 'application/json' },
              method: 'POST',
            },
          )
          expect(await response.text()).toBe(
            'data: {"type":"response.completed"}\n\n',
          )
        },
      )
      expect(JSON.parse(receivedBody)).toEqual({
        model: 'anthropic/claude-sonnet-4.6',
        providerOptions: {
          gateway: {
            order: ['anthropic'],
            zeroDataRetention: true,
          },
        },
      })
    } finally {
      await upstream.close()
    }
  })

  test('fails closed before inference when the provider cannot serve the model', async () => {
    let inferenceReached = false
    let runReached = false
    const upstream = await startUpstream((request, response) => {
      if (request.url?.endsWith('/endpoints')) {
        expect(request.url).toBe(
          '/v1/models/anthropic/claude-sonnet-4.6/endpoints',
        )
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            data: {
              endpoints: [
                { provider_name: 'anthropic', status: 0 },
                { provider_name: 'bedrock', status: 1 },
              ],
            },
          }),
        )
        return
      }
      inferenceReached = true
      response.end('unexpected')
    })

    try {
      let message = ''
      try {
        await withGatewayRouting(
          {
            args: [],
            bin: 'test-harness',
            env: { TEST_GATEWAY_BASE_URL: upstream.baseURL },
            gatewayRouting: {
              model: 'anthropic/claude-sonnet-4.6',
              provider: 'bedrock',
              targetBaseURL: upstream.baseURL,
            },
            notes: [],
          },
          async () => {
            runReached = true
            return Promise.resolve()
          },
        )
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      expect(message).toContain(
        'gateway provider "bedrock" is unavailable for model "anthropic/claude-sonnet-4.6" (available: anthropic)',
      )
      expect(inferenceReached).toBeFalse()
      expect(runReached).toBeFalse()
    } finally {
      await upstream.close()
    }
  })

  test('uses a non-empty auth token when the provider key variable is deliberately blank', async () => {
    // CI/sandbox may export ANTHROPIC_API_KEY; the plan's blank value must win,
    // so clear the ambient var to keep this test hermetic against it.
    const priorApiKey = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    let validationAuthorization = ''
    const upstream = await startUpstream((request, response) => {
      validationAuthorization = request.headers.authorization ?? ''
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          data: { endpoints: [{ provider_name: 'bedrock', status: 0 }] },
        }),
      )
    })

    // Keep this hermetic: the auth resolver also falls back to
    // process.env[apiKeyEnvKey], so blank the ambient key to force the plan
    // ANTHROPIC_AUTH_TOKEN fall-through regardless of the shell environment.
    const priorApiKey = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      await withGatewayRouting(
        {
          args: [],
          bin: 'test-harness',
          env: {
            ANTHROPIC_API_KEY: '',
            ANTHROPIC_AUTH_TOKEN: 'qa-auth-token',
            TEST_GATEWAY_BASE_URL: upstream.baseURL,
          },
          gatewayRouting: {
            apiKeyEnvKey: 'ANTHROPIC_API_KEY',
            model: 'anthropic/claude-sonnet-4.6',
            provider: 'bedrock',
            targetBaseURL: upstream.baseURL,
          },
          notes: [],
        },
        async () => Promise.resolve(),
      )
      expect(validationAuthorization).toBe('Bearer qa-auth-token')
    } finally {
      if (priorApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY
      } else {
        process.env.ANTHROPIC_API_KEY = priorApiKey
      }
      await upstream.close()
      if (priorApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = priorApiKey
    }
  })

  test('leaves count-tokens requests unchanged', async () => {
    let receivedBody = ''
    const upstream = await startUpstream(async (request, response) => {
      if (request.url?.endsWith('/endpoints')) {
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            data: { endpoints: [{ provider_name: 'bedrock', status: 0 }] },
          }),
        )
        return
      }
      receivedBody = await readBody(request)
      response.end('{"input_tokens":42}')
    })
    const body = JSON.stringify({
      messages: [{ content: 'hello', role: 'user' }],
      model: 'anthropic/claude-sonnet-4.6',
    })

    try {
      await withGatewayRouting(
        {
          args: [],
          bin: 'test-harness',
          env: { TEST_GATEWAY_BASE_URL: upstream.baseURL },
          gatewayRouting: {
            model: 'anthropic/claude-sonnet-4.6',
            provider: 'bedrock',
            targetBaseURL: upstream.baseURL,
          },
          notes: [],
        },
        async (plan) => {
          const response = await fetch(
            `${plan.env.TEST_GATEWAY_BASE_URL}/v1/messages/count_tokens`,
            {
              body,
              headers: { 'content-type': 'application/json' },
              method: 'POST',
            },
          )

          expect(response.status).toBe(200)
        },
      )

      expect(receivedBody).toBe(body)
    } finally {
      await upstream.close()
    }
  })

  test('relays model discovery without changing its method or headers', async () => {
    let receivedAuthorization = ''
    let receivedMethod = ''
    let receivedURL = ''
    const upstream = await startUpstream((request, response) => {
      if (request.url?.endsWith('/endpoints')) {
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            data: { endpoints: [{ provider_name: 'bedrock', status: 0 }] },
          }),
        )
        return
      }
      receivedAuthorization = request.headers.authorization ?? ''
      receivedMethod = request.method ?? ''
      receivedURL = request.url ?? ''
      response.end('{"data":[{"id":"test/model"}]}')
    })
    const targetBaseURL = `${upstream.baseURL}/v1`

    try {
      await withGatewayRouting(
        {
          args: [],
          bin: 'test-harness',
          env: { TEST_GATEWAY_BASE_URL: targetBaseURL },
          gatewayRouting: {
            model: 'test/model',
            provider: 'bedrock',
            targetBaseURL,
          },
          notes: [],
        },
        async (plan) => {
          const response = await fetch(
            `${plan.env.TEST_GATEWAY_BASE_URL}/models?client_version=qa`,
            { headers: { authorization: 'Bearer qa-key' } },
          )
          expect(await response.json()).toEqual({
            data: [{ id: 'test/model' }],
          })
        },
      )
      expect(receivedAuthorization).toBe('Bearer qa-key')
      expect(receivedMethod).toBe('GET')
      expect(receivedURL).toBe('/v1/models?client_version=qa')
    } finally {
      await upstream.close()
    }
  })

  test('rejects protocol-relative paths without changing the upstream origin', async () => {
    let hostileOriginReached = false
    const hostileOrigin = await startUpstream((_request, response) => {
      hostileOriginReached = true
      response.end('unexpected')
    })
    const intendedUpstream = await startUpstream((request, response) => {
      if (request.url?.endsWith('/endpoints')) {
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            data: { endpoints: [{ provider_name: 'bedrock', status: 0 }] },
          }),
        )
        return
      }
      response.end('intended')
    })

    try {
      await withGatewayRouting(
        {
          args: [],
          bin: 'test-harness',
          env: { TEST_GATEWAY_BASE_URL: intendedUpstream.baseURL },
          gatewayRouting: {
            model: 'test/model',
            provider: 'bedrock',
            targetBaseURL: intendedUpstream.baseURL,
          },
          notes: [],
        },
        async (plan) => {
          const hostileURL = new URL(hostileOrigin.baseURL)
          const response = await fetch(
            `${plan.env.TEST_GATEWAY_BASE_URL}//${hostileURL.host}/v1/models`,
          )
          expect(response.status).toBe(502)
        },
      )
      expect(hostileOriginReached).toBeFalse()
    } finally {
      await hostileOrigin.close()
      await intendedUpstream.close()
    }
  })

  test('closes promptly after a harness disconnects mid-stream', async () => {
    const upstream = await startUpstream((request, response) => {
      if (request.url?.endsWith('/endpoints')) {
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            data: { endpoints: [{ provider_name: 'bedrock', status: 0 }] },
          }),
        )
        return
      }
      const interval = setInterval(() => {
        response.write('event: ping\ndata: {}\n\n')
      }, 10)
      const close = () => {
        clearInterval(interval)
      }
      request.once('aborted', close)
      response.once('close', close)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('event: ping\ndata: {}\n\n')
    })

    try {
      await settleWithin(
        withGatewayRouting(
          {
            args: [],
            bin: 'test-harness',
            env: { TEST_GATEWAY_BASE_URL: upstream.baseURL },
            gatewayRouting: {
              model: 'test/model',
              provider: 'bedrock',
              targetBaseURL: upstream.baseURL,
            },
            notes: [],
          },
          async (plan) => {
            await new Promise<void>((resolve, reject) => {
              const request = httpRequest(
                `${plan.env.TEST_GATEWAY_BASE_URL}/v1/messages`,
                {
                  headers: { 'content-type': 'application/json' },
                  method: 'POST',
                },
                (response) => {
                  response.once('data', () => {
                    const error = new Error('test harness disconnected')
                    request.destroy(error)
                    response.destroy(error)
                    resolve()
                  })
                  response.on('error', () => undefined)
                },
              )
              request.once('error', reject)
              request.end(JSON.stringify({ model: 'test/model' }))
            })
          },
        ),
        'routing proxy shutdown',
      )
    } finally {
      await upstream.close()
    }
  })
})

describe('gateway routing plan construction', () => {
  const provider = {
    baseURL: 'http://127.0.0.1:19099/v1',
    name: 'vercel-ai-gateway',
    type: 'vercel-gateway' as const,
  }

  test('ZDR-only produces a routing proxy without a pinned provider', async () => {
    const plan = await buildLaunchPlan('codex', provider, 'test/model', {
      gatewayZdr: true,
      statusline: false,
    })
    expect(plan.gatewayRouting).toEqual({
      apiKeyEnvKey: undefined,
      model: 'test/model',
      targetBaseURL: 'http://127.0.0.1:19099/v1',
      zdr: true,
    })
    expect(plan.notes).toContain('gateway routing: ZDR only')
  })

  test('a pinned provider wins over a ZDR flag', async () => {
    const plan = await buildLaunchPlan('codex', provider, 'test/model', {
      gatewayProvider: 'bedrock',
      gatewayZdr: true,
      statusline: false,
    })
    expect(plan.gatewayRouting).toEqual({
      apiKeyEnvKey: undefined,
      model: 'test/model',
      provider: 'bedrock',
      targetBaseURL: 'http://127.0.0.1:19099/v1',
      zdr: false,
    })
    expect(plan.notes).toContain('gateway provider pinned: bedrock')
  })

  test('no gateway options means no routing proxy', async () => {
    const plan = await buildLaunchPlan('codex', provider, 'test/model', {
      statusline: false,
    })
    expect(plan.gatewayRouting).toBeUndefined()
  })

  test('OpenRouter pins use the OpenRouter request body and Claude Anthropic skin', async () => {
    const openrouter = {
      baseURL: 'https://openrouter.ai/api/v1',
      name: 'openrouter',
      type: 'openrouter' as const,
    }
    expect(anthropicBaseURLFor(openrouter)).toBe('https://openrouter.ai/api')
    const plan = await buildLaunchPlan(
      'codex',
      openrouter,
      'anthropic/claude-sonnet-4.6',
      {
        gatewayProvider: 'amazon-bedrock',
        statusline: false,
      },
    )
    expect(plan.gatewayRouting).toEqual({
      apiKeyEnvKey: undefined,
      kind: 'openrouter',
      model: 'anthropic/claude-sonnet-4.6',
      provider: 'amazon-bedrock',
      targetBaseURL: 'https://openrouter.ai/api/v1',
      zdr: false,
    })
  })
})

async function readBody(request: Parameters<RequestListener>[0]) {
  return new Promise<string>((resolve, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => {
      body += chunk
    })
    request.on('end', () => resolve(body))
    request.on('error', reject)
  })
}

async function settleWithin<T>(promise: Promise<T>, operation: string) {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${operation} timed out`)),
          1000,
        )
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

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
