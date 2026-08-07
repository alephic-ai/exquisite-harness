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
const gatewayEndpointsSchema = z.object({
  data: z.looseObject({
    endpoints: z.array(
      z.looseObject({
        provider_name: z.string(),
        status: z.number().optional(),
      }),
    ),
  }),
})
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

  const validatedModels = new Map<string, Promise<void>>()
  await validateGatewayProvider({
    headers: gatewayValidationHeaders(plan),
    model: plan.gatewayRouting.model,
    provider: plan.gatewayRouting.provider,
    target: validateTargetBaseURL(plan.gatewayRouting.targetBaseURL),
    validatedModels,
  })
  const proxy = await startGatewayRoutingProxy({
    provider: plan.gatewayRouting.provider,
    targetBaseURL: plan.gatewayRouting.targetBaseURL,
    validatedModels,
    zdr: plan.gatewayRouting.zdr,
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

async function fetchGatewayProviders(props: {
  headers: Headers
  model: string
  target: URL
}) {
  const apiBasePath = props.target.pathname.endsWith('/v1')
    ? props.target.pathname
    : `${props.target.pathname}/v1`.replace('//', '/')
  const modelPath = props.model.split('/').map(encodeURIComponent).join('/')
  const url = new URL(
    `${apiBasePath}/models/${modelPath}/endpoints`,
    props.target.origin,
  )
  const response = await fetch(url, {
    headers: props.headers,
    redirect: 'manual',
  })
  if (!response.ok) {
    throw new Error(
      `could not validate gateway provider: HTTP ${String(response.status)} from ${url.toString()}`,
    )
  }
  const body: unknown = await response.json()
  const endpoints = gatewayEndpointsSchema.parse(body).data.endpoints
  return [
    ...new Set(
      endpoints
        .filter(
          (endpoint) => endpoint.status === undefined || endpoint.status === 0,
        )
        .map((endpoint) => endpoint.provider_name),
    ),
  ]
}

async function forwardRequest(props: {
  activeRequests: Set<AbortController>
  provider: string | undefined
  request: IncomingMessage
  response: ServerResponse
  target: URL
  validatedModels: Map<string, Promise<void>>
  zdr: boolean | undefined
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
    const headers = requestHeaders(props.request.headers)
    const routed = isInferencePath(upstreamURL.pathname)
      ? routeRequestBody(rawBody ?? Buffer.alloc(0), {
          provider: props.provider,
          zdr: props.zdr,
        })
      : undefined
    if (routed) {
      await validateGatewayProvider({
        headers,
        model: routed.model,
        provider: props.provider,
        target: props.target,
        validatedModels: props.validatedModels,
      })
    }
    const upstream = await fetch(upstreamURL, {
      body: routed?.body ?? rawBody,
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

function gatewayValidationHeaders(plan: LaunchPlan) {
  const headers = new Headers()
  const routing = plan.gatewayRouting
  if (!routing) return headers
  const apiKey = [
    planEnvValue(plan, routing.apiKeyEnvKey),
    routing.apiKeyEnvKey ? process.env[routing.apiKeyEnvKey] : undefined,
    planEnvValue(plan, 'ANTHROPIC_AUTH_TOKEN'),
    planEnvValue(plan, 'XAI_API_KEY'),
  ].find((value) => value !== undefined && value.trim().length > 0)
  if (apiKey) headers.set('authorization', `Bearer ${apiKey}`)
  return headers
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

function planEnvValue(plan: LaunchPlan, key: string | undefined) {
  return key && Object.hasOwn(plan.env, key) ? plan.env[key] : undefined
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

function routeRequestBody(
  body: Buffer,
  route: { provider: string | undefined; zdr: boolean | undefined },
) {
  const parsed = requestBodySchema.parse(JSON.parse(body.toString('utf8')))
  if (typeof parsed.model !== 'string' || parsed.model.length === 0) {
    throw new Error('gateway routing request is missing a model')
  }
  const providerOptions = asRecord(parsed.providerOptions) ?? {}
  const gateway = asRecord(providerOptions.gateway) ?? {}
  const injection = {
    ...gateway,
    ...(route.provider !== undefined ? { only: [route.provider] } : {}),
    ...(route.zdr === true ? { zeroDataRetention: true } : {}),
  }
  return {
    body: JSON.stringify({
      ...parsed,
      providerOptions: {
        ...providerOptions,
        gateway: injection,
      },
    }),
    model: parsed.model,
  }
}

async function startGatewayRoutingProxy(props: {
  provider: string | undefined
  targetBaseURL: string
  validatedModels?: Map<string, Promise<void>>
  zdr: boolean | undefined
}) {
  const target = validateTargetBaseURL(props.targetBaseURL)
  const activeRequests = new Set<AbortController>()
  const validatedModels =
    props.validatedModels ?? new Map<string, Promise<void>>()
  const server = createServer((request, response) => {
    void forwardRequest({
      activeRequests,
      provider: props.provider,
      request,
      response,
      target,
      validatedModels,
      zdr: props.zdr,
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

async function validateGatewayProvider(props: {
  headers: Headers
  model: string
  provider: string | undefined
  target: URL
  validatedModels: Map<string, Promise<void>>
}) {
  // ZDR-only routing has no pinned provider to validate — Vercel handles the
  // ZDR restriction itself, so validation only applies to a pinned slug.
  if (props.provider === undefined) return
  const { provider } = props
  const cacheKey = `${props.model}\0${provider}`
  let validation = props.validatedModels.get(cacheKey)
  if (!validation) {
    validation = fetchGatewayProviders(props).then((providers) => {
      if (!providers.includes(provider)) {
        const available = providers.length > 0 ? providers.join(', ') : 'none'
        throw new Error(
          `gateway provider "${provider}" is unavailable for model "${props.model}" (available: ${available})`,
        )
      }
    })
    props.validatedModels.set(cacheKey, validation)
  }
  try {
    await validation
  } catch (error) {
    props.validatedModels.delete(cacheKey)
    throw error
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
