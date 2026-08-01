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
      expect(total).toBe('0.000016')
      expect(total && formatExactSessionCostUsd(total)).toBe('$0.000016')
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
