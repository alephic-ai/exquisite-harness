import type { RequestListener } from 'node:http'

import { describe, expect, test } from 'bun:test'
import { createServer, request as httpRequest } from 'node:http'

import { withGatewayRouting } from './gateway-routing.js'

describe('gateway provider routing', () => {
  test.each(['/messages', '/responses', '/chat/completions'])(
    'pins the chosen provider for %s without changing the response',
    async (path) => {
      let receivedBody = ''
      const responseBody = 'data: {"type":"response.completed"}\n\n'
      const upstream = await startUpstream(async (request, response) => {
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
            gatewayRouting: { provider: 'bedrock', targetBaseURL },
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

  test('leaves count-tokens requests unchanged', async () => {
    let receivedBody = ''
    const upstream = await startUpstream(async (request, response) => {
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
          gatewayRouting: { provider: 'bedrock', targetBaseURL },
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

  test('closes promptly after a harness disconnects mid-stream', async () => {
    const upstream = await startUpstream((request, response) => {
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
