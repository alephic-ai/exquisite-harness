import type { RequestListener } from 'node:http'

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  readGatewaySessionCost,
  startGatewayCostProxy,
} from './gateway-costs.js'
import { formatExactSessionCostUsd } from './pricing.js'

const tempDirs: string[] = []

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true })
})

describe('gateway cost capture', () => {
  test('records each streamed generation cost once without changing the response', async () => {
    const sessionId = 'bd88644d-cae1-46c3-9c2b-3bfcf9b2db6d'
    const event = gatewayCostEvent('gen_123', '0.00001596')
    const secondEvent = gatewayCostEvent('gen_456', '0.00000004')
    const body = `event: message_delta\ndata: ${JSON.stringify(event)}\n\nevent: message_delta\ndata: ${JSON.stringify(event)}\n\nevent: message_delta\ndata: ${JSON.stringify(secondEvent)}\n\n`
    const upstream = await startUpstream(body)
    const costDir = makeTempDir()
    const proxy = await startGatewayCostProxy({
      costDir,
      resumed: false,
      targetBaseURL: upstream.baseURL,
    })

    try {
      const response = await settleWithin(
        fetch(`${proxy.baseURL}/v1/messages`, {
          body: gatewayRequestBody(sessionId),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }),
        'stream response headers',
      )
      expect(await response.text()).toBe(body)
      const total = readGatewaySessionCost({ costDir, sessionId })
      expect(total).toEqual({ exact: true, total: '0.000016' })
      expect(total && formatExactSessionCostUsd(total.total)).toBe('$0.000016')
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })

  test('does not present a partial ledger as a resumed session total', async () => {
    const sessionId = 'f709e045-f98b-4df6-a3a3-c69e9ffdb628'
    const event = gatewayCostEvent('gen_456', '0.25')
    const body = `data: ${JSON.stringify(event)}\n\n`
    const upstream = await startUpstream(body)
    const costDir = makeTempDir()
    const proxy = await startGatewayCostProxy({
      costDir,
      resumed: true,
      targetBaseURL: upstream.baseURL,
    })

    try {
      await fetch(`${proxy.baseURL}/v1/messages`, {
        body: gatewayRequestBody(sessionId),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }).then(async (response) => response.text())
      expect(readGatewaySessionCost({ costDir, sessionId })).toBeUndefined()
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })

  test('rejects conflicting costs for the same generation', async () => {
    const sessionId = '2474ac86-0dcc-4d41-aabc-47f32a25a78c'
    const body = [
      gatewayCostEvent('gen_conflict', '0.1'),
      gatewayCostEvent('gen_conflict', '0.2'),
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join('')
    const upstream = await startUpstream(body)
    const costDir = makeTempDir()
    const proxy = await startGatewayCostProxy({
      costDir,
      resumed: false,
      targetBaseURL: upstream.baseURL,
    })

    try {
      await fetch(`${proxy.baseURL}/v1/messages`, {
        body: gatewayRequestBody(sessionId),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }).then(async (response) => response.text())
      expect(readGatewaySessionCost({ costDir, sessionId })).toBeUndefined()
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })

  test('keeps the priced total when one request is unpriced', async () => {
    const sessionId = '9f2e1701-4c6b-4d5a-9a3b-28c1a5d5f7e2'
    const costEvent = gatewayCostEvent('gen_priced', '0.00001596')
    const costBody = `data: ${JSON.stringify(costEvent)}\n\n`
    const unpricedBody = 'event: ping\ndata: {}\n\n'
    const costDir = makeTempDir()
    // Serve the priced request first, then the unpriced one, sharing a session.
    let requestNumber = 0
    const upstream = await startUpstream((_request, response) => {
      response.setHeader('content-type', 'text/event-stream')
      requestNumber += 1
      response.end(requestNumber === 1 ? costBody : unpricedBody)
    })
    const proxy = await startGatewayCostProxy({
      costDir,
      resumed: false,
      targetBaseURL: upstream.baseURL,
    })
    try {
      await fetch(`${proxy.baseURL}/v1/messages`, {
        body: gatewayRequestBody(sessionId),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }).then(async (response) => response.text())
      await fetch(`${proxy.baseURL}/v1/messages`, {
        body: gatewayRequestBody(sessionId),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }).then(async (response) => response.text())
      expect(readGatewaySessionCost({ costDir, sessionId })).toEqual({
        exact: false,
        total: '0.00001596',
      })
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })

  test('keeps the priced total when the unpriced request comes first', async () => {
    const sessionId = '8c4a2e1f-6d3b-4a9c-8e7f-12b4d5c6e7f8'
    const costEvent = gatewayCostEvent('gen_priced', '0.00001596')
    const costBody = `data: ${JSON.stringify(costEvent)}\n\n`
    const unpricedBody = 'event: ping\ndata: {}\n\n'
    const costDir = makeTempDir()
    // The old code returned undefined on the first unpriced entry, so leading
    // with an unpriced request is the ordering that actually regressed.
    let requestNumber = 0
    const upstream = await startUpstream((_request, response) => {
      response.setHeader('content-type', 'text/event-stream')
      requestNumber += 1
      response.end(requestNumber === 1 ? unpricedBody : costBody)
    })
    const proxy = await startGatewayCostProxy({
      costDir,
      resumed: false,
      targetBaseURL: upstream.baseURL,
    })
    try {
      await fetch(`${proxy.baseURL}/v1/messages`, {
        body: gatewayRequestBody(sessionId),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }).then(async (response) => response.text())
      await fetch(`${proxy.baseURL}/v1/messages`, {
        body: gatewayRequestBody(sessionId),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }).then(async (response) => response.text())
      expect(readGatewaySessionCost({ costDir, sessionId })).toEqual({
        exact: false,
        total: '0.00001596',
      })
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })

  test('shows unavailable when every request is unpriced', async () => {
    const sessionId = '5d1b3c4a-7e2f-4a8b-9c6d-3f4a5b6c7d8e'
    const unpricedBody = 'event: ping\ndata: {}\n\n'
    const costDir = makeTempDir()
    const upstream = await startUpstream((_request, response) => {
      response.setHeader('content-type', 'text/event-stream')
      response.end(unpricedBody)
    })
    const proxy = await startGatewayCostProxy({
      costDir,
      resumed: false,
      targetBaseURL: upstream.baseURL,
    })
    try {
      await fetch(`${proxy.baseURL}/v1/messages`, {
        body: gatewayRequestBody(sessionId),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }).then(async (response) => response.text())
      // Nothing priced, so the session must not read as an exact $0.
      expect(readGatewaySessionCost({ costDir, sessionId })).toBeUndefined()
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })

  test('stays unavailable while pending and after a response without cost metadata', async () => {
    const sessionId = 'ab4d82d4-33a5-44e4-86f2-1c64a27bbac2'
    let finishResponse: (() => void) | undefined
    const waitToFinish = new Promise<void>((resolve) => {
      finishResponse = resolve
    })
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('event: ping\ndata: {}\n\n')
      void waitToFinish.then(() => response.end())
    })
    const costDir = makeTempDir()
    const proxy = await startGatewayCostProxy({
      costDir,
      resumed: false,
      targetBaseURL: upstream.baseURL,
    })

    try {
      const response = await fetch(`${proxy.baseURL}/v1/messages`, {
        body: gatewayRequestBody(sessionId),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      expect(readGatewaySessionCost({ costDir, sessionId })).toBeUndefined()
      finishResponse?.()
      await settleWithin(response.text(), 'unpriced response completion')
      expect(readGatewaySessionCost({ costDir, sessionId })).toBeUndefined()
    } finally {
      finishResponse?.()
      await settleWithin(proxy.close(), 'pending-test proxy close')
      await settleWithin(upstream.close(), 'pending-test upstream close')
    }
  })

  test('keeps showing the priced total while a later request is still pending', async () => {
    const sessionId = '6e2a4c8b-1d5f-4a7e-9b3c-8f2a4b6c7d8e'
    const costEvent = gatewayCostEvent('gen_priced', '0.00001596')
    const costBody = `data: ${JSON.stringify(costEvent)}\n\n`
    const costDir = makeTempDir()
    let finishSecond: (() => void) | undefined
    let secondStarted: (() => void) | undefined
    const secondResponse = new Promise<void>((resolve) => {
      finishSecond = resolve
    })
    const secondInFlight = new Promise<void>((resolve) => {
      secondStarted = resolve
    })
    let requestNumber = 0
    const upstream = await startUpstream((_request, response) => {
      response.setHeader('content-type', 'text/event-stream')
      requestNumber += 1
      if (requestNumber === 1) {
        response.end(costBody)
      } else {
        secondStarted?.()
        // Hold the second request open so it stays pending.
        response.write('event: ping\ndata: {}\n\n')
        void secondResponse.then(() => response.end())
      }
    })
    const proxy = await startGatewayCostProxy({
      costDir,
      resumed: false,
      targetBaseURL: upstream.baseURL,
    })

    try {
      await fetch(`${proxy.baseURL}/v1/messages`, {
        body: gatewayRequestBody(sessionId),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }).then(async (response) => response.text())
      const second = fetch(`${proxy.baseURL}/v1/messages`, {
        body: gatewayRequestBody(sessionId),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      await settleWithin(secondInFlight, 'second request in flight')
      // The priced request has settled; the second is still in flight, so the
      // total must stay visible (partial) rather than disappear.
      expect(readGatewaySessionCost({ costDir, sessionId })).toEqual({
        exact: false,
        total: '0.00001596',
      })
      finishSecond?.()
      await settleWithin(
        second.then(async (response) => response.text()),
        'second request',
      )
      expect(readGatewaySessionCost({ costDir, sessionId })).toEqual({
        exact: false,
        total: '0.00001596',
      })
    } finally {
      finishSecond?.()
      await settleWithin(proxy.close(), 'pending-visible proxy close')
      await settleWithin(upstream.close(), 'pending-visible upstream close')
    }
  })

  test('aborts the upstream request when the downstream client disconnects', async () => {
    const sessionId = '0733a250-53f0-4378-b81e-b63279428f62'
    let markUpstreamClosed: (() => void) | undefined
    const upstreamClosed = new Promise<void>((resolve) => {
      markUpstreamClosed = resolve
    })
    const upstream = await startUpstream((request, response) => {
      const interval = setInterval(() => {
        response.write('event: ping\ndata: {}\n\n')
      }, 10)
      request.once('aborted', () => {
        clearInterval(interval)
        markUpstreamClosed?.()
      })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('event: ping\ndata: {}\n\n')
    })
    const costDir = makeTempDir()
    const proxy = await startGatewayCostProxy({
      costDir,
      resumed: false,
      targetBaseURL: upstream.baseURL,
    })

    try {
      await settleWithin(
        new Promise<void>((resolve, reject) => {
          const request = httpRequest(
            `${proxy.baseURL}/v1/messages`,
            {
              headers: { 'content-type': 'application/json' },
              method: 'POST',
            },
            (response) => {
              response.once('data', () => {
                request.destroy(new Error('test downstream disconnected'))
                resolve()
              })
              response.on('error', () => undefined)
            },
          )
          request.once('error', reject)
          request.end(gatewayRequestBody(sessionId))
        }),
        'downstream disconnect',
      )
      await settleWithin(upstreamClosed, 'upstream cancellation')
      expect(readGatewaySessionCost({ costDir, sessionId })).toBeUndefined()
    } finally {
      await settleWithin(proxy.close(), 'abort-test proxy close')
      await settleWithin(upstream.close(), 'abort-test upstream close')
    }
  })

  test('rejects protocol-relative paths instead of changing the upstream origin', async () => {
    let hostileOriginReached = false
    const hostileOrigin = await startUpstream((_request, response) => {
      hostileOriginReached = true
      response.end('unexpected')
    })
    const intendedUpstream = await startUpstream('unused')
    const costDir = makeTempDir()
    const proxy = await startGatewayCostProxy({
      costDir,
      resumed: false,
      targetBaseURL: intendedUpstream.baseURL,
    })

    try {
      const hostileURL = new URL(hostileOrigin.baseURL)
      const response = await fetch(
        `${proxy.baseURL}//${hostileURL.host}/v1/messages`,
        { method: 'POST' },
      )
      expect(response.status).toBe(502)
      expect(hostileOriginReached).toBeFalse()
    } finally {
      await proxy.close()
      await intendedUpstream.close()
      await hostileOrigin.close()
    }
  })

  test('records OpenRouter usage.cost from the stream', async () => {
    const sessionId = '3b0d5d6a-6f1a-4d4e-9c2a-1f8c9b7e4a10'
    const body = `event: message_delta\ndata: ${JSON.stringify({
      id: 'gen-abc123',
      type: 'message_delta',
      usage: { cost: 0.00001596 },
    })}\n\n`
    const upstream = await startUpstream(body)
    const costDir = makeTempDir()
    const proxy = await startGatewayCostProxy({
      costDir,
      resumed: false,
      targetBaseURL: upstream.baseURL,
    })

    try {
      const response = await settleWithin(
        fetch(`${proxy.baseURL}/v1/messages`, {
          body: gatewayRequestBody(sessionId),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }),
        'stream response headers',
      )
      expect(await response.text()).toBe(body)
      expect(readGatewaySessionCost({ costDir, sessionId })).toEqual({
        exact: true,
        total: '0.00001596',
      })
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })

  test('preserves an /api prefix when forwarding to the upstream', async () => {
    let receivedPath = ''
    const sessionId = '8c2f1d0e-4a6b-4c8d-9e1f-2a3b4c5d6e7f'
    const event = gatewayCostEvent('gen_789', '0.01')
    const body = `data: ${JSON.stringify(event)}\n\n`
    const upstream = await startUpstream((request, response) => {
      receivedPath = request.url ?? ''
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(body)
    })
    const costDir = makeTempDir()
    const proxy = await startGatewayCostProxy({
      costDir,
      resumed: false,
      targetBaseURL: `${upstream.baseURL}/api`,
    })

    try {
      const response = await fetch(`${proxy.baseURL}/v1/messages`, {
        body: gatewayRequestBody(sessionId),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      expect(await response.text()).toBe(body)
      expect(receivedPath).toBe('/api/v1/messages')
      expect(readGatewaySessionCost({ costDir, sessionId })).toEqual({
        exact: true,
        total: '0.01',
      })
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })
})

function gatewayCostEvent(generationId: string, cost: string) {
  return {
    provider_metadata: {
      gateway: { cost, generationId },
    },
    type: 'message_delta',
  }
}

function gatewayRequestBody(sessionId: string) {
  return JSON.stringify({
    metadata: { user_id: JSON.stringify({ session_id: sessionId }) },
    model: 'test/model',
    stream: true,
  })
}

function makeTempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'eh-gateway-costs-'))
  tempDirs.push(dir)
  return dir
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

async function startUpstream(bodyOrHandler: RequestListener | string) {
  const server = createServer(
    typeof bodyOrHandler === 'string'
      ? (_request, response) => {
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          response.end(bodyOrHandler)
        }
      : bodyOrHandler,
  )
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('test upstream did not bind a TCP port')
  }
  return {
    baseURL: `http://127.0.0.1:${String(address.port)}`,
    close: async () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => {
          if (
            !error ||
            ('code' in error && error.code === 'ERR_SERVER_NOT_RUNNING')
          ) {
            resolve()
          } else {
            reject(error)
          }
        })
      }),
  }
}
