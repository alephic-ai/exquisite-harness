import { randomUUID } from 'node:crypto'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  STATUS_CODES,
} from 'node:http'
import { z } from 'zod'

import type { SearchProxy } from './types.js'

import { scrapeFirecrawl, searchFirecrawl } from './search-provider.js'

const contentBlockSchema = z.looseObject({
  text: z.string().optional(),
  type: z.string(),
})

const messagesRequestSchema = z.looseObject({
  messages: z.array(
    z.looseObject({
      content: z.union([z.string(), z.array(contentBlockSchema)]),
      role: z.string(),
    }),
  ),
  model: z.string(),
  stream: z.boolean().optional(),
  tools: z.array(
    z.looseObject({
      allowed_domains: z.array(z.string()).optional(),
      blocked_domains: z.array(z.string()).optional(),
      type: z.string().optional(),
    }),
  ),
})

const webFetchToolInputSchema = z.looseObject({
  prompt: z.string(),
  url: z.url(),
})

const webFetchHookSchema = z.discriminatedUnion('hook_event_name', [
  z.looseObject({
    hook_event_name: z.literal('PostToolUse'),
    tool_input: webFetchToolInputSchema,
    tool_name: z.literal('WebFetch'),
    tool_response: z.looseObject({
      bytes: z.number(),
      code: z.number(),
      codeText: z.string(),
      durationMs: z.number(),
      result: z.string(),
      url: z.string(),
    }),
  }),
  z.looseObject({
    hook_event_name: z.literal('PostToolUseFailure'),
    tool_input: webFetchToolInputSchema,
    tool_name: z.literal('WebFetch'),
  }),
])

const SEARCH_PROMPT_PREFIX = 'Perform a web search for the query: '

export async function startSearchProxy(config: SearchProxy) {
  const server = createServer((request, response) => {
    void handleRequest(request, response, config).catch((error: unknown) => {
      sendError(response, error)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('search proxy did not bind a TCP port')
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
  }
}

function firecrawlFetchResult(props: {
  markdown: string
  prompt: string
  url: string
}) {
  return `Firecrawl fetched ${props.url} for the WebFetch prompt ${JSON.stringify(props.prompt)}:\n\n${props.markdown}`
}

function forwardedRequestHeaders(request: IncomingMessage) {
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (
      value === undefined ||
      name === 'connection' ||
      name === 'content-length' ||
      name === 'host'
    ) {
      continue
    }
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item)
    } else {
      headers.set(name, value)
    }
  }
  return headers
}

function forwardedResponseHeaders(response: Response) {
  const headers = new Headers(response.headers)
  headers.delete('connection')
  headers.delete('content-encoding')
  headers.delete('content-length')
  headers.delete('transfer-encoding')
  return Object.fromEntries(headers.entries())
}

async function forwardRequest(
  request: IncomingMessage,
  response: ServerResponse,
  upstreamBaseURL: string,
  body: Buffer,
) {
  const upstream = await fetch(upstreamURL(upstreamBaseURL, request.url), {
    body:
      request.method === 'GET' || request.method === 'HEAD' ? undefined : body,
    headers: forwardedRequestHeaders(request),
    method: request.method,
  })
  response.writeHead(upstream.status, forwardedResponseHeaders(upstream))
  if (!upstream.body) {
    response.end()
    return
  }
  const reader = upstream.body.getReader()
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    response.write(chunk.value)
  }
  response.end()
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: SearchProxy,
) {
  const body = await readBody(request)
  if (request.method === 'POST' && request.url === '/hooks/web-fetch') {
    await handleWebFetchHook(response, config, body)
    return
  }
  const messagesRequest = parseMessagesRequest(body)
  if (
    request.method === 'POST' &&
    requestPath(request.url) === '/v1/messages' &&
    messagesRequest &&
    isWebSearchRequest(messagesRequest)
  ) {
    const query = searchQuery(messagesRequest)
    const tool = webSearchTool(messagesRequest)
    if (!tool) throw new Error('could not find the Claude Code WebSearch tool')
    const search = await runSearch(config, {
      excludeDomains: tool.blocked_domains,
      includeDomains: tool.allowed_domains,
      query,
    })
    sendAnthropicMessage(response, {
      model: messagesRequest.model,
      query,
      search,
      stream: messagesRequest.stream === true,
    })
    return
  }
  await forwardRequest(request, response, config.upstreamBaseURL, body)
}

async function handleWebFetchHook(
  response: ServerResponse,
  config: SearchProxy,
  body: Buffer,
) {
  let data: unknown
  try {
    data = JSON.parse(body.toString('utf8')) as unknown
  } catch {
    throw new Error('Claude Code WebFetch hook sent invalid JSON')
  }
  const parsed = webFetchHookSchema.safeParse(data)
  if (!parsed.success) {
    throw new Error('Claude Code WebFetch hook sent an unexpected payload')
  }
  const scrape = await scrapeFirecrawl({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    url: parsed.data.tool_input.url,
  })
  const result = firecrawlFetchResult({
    markdown: scrape.markdown,
    prompt: parsed.data.tool_input.prompt,
    url: parsed.data.tool_input.url,
  })

  if (parsed.data.hook_event_name === 'PostToolUseFailure') {
    sendJson(response, {
      hookSpecificOutput: {
        additionalContext: `Native WebFetch failed, but ${result}`,
        hookEventName: 'PostToolUseFailure',
      },
    })
    return
  }

  const code = scrape.statusCode ?? parsed.data.tool_response.code
  sendJson(response, {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      updatedToolOutput: {
        ...parsed.data.tool_response,
        bytes: Buffer.byteLength(scrape.markdown),
        code,
        codeText:
          scrape.statusCode === undefined
            ? parsed.data.tool_response.codeText
            : (STATUS_CODES[code] ?? 'Unknown'),
        result,
        url: parsed.data.tool_input.url,
      },
    },
  })
}

function isWebSearchRequest(request: z.infer<typeof messagesRequestSchema>) {
  return webSearchTool(request) !== undefined
}

function parseMessagesRequest(body: Buffer) {
  if (body.length === 0) return undefined
  try {
    return messagesRequestSchema.safeParse(JSON.parse(body.toString('utf8')))
      .data
  } catch {
    return undefined
  }
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const rawChunk of request) {
    const chunk: unknown = rawChunk
    if (typeof chunk === 'string' || chunk instanceof Uint8Array) {
      chunks.push(Buffer.from(chunk))
      continue
    }
    throw new Error('search proxy received an unexpected request body chunk')
  }
  return Buffer.concat(chunks)
}

function requestPath(requestURL: string | undefined) {
  return new URL(requestURL ?? '/', 'http://search-proxy.local').pathname
}

async function runSearch(
  config: SearchProxy,
  request: {
    excludeDomains?: string[]
    includeDomains?: string[]
    query: string
  },
) {
  return searchFirecrawl({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    ...request,
  })
}

function searchQuery(request: z.infer<typeof messagesRequestSchema>) {
  const text = request.messages
    .flatMap((message) =>
      typeof message.content === 'string'
        ? [message.content]
        : message.content.flatMap((block) =>
            block.type === 'text' && block.text ? [block.text] : [],
          ),
    )
    .findLast((value) => value.startsWith(SEARCH_PROMPT_PREFIX))
  if (!text) {
    throw new Error('could not extract the query from Claude Code WebSearch')
  }
  const query = text.slice(SEARCH_PROMPT_PREFIX.length).trim()
  if (!query) throw new Error('Claude Code WebSearch sent an empty query')
  return query
}

function sendAnthropicMessage(
  response: ServerResponse,
  props: {
    model: string
    query: string
    search: Awaited<ReturnType<typeof searchFirecrawl>>
    stream: boolean
  },
) {
  const suffix = randomUUID().replaceAll('-', '')
  const messageId = `msg_eh_${suffix}`
  const toolUseId = `srvtoolu_eh_${suffix}`
  const resultContent = props.search.results.map((result) => ({
    title: result.title,
    type: 'web_search_result',
    url: result.url,
  }))
  const content = [
    {
      id: toolUseId,
      input: { query: props.query },
      name: 'web_search',
      type: 'server_tool_use',
    },
    {
      content: resultContent,
      tool_use_id: toolUseId,
      type: 'web_search_tool_result',
    },
    { text: props.search.text, type: 'text' },
  ]
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    server_tool_use: { web_search_requests: 1 },
  }
  if (!props.stream) {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(
      JSON.stringify({
        content,
        id: messageId,
        model: props.model,
        role: 'assistant',
        stop_reason: 'end_turn',
        stop_sequence: null,
        type: 'message',
        usage,
      }),
    )
    return
  }

  response.writeHead(200, {
    'Cache-Control': 'no-cache',
    'Content-Type': 'text/event-stream',
  })
  writeEvent(response, 'message_start', {
    message: {
      content: [],
      id: messageId,
      model: props.model,
      role: 'assistant',
      stop_reason: null,
      stop_sequence: null,
      type: 'message',
      usage,
    },
    type: 'message_start',
  })
  writeEvent(response, 'content_block_start', {
    content_block: {
      id: toolUseId,
      input: {},
      name: 'web_search',
      type: 'server_tool_use',
    },
    index: 0,
    type: 'content_block_start',
  })
  writeEvent(response, 'content_block_delta', {
    delta: {
      partial_json: JSON.stringify({ query: props.query }),
      type: 'input_json_delta',
    },
    index: 0,
    type: 'content_block_delta',
  })
  writeEvent(response, 'content_block_stop', {
    index: 0,
    type: 'content_block_stop',
  })
  writeEvent(response, 'content_block_start', {
    content_block: {
      content: resultContent,
      tool_use_id: toolUseId,
      type: 'web_search_tool_result',
    },
    index: 1,
    type: 'content_block_start',
  })
  writeEvent(response, 'content_block_stop', {
    index: 1,
    type: 'content_block_stop',
  })
  writeEvent(response, 'content_block_start', {
    content_block: { text: '', type: 'text' },
    index: 2,
    type: 'content_block_start',
  })
  writeEvent(response, 'content_block_delta', {
    delta: { text: props.search.text, type: 'text_delta' },
    index: 2,
    type: 'content_block_delta',
  })
  writeEvent(response, 'content_block_stop', {
    index: 2,
    type: 'content_block_stop',
  })
  writeEvent(response, 'message_delta', {
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    type: 'message_delta',
    usage,
  })
  writeEvent(response, 'message_stop', { type: 'message_stop' })
  response.end()
}

function sendError(response: ServerResponse, error: unknown) {
  if (response.headersSent) {
    response.destroy(error instanceof Error ? error : undefined)
    return
  }
  response.writeHead(502, { 'Content-Type': 'application/json' })
  response.end(
    JSON.stringify({
      error: {
        message: error instanceof Error ? error.message : 'search proxy failed',
        type: 'api_error',
      },
      type: 'error',
    }),
  )
}

function sendJson(response: ServerResponse, body: unknown) {
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}

function upstreamURL(baseURL: string, requestURL: string | undefined) {
  // Accept only the incoming path/query. An absolute-form proxy request must
  // never override the configured upstream origin and carry provider auth to
  // an arbitrary host.
  const incoming = new URL(requestURL ?? '/', 'http://search-proxy.local')
  const upstream = new URL(baseURL)
  upstream.hash = ''
  const prefix = upstream.pathname.replace(/\/+$/, '')
  upstream.pathname = `${prefix}${incoming.pathname}` || '/'
  upstream.search = incoming.search
  return upstream
}

function webSearchTool(request: z.infer<typeof messagesRequestSchema>) {
  return request.tools.find((tool) => tool.type?.startsWith('web_search_'))
}

function writeEvent(response: ServerResponse, event: string, data: unknown) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}
