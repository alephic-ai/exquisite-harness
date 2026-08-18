import type {
  ClientRequest,
  IncomingHttpHeaders,
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse,
} from 'node:http'

import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import path from 'node:path'
import { z } from 'zod'

import { configDir } from './config.js'

export interface GatewayCostProxy {
  baseURL: string
  close: () => Promise<void>
}

const sessionIdSchema = z.uuid()
const sessionMetadataSchema = z.object({ session_id: sessionIdSchema })
const usdDecimalSchema = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)
const gatewayRequestSchema = z.looseObject({
  metadata: z
    .looseObject({
      user_id: z.string(),
    })
    .optional(),
})
const gatewayCostEventSchema = z.looseObject({
  provider_metadata: z.looseObject({
    gateway: z.looseObject({
      cost: usdDecimalSchema,
      generationId: z.string(),
    }),
  }),
})
const openRouterCostEventSchema = z.looseObject({
  id: z.string().optional(),
  message: z.looseObject({ id: z.string().optional() }).optional(),
  usage: z.looseObject({
    cost: z.union([usdDecimalSchema, z.number()]),
  }),
})
const ledgerEntrySchema = z.discriminatedUnion('type', [
  z.object({ complete: z.boolean(), type: z.literal('session') }),
  z.object({ requestId: z.string(), type: z.literal('pending') }),
  z.object({ requestId: z.string(), type: z.literal('settled') }),
  z.object({
    costUsd: usdDecimalSchema,
    generationId: z.string(),
    type: z.literal('cost'),
  }),
  z.object({ type: z.literal('unpriced') }),
])

export function gatewayCostsDir() {
  return path.join(configDir(), 'gateway-costs')
}

export function readGatewaySessionCost(props: {
  costDir: string
  sessionId: string
}) {
  if (!sessionIdSchema.safeParse(props.sessionId).success) return undefined
  let raw: string
  try {
    raw = readFileSync(ledgerPath(props.costDir, props.sessionId), 'utf8')
  } catch {
    return undefined
  }

  let complete: boolean | undefined
  const costs = new Map<string, string>()
  const pending = new Set<string>()
  let hasUnpriced = false
  for (const line of raw.split('\n')) {
    if (!line) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return undefined
    }
    const entry = ledgerEntrySchema.safeParse(parsed)
    if (!entry.success) return undefined
    if (entry.data.type === 'session') {
      complete = entry.data.complete
      continue
    }
    if (entry.data.type === 'pending') {
      pending.add(entry.data.requestId)
      continue
    }
    if (entry.data.type === 'settled') {
      pending.delete(entry.data.requestId)
      continue
    }
    // A request that finished without cost metadata is held against the
    // session's exactness, but it must not null out requests that did price.
    // Only when nothing is priced does the session read as unavailable.
    if (entry.data.type === 'unpriced') {
      hasUnpriced = true
      continue
    }
    const costUsd = normalizeUsdDecimal(entry.data.costUsd)
    const previous = costs.get(entry.data.generationId)
    if (previous != null && previous !== costUsd) return undefined
    costs.set(entry.data.generationId, costUsd)
  }
  if (complete !== true) return undefined
  if (costs.size === 0) return undefined
  return {
    // A pending request or one that finished without cost data keeps the total
    // partial, but does not hide the priced sum — the statusline shows it live
    // (prefixed with `~`) instead of going dark mid-conversation.
    exact: !hasUnpriced && pending.size === 0,
    total: sumUsdDecimals([...costs.values()]),
  }
}

export async function startGatewayCostProxy(props: {
  costDir: string
  resumed: boolean
  targetBaseURL: string
}) {
  const targetBaseURL = validateGatewayTargetBaseURL(props.targetBaseURL)
  const proxyProps = { ...props, targetBaseURL }
  if (typeof globalThis.Bun !== 'undefined') {
    return startBunGatewayCostProxy(proxyProps)
  }
  return startNodeGatewayCostProxy(proxyProps)
}

function appendLedgerEntry(props: {
  costDir: string
  entry: z.infer<typeof ledgerEntrySchema>
  sessionId: string
}) {
  appendFileSync(
    ledgerPath(props.costDir, props.sessionId),
    `${JSON.stringify(props.entry)}\n`,
    'utf8',
  )
}

function costToDecimal(raw: number | string) {
  if (typeof raw === 'string') return normalizeUsdDecimal(raw)
  if (!Number.isFinite(raw) || raw < 0) return undefined
  return normalizeUsdDecimal(raw.toFixed(10))
}

function createCostEventCapture(props: {
  costDir: string
  requestId: string | undefined
  sessionId: string | undefined
}) {
  const decoder = new TextDecoder()
  const seen = new Map<string, string>()
  let buffer = ''
  let captured = false

  return {
    finish() {
      buffer += decoder.decode()
      parseSseBlocks(true)
      if (props.sessionId && props.requestId) {
        if (!captured) {
          appendLedgerEntry({
            costDir: props.costDir,
            entry: { type: 'unpriced' },
            sessionId: props.sessionId,
          })
        }
        appendLedgerEntry({
          costDir: props.costDir,
          entry: {
            requestId: props.requestId,
            type: 'settled',
          },
          sessionId: props.sessionId,
        })
      }
    },
    push(chunk: Uint8Array) {
      buffer += decoder.decode(chunk, { stream: true })
      parseSseBlocks(false)
    },
  }

  function parseSseBlocks(flush: boolean) {
    for (;;) {
      const boundary = /\r?\n\r?\n/.exec(buffer)
      if (!boundary) break
      const block = buffer.slice(0, boundary.index)
      buffer = buffer.slice(boundary.index + boundary[0].length)
      parseSseBlock(block)
    }
    if (flush && buffer) parseSseBlock(buffer)
  }

  function parseSseBlock(block: string) {
    if (!props.sessionId) return
    const data = block
      .split(/\r?\n/)
      .find((line) => line.startsWith('data: '))
      ?.slice(6)
    if (!data) return
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }
    const event = gatewayCostEventSchema.safeParse(parsed)
    if (event.success) {
      recordCost(
        event.data.provider_metadata.gateway.generationId,
        event.data.provider_metadata.gateway.cost,
      )
      return
    }
    const openRouter = openRouterCostEventSchema.safeParse(parsed)
    if (!openRouter.success) return
    const costUsd = costToDecimal(openRouter.data.usage.cost)
    if (costUsd === undefined) return
    const generationId =
      openRouter.data.id ?? openRouter.data.message?.id ?? props.requestId
    if (generationId === undefined) return
    recordCost(generationId, costUsd)
  }

  function recordCost(generationId: string, rawCost: string) {
    const sessionId = props.sessionId
    if (!sessionId) return
    const costUsd = normalizeUsdDecimal(rawCost)
    const previous = seen.get(generationId)
    if (previous === costUsd) return
    seen.set(generationId, costUsd)
    captured = true
    appendLedgerEntry({
      costDir: props.costDir,
      entry: { costUsd, generationId, type: 'cost' },
      sessionId,
    })
  }
}

function ensureLedger(props: {
  complete: boolean
  costDir: string
  sessionId: string
}) {
  mkdirSync(props.costDir, { recursive: true })
  try {
    writeFileSync(
      ledgerPath(props.costDir, props.sessionId),
      `${JSON.stringify({ complete: props.complete, type: 'session' })}\n`,
      { encoding: 'utf8', flag: 'wx' },
    )
  } catch (error) {
    if (!isNodeError(error, 'EEXIST')) throw error
  }
}

async function forwardRequest(
  props: {
    costDir: string
    request: IncomingMessage
    response: ServerResponse
    resumed: boolean
    targetBaseURL: string
  },
  signal: AbortSignal,
) {
  const body = await readRequestBody(props.request)
  const upstreamURL = gatewayUpstreamURL({
    requestPath: props.request.url ?? '/',
    targetBaseURL: props.targetBaseURL,
  })
  const tracked = trackGatewayRequest({
    body,
    costDir: props.costDir,
    pathname: upstreamURL.pathname,
    resumed: props.resumed,
  })

  const method = props.request.method ?? 'GET'
  const upstreamConnection = await requestUpstream({
    body,
    headers: proxyHeaders(props.request.headers),
    method,
    signal,
    url: upstreamURL,
  })
  const upstream = upstreamConnection.response

  props.response.writeHead(
    upstream.statusCode ?? 502,
    proxyHeaders(upstream.headers),
  )

  const capture = createCostEventCapture({
    costDir: props.costDir,
    requestId: tracked.requestId,
    sessionId: tracked.sessionId,
  })
  const cancelUpstream = () => {
    const error = new Error('downstream disconnected')
    upstreamConnection.request.destroy(error)
    upstream.destroy(error)
  }
  signal.addEventListener('abort', cancelUpstream, { once: true })
  try {
    for await (const chunk of upstream) {
      if (!(chunk instanceof Uint8Array)) {
        throw new TypeError('gateway returned an unexpected response chunk')
      }
      capture.push(chunk)
      props.response.write(chunk)
    }
    if (!signal.aborted) {
      capture.finish()
      props.response.end()
    }
  } finally {
    signal.removeEventListener('abort', cancelUpstream)
  }
}

function gatewayUpstreamURL(props: {
  requestPath: string
  targetBaseURL: string
}) {
  const pathname = props.requestPath.split('?')[0]
  let allowedPath: '/v1/messages' | '/v1/messages/count_tokens'
  if (pathname === '/v1/messages') {
    allowedPath = '/v1/messages'
  } else if (pathname === '/v1/messages/count_tokens') {
    allowedPath = '/v1/messages/count_tokens'
  } else {
    throw new Error('gateway cost proxy received an unsupported path')
  }
  const target = new URL(
    props.targetBaseURL.endsWith('/')
      ? props.targetBaseURL
      : `${props.targetBaseURL}/`,
  )
  const prefix = target.pathname.replace(/\/+$/, '')
  target.pathname = `${prefix}${allowedPath}`
  return target
}

function isHopByHopHeader(name: string) {
  return ['connection', 'host', 'keep-alive', 'transfer-encoding'].includes(
    name.toLowerCase(),
  )
}

function isNodeError(error: unknown, code: string) {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code === code
  )
}

function ledgerPath(costDir: string, sessionId: string) {
  return path.join(costDir, `${sessionId}.jsonl`)
}

function normalizeUsdDecimal(value: string) {
  const [whole = '0', rawFraction = ''] = value.split('.')
  const fraction = rawFraction.replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole
}

function proxyHeaders(headers: IncomingHttpHeaders) {
  const result: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value == null || isHopByHopHeader(name)) continue
    result[name] = value
  }
  return result
}

async function proxyRequest(props: {
  costDir: string
  request: IncomingMessage
  response: ServerResponse
  resumed: boolean
  targetBaseURL: string
}) {
  const abortController = new AbortController()
  const abortUpstream = () => {
    if (!props.response.writableEnded) abortController.abort()
  }
  props.request.once('aborted', abortUpstream)
  props.response.once('close', abortUpstream)
  props.request.socket.once('close', abortUpstream)
  try {
    await forwardRequest(props, abortController.signal)
  } finally {
    props.request.off('aborted', abortUpstream)
    props.response.off('close', abortUpstream)
    props.request.socket.off('close', abortUpstream)
  }
}

function proxyWebHeaders(headers: IncomingHttpHeaders) {
  const result = new Headers()
  for (const [name, value] of Object.entries(headers)) {
    if (value == null || isHopByHopHeader(name)) continue
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item)
    } else {
      result.set(name, value)
    }
  }
  return result
}

async function proxyWebRequest(props: {
  costDir: string
  request: Request
  resumed: boolean
  targetBaseURL: string
}) {
  const incomingURL = new URL(props.request.url)
  const upstreamURL = gatewayUpstreamURL({
    requestPath: incomingURL.pathname,
    targetBaseURL: props.targetBaseURL,
  })
  const body = new Uint8Array(await props.request.arrayBuffer())
  const tracked = trackGatewayRequest({
    body,
    costDir: props.costDir,
    pathname: upstreamURL.pathname,
    resumed: props.resumed,
  })
  const upstreamConnection = await requestUpstream({
    body,
    headers: requestHeaders(props.request.headers),
    method: props.request.method,
    signal: props.request.signal,
    url: upstreamURL,
  })
  const upstream = upstreamConnection.response
  const capture = createCostEventCapture({
    costDir: props.costDir,
    requestId: tracked.requestId,
    sessionId: tracked.sessionId,
  })
  const iterator = upstream[Symbol.asyncIterator]()
  let disconnected = false
  const abortUpstream = () => {
    disconnected = true
    const error = new Error('downstream disconnected')
    upstreamConnection.request.destroy(error)
    upstream.destroy(error)
  }
  props.request.signal.addEventListener('abort', abortUpstream, { once: true })
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      abortUpstream()
      props.request.signal.removeEventListener('abort', abortUpstream)
    },
    async pull(controller) {
      try {
        const result = await iterator.next()
        if (result.done) {
          props.request.signal.removeEventListener('abort', abortUpstream)
          if (!disconnected) capture.finish()
          controller.close()
          return
        }
        const chunk: unknown = result.value
        if (!(chunk instanceof Uint8Array)) {
          throw new TypeError('gateway returned an unexpected response chunk')
        }
        capture.push(chunk)
        controller.enqueue(chunk)
      } catch (error) {
        props.request.signal.removeEventListener('abort', abortUpstream)
        controller.error(error)
      }
    },
  })
  return new Response(stream, {
    headers: proxyWebHeaders(upstream.headers),
    status: upstream.statusCode ?? 502,
  })
}

async function readRequestBody(request: IncomingMessage) {
  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = []
    request.on('data', (chunk: Uint8Array) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('aborted', () => reject(new Error('client aborted request')))
    request.on('error', reject)
  })
}

function requestHeaders(headers: Headers) {
  const result: OutgoingHttpHeaders = {}
  headers.forEach((value, name) => {
    if (!isHopByHopHeader(name)) result[name] = value
  })
  return result
}

async function requestUpstream(props: {
  body: Uint8Array
  headers: OutgoingHttpHeaders
  method: string
  signal: AbortSignal
  url: URL
}) {
  return new Promise<{
    request: ClientRequest
    response: IncomingMessage
  }>((resolve, reject) => {
    const request = props.url.protocol === 'https:' ? httpsRequest : httpRequest
    const upstream = request(
      props.url,
      {
        headers: props.headers,
        method: props.method,
        signal: props.signal,
      },
      (response) => resolve({ request: upstream, response }),
    )
    upstream.once('error', reject)
    upstream.end(
      props.method === 'GET' || props.method === 'HEAD'
        ? undefined
        : props.body,
    )
  })
}

function sessionIdFromRequestBody(body: Uint8Array) {
  let request: unknown
  try {
    request = JSON.parse(new TextDecoder().decode(body))
  } catch {
    return undefined
  }
  const parsedRequest = gatewayRequestSchema.safeParse(request)
  if (!parsedRequest.success || !parsedRequest.data.metadata) return undefined
  let metadata: unknown
  try {
    metadata = JSON.parse(parsedRequest.data.metadata.user_id)
  } catch {
    return undefined
  }
  const parsedMetadata = sessionMetadataSchema.safeParse(metadata)
  return parsedMetadata.success ? parsedMetadata.data.session_id : undefined
}

function startBunGatewayCostProxy(props: {
  costDir: string
  resumed: boolean
  targetBaseURL: string
}) {
  const server = globalThis.Bun.serve({
    fetch: async (request) => {
      try {
        return await proxyWebRequest({ ...props, request })
      } catch {
        return new Response('gateway proxy error', { status: 502 })
      }
    },
    hostname: '127.0.0.1',
    port: 0,
  })
  return {
    baseURL: `http://127.0.0.1:${String(server.port)}`,
    close: async () => server.stop(true),
  } satisfies GatewayCostProxy
}

async function startNodeGatewayCostProxy(props: {
  costDir: string
  resumed: boolean
  targetBaseURL: string
}) {
  const server = createServer((request, response) => {
    void proxyRequest({
      costDir: props.costDir,
      request,
      response,
      resumed: props.resumed,
      targetBaseURL: props.targetBaseURL,
    }).catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(502)
      response.end('gateway proxy error')
      if (error instanceof Error) response.destroy(error)
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('gateway cost proxy did not bind a TCP port')
  }

  return {
    baseURL: `http://127.0.0.1:${String(address.port)}`,
    close: async () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      }),
  } satisfies GatewayCostProxy
}

function sumUsdDecimals(values: string[]) {
  const scale = Math.max(
    0,
    ...values.map((value) => value.split('.')[1]?.length ?? 0),
  )
  const total = values.reduce((sum, value) => {
    const [whole = '0', fraction = ''] = value.split('.')
    return sum + BigInt(`${whole}${fraction.padEnd(scale, '0')}`)
  }, 0n)
  if (scale === 0) return total.toString()
  const digits = total.toString().padStart(scale + 1, '0')
  const whole = digits.slice(0, -scale)
  const fraction = digits.slice(-scale).replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole
}

function trackGatewayRequest(props: {
  body: Uint8Array
  costDir: string
  pathname: string
  resumed: boolean
}) {
  const parsedSessionId = sessionIdFromRequestBody(props.body)
  const sessionId = props.pathname.endsWith('/v1/messages')
    ? parsedSessionId
    : undefined
  const requestId = sessionId ? randomUUID() : undefined
  if (sessionId && requestId) {
    ensureLedger({
      complete: !props.resumed,
      costDir: props.costDir,
      sessionId,
    })
    appendLedgerEntry({
      costDir: props.costDir,
      entry: { requestId, type: 'pending' },
      sessionId,
    })
  }
  return { requestId, sessionId }
}

function validateGatewayTargetBaseURL(targetBaseURL: string) {
  const target = new URL(targetBaseURL)
  if (
    target.username !== '' ||
    target.password !== '' ||
    target.search !== '' ||
    target.hash !== ''
  ) {
    throw new Error('gateway cost proxy target is not allowed')
  }
  const path = target.pathname.replace(/\/+$/, '') || '/'
  const isVercel =
    target.protocol === 'https:' &&
    target.hostname === 'ai-gateway.vercel.sh' &&
    target.port === '' &&
    path === '/'
  const isOpenRouter =
    target.protocol === 'https:' &&
    target.hostname === 'openrouter.ai' &&
    target.port === '' &&
    path === '/api'
  const isLoopbackFixture =
    target.protocol === 'http:' &&
    target.hostname === '127.0.0.1' &&
    target.port !== '' &&
    (path === '/' || path === '/api')
  if (!isVercel && !isOpenRouter && !isLoopbackFixture) {
    throw new Error('gateway cost proxy target is not allowed')
  }
  return `${target.origin}${path === '/' ? '' : path}`
}
