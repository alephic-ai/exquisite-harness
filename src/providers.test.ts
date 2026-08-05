import type { RequestListener } from 'node:http'

import { expect, test } from 'bun:test'
import { createServer } from 'node:http'

import { listGatewayProviders } from './providers.js'

test('lists the active provider slugs for a Gateway model', async () => {
  let requestedPath = ''
  const upstream = await startUpstream((request, response) => {
    requestedPath = request.url ?? ''
    response.setHeader('content-type', 'application/json')
    response.end(
      JSON.stringify({
        data: {
          endpoints: [
            { provider_name: 'bedrock', status: 0 },
            { provider_name: 'anthropic', status: 1 },
            { provider_name: 'bedrock', status: 0 },
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

    expect(providers).toEqual(['bedrock', 'vertex'])
    expect(requestedPath).toBe(
      '/gateway/v1/models/anthropic/model%20with%20spaces/endpoints',
    )
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
