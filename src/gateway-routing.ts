import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from 'node:http'

import { once } from 'node:events'
import { createServer } from 'node:http'
import { z } from 'zod'

import type { LaunchPlan } from './types.js'

const requestBodySchema = z.record(z.string(), z.unknown())
const INFERENCE_PATHS = [
  '/chat/completions',
  '/messages',
  '/responses',
] as const
const MODEL_DISCOVERY_PATH = '/models'

export async function withGatewayRouting<T>(
  plan: LaunchPlan,
  run: (routedPlan: LaunchPlan) => Promise<T>,
) {
  if (!plan.gatewayRouting) return run(plan)

  const proxy = await startGatewayRoutingProxy({
    provider: plan.gatewayRouting.provider,
    targetBaseURL: plan.gatewayRouting.targetBaseURL,
  })
  try {
    return await run(routePlanThroughProxy(plan, proxy.baseURL))
  } finally {
    await proxy.close()
  }
}

function allowedGatewayPath(pathname: string, apiBasePath: string) {
  if (pathname === `${apiBasePath}/chat/completions`) {
    return '/chat/completions'
  }
  if (pathname === `${apiBasePath}/messages`) return '/messages'
  if (pathname === `${apiBasePath}/responses`) return '/responses'
  if (pathname === `${apiBasePath}/messages/count_tokens`) {
    return '/messages/count_tokens'
  }
  if (pathname === `${apiBasePath}/models`) return '/models'
  throw new Error('unsupported request path')
}

function asRecord(value: unknown) {
  const parsed = requestBodySchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

async function forwardRequest(props: {
  activeRequests: Set<AbortController>
  provider: string
  request: IncomingMessage
  response: ServerResponse
  target: URL
}) {
  const controller = new AbortController()
  const abortUpstream = () => {
    if (!props.response.writableEnded) controller.abort()
  }
  props.activeRequests.add(controller)
  props.request.once('aborted', abortUpstream)
  props.response.once('close', abortUpstream)
  props.request.socket.once('close', abortUpstream)
  try {
    const upstreamURL = gatewayUpstreamURL(
      props.request.url ?? '/',
      props.target,
    )
    const method = props.request.method ?? 'GET'
    const isModelDiscovery = upstreamURL.pathname.endsWith(MODEL_DISCOVERY_PATH)
    if (method !== 'POST' && !(method === 'GET' && isModelDiscovery)) {
      throw new Error('unsupported request method')
    }
    const rawBody =
      method === 'POST' ? await readRequestBody(props.request) : undefined
    const body = isInferencePath(upstreamURL.pathname)
      ? routeRequestBody(rawBody ?? Buffer.alloc(0), props.provider)
      : rawBody
    const headers = requestHeaders(props.request.headers)
    const upstream = await fetch(upstreamURL, {
      body,
      headers,
      method,
      redirect: 'manual',
      signal: controller.signal,
    })

    props.response.statusCode = upstream.status
    for (const [name, value] of upstream.headers) {
      if (!isResponseTransportHeader(name)) {
        props.response.setHeader(name, value)
      }
    }
    if (upstream.body) {
      for await (const chunk of upstream.body) {
        if (props.response.destroyed) break
        if (!props.response.write(chunk)) {
          await once(props.response, 'drain')
        }
      }
    }
    props.response.end()
  } catch (error) {
    const message = error instanceof Error ? error.message : 'request failed'
    if (props.response.headersSent) {
      props.response.destroy(error instanceof Error ? error : undefined)
    } else {
      props.response.statusCode = 502
      props.response.end(`eh gateway routing proxy: ${message}`)
    }
  } finally {
    props.request.off('aborted', abortUpstream)
    props.response.off('close', abortUpstream)
    props.request.socket.off('close', abortUpstream)
    props.activeRequests.delete(controller)
  }
}

function gatewayUpstreamURL(requestPath: string, target: URL) {
  if (!requestPath.startsWith('/') || requestPath.startsWith('//')) {
    throw new Error('unsupported request path')
  }
  const incoming = new URL(requestPath, 'http://gateway-routing.local')
  const apiBasePath = target.pathname.endsWith('/v1')
    ? target.pathname
    : `${target.pathname}/v1`.replace('//', '/')
  const allowedPath = allowedGatewayPath(incoming.pathname, apiBasePath)
  const query = [...incoming.searchParams]
    .map(
      ([name, value]) =>
        `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
    )
    .join('&')
  return new URL(
    `${apiBasePath}${allowedPath}${query ? `?${query}` : ''}`,
    target.origin,
  )
}

function isInferencePath(pathname: string) {
  return INFERENCE_PATHS.some((path) => pathname.endsWith(path))
}

function isResponseTransportHeader(name: string) {
  return [
    'connection',
    'content-encoding',
    'content-length',
    'keep-alive',
    'transfer-encoding',
  ].includes(name.toLowerCase())
}

async function readRequestBody(request: IncomingMessage) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer | string) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

function requestHeaders(incoming: IncomingHttpHeaders) {
  const headers = new Headers()
  for (const [name, rawValue] of Object.entries(incoming)) {
    if (
      rawValue === undefined ||
      ['connection', 'content-length', 'host', 'transfer-encoding'].includes(
        name.toLowerCase(),
      )
    ) {
      continue
    }
    for (const value of Array.isArray(rawValue) ? rawValue : [rawValue]) {
      headers.append(name, value)
    }
  }
  return headers
}

function routePlanThroughProxy(plan: LaunchPlan, proxyBaseURL: string) {
  const routing = plan.gatewayRouting
  if (!routing) return plan
  const targetBaseURL = routing.targetBaseURL
  const target = new URL(targetBaseURL)
  const routedBaseURL = `${proxyBaseURL}${target.pathname === '/' ? '' : target.pathname}`
  const launchValues = [...plan.args, ...Object.values(plan.env)]
  if (!launchValues.some((value) => value.includes(targetBaseURL))) {
    throw new Error('gateway routing could not find the launch-plan base URL')
  }
  function replaceBaseURL(value: string) {
    return value.replaceAll(targetBaseURL, routedBaseURL)
  }
  const { gatewayRouting: _gatewayRouting, ...unroutedPlan } = plan
  const routedPlan = {
    ...unroutedPlan,
    args: plan.args.map(replaceBaseURL),
    env: Object.fromEntries(
      Object.entries(plan.env).map(([key, value]) => [
        key,
        replaceBaseURL(value),
      ]),
    ),
    ...(plan.searchProxy
      ? {
          searchProxy: {
            ...plan.searchProxy,
            upstreamBaseURL: replaceBaseURL(plan.searchProxy.upstreamBaseURL),
          },
        }
      : {}),
  }
  return routedPlan
}

function routeRequestBody(body: Buffer, provider: string) {
  const parsed = requestBodySchema.parse(JSON.parse(body.toString('utf8')))
  const providerOptions = asRecord(parsed.providerOptions) ?? {}
  const gateway = asRecord(providerOptions.gateway) ?? {}
  return JSON.stringify({
    ...parsed,
    providerOptions: {
      ...providerOptions,
      gateway: { ...gateway, only: [provider] },
    },
  })
}

async function startGatewayRoutingProxy(props: {
  provider: string
  targetBaseURL: string
}) {
  const target = validateTargetBaseURL(props.targetBaseURL)
  const activeRequests = new Set<AbortController>()
  const server = createServer((request, response) => {
    void forwardRequest({
      activeRequests,
      provider: props.provider,
      request,
      response,
      target,
    })
  })

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
    throw new Error('gateway routing proxy did not bind a TCP port')
  }

  return {
    baseURL: `http://127.0.0.1:${String(address.port)}`,
    close: async () => {
      for (const controller of activeRequests) controller.abort()
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

function validateTargetBaseURL(raw: string) {
  const target = new URL(raw)
  if (
    !['http:', 'https:'].includes(target.protocol) ||
    target.username !== '' ||
    target.password !== '' ||
    target.search !== '' ||
    target.hash !== ''
  ) {
    throw new Error('invalid gateway target base URL')
  }
  target.pathname = target.pathname.replace(/\/+$/, '') || '/'
  return target
}
