import { afterEach, describe, expect, test } from 'bun:test'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { connect } from 'node:net'

import { exec as launch } from './launch.js'
import { startSearchProxy } from './search-proxy.js'

const openServers: Server[] = []

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(closeServer))
})

describe('search proxy', () => {
  test('routes Claude Code server WebSearch requests through Firecrawl', async () => {
    let firecrawlAuthorization: string | undefined
    let firecrawlRequest: unknown
    let upstreamRequests = 0
    const firecrawlBaseURL = await listen(async (request, response) => {
      firecrawlAuthorization = request.headers.authorization
      firecrawlRequest = JSON.parse((await requestText(request)) || '{}')
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          data: {
            web: [
              {
                description: 'An answer from Firecrawl',
                title: 'Example result',
                url: 'https://example.com/result',
              },
            ],
          },
          success: true,
        }),
      )
    })
    const upstreamBaseURL = await listen((_request, response) => {
      upstreamRequests += 1
      response.writeHead(500)
      response.end()
    })
    const proxy = await startSearchProxy({
      apiKey: 'fc-test',
      baseURL: firecrawlBaseURL,
      envKey: 'FIRECRAWL_API_KEY',
      type: 'firecrawl',
      upstreamBaseURL,
    })

    try {
      const response = await fetch(`${proxy.baseURL}/v1/messages?beta=true`, {
        body: JSON.stringify({
          messages: [
            {
              content: [
                {
                  text: 'Perform a web search for the query: exquisite harness',
                  type: 'text',
                },
              ],
              role: 'user',
            },
          ],
          model: 'deepseek/deepseek-v4-flash',
          stream: true,
          tools: [{ name: 'web_search', type: 'web_search_20250305' }],
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })
      const body = await response.text()

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('text/event-stream')
      expect(body).toContain('event: message_start')
      expect(body).toContain('"type":"server_tool_use"')
      expect(body).toContain('"type":"web_search_tool_result"')
      expect(body).toContain('"web_search_requests":1')
      expect(body).toContain('[Example result](https://example.com/result)')
      expect(firecrawlAuthorization).toBe('Bearer fc-test')
      expect(firecrawlRequest).toEqual(
        expect.objectContaining({
          limit: 10,
          query: 'exquisite harness',
          sources: ['web'],
        }),
      )
      expect(upstreamRequests).toBe(0)
    } finally {
      await proxy.close()
    }
  })

  test('maps Claude WebSearch domain constraints to Firecrawl', async () => {
    const firecrawlRequests: unknown[] = []
    const firecrawlBaseURL = await listen(async (request, response) => {
      firecrawlRequests.push(JSON.parse((await requestText(request)) || '{}'))
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ data: { web: [] }, success: true }))
    })
    const upstreamBaseURL = await listen((_request, response) => {
      response.writeHead(500)
      response.end()
    })
    const proxy = await startSearchProxy({
      apiKey: 'fc-test',
      baseURL: firecrawlBaseURL,
      envKey: 'FIRECRAWL_API_KEY',
      type: 'firecrawl',
      upstreamBaseURL,
    })

    try {
      const allowedRequest = {
        ...webSearchRequest('domain filters', false),
        tools: [
          {
            allowed_domains: ['example.com'],
            type: 'web_search_20250305',
          },
        ],
      }
      const blockedRequest = {
        ...webSearchRequest('domain filters', false),
        tools: [
          {
            blocked_domains: ['blocked.example'],
            type: 'web_search_20250305',
          },
        ],
      }
      const allowedResponse = await fetch(`${proxy.baseURL}/v1/messages`, {
        body: JSON.stringify(allowedRequest),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })
      const blockedResponse = await fetch(`${proxy.baseURL}/v1/messages`, {
        body: JSON.stringify(blockedRequest),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })

      expect(allowedResponse.status).toBe(200)
      expect(blockedResponse.status).toBe(200)
      expect(firecrawlRequests).toHaveLength(2)
      expect(firecrawlRequests[0]).toEqual(
        expect.objectContaining({
          includeDomains: ['example.com'],
        }),
      )
      expect(firecrawlRequests[1]).toEqual(
        expect.objectContaining({ excludeDomains: ['blocked.example'] }),
      )
    } finally {
      await proxy.close()
    }
  })

  test('returns normalized Firecrawl results as a non-stream Anthropic message', async () => {
    const firecrawlBaseURL = await listen((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          data: {
            web: [
              {
                description: '  First   line\nsecond line  ',
                title: '  Result [one]  ',
                url: 'https://example.com/one',
              },
              {
                description: null,
                title: '   ',
                url: 'http://example.org/two',
              },
              {
                markdown: 'Document-shaped search result',
                metadata: {
                  description: 'SDK document description',
                  title: 'SDK document result',
                  url: 'https://docs.example.net/three',
                },
              },
              {
                title: 'Unsafe result',
                url: 'file:///tmp/private',
              },
            ],
          },
          success: true,
        }),
      )
    })
    const upstreamBaseURL = await listen((_request, response) => {
      response.writeHead(500)
      response.end()
    })
    const proxy = await startSearchProxy({
      apiKey: 'fc-test',
      baseURL: `${firecrawlBaseURL}/`,
      envKey: 'FIRECRAWL_API_KEY',
      type: 'firecrawl',
      upstreamBaseURL,
    })

    try {
      const response = await fetch(`${proxy.baseURL}/v1/messages`, {
        body: JSON.stringify(webSearchRequest('normalized results', false)),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })
      const body = await response.text()

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('application/json')
      expect(body).toContain('"type":"server_tool_use"')
      expect(body).toContain('"type":"web_search_tool_result"')
      expect(body).toContain('[Result \\\\[one\\\\]](https://example.com/one)')
      expect(body).toContain('First line second line')
      expect(body).toContain('[example.org](http://example.org/two)')
      expect(body).toContain(
        '[SDK document result](https://docs.example.net/three)',
      )
      expect(body).toContain('SDK document description')
      expect(body).not.toContain('file:///tmp/private')
    } finally {
      await proxy.close()
    }
  })

  test('returns a successful structured search when Firecrawl finds nothing', async () => {
    const firecrawlBaseURL = await listen((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ data: { web: [] }, success: true }))
    })
    const upstreamBaseURL = await listen((_request, response) => {
      response.writeHead(500)
      response.end()
    })
    const proxy = await startSearchProxy({
      apiKey: 'fc-test',
      baseURL: firecrawlBaseURL,
      envKey: 'FIRECRAWL_API_KEY',
      type: 'firecrawl',
      upstreamBaseURL,
    })

    try {
      const response = await fetch(`${proxy.baseURL}/v1/messages`, {
        body: JSON.stringify(webSearchRequest('no matching pages', false)),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })
      const body = await response.text()

      expect(response.status).toBe(200)
      expect(body).toContain('"content":[]')
      expect(body).toContain(
        'Firecrawl returned no web results for: no matching pages',
      )
      expect(body).toContain('"web_search_requests":1')
    } finally {
      await proxy.close()
    }
  })

  test('forwards ordinary Anthropic Messages requests and streamed responses', async () => {
    let upstreamAuthorization: string | undefined
    let upstreamBody = ''
    const upstreamBaseURL = await listen(async (request, response) => {
      upstreamAuthorization = request.headers.authorization
      upstreamBody = await requestText(request)
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end('event: message_stop\ndata: {"type":"message_stop"}\n\n')
    })
    const proxy = await startSearchProxy({
      apiKey: 'fc-test',
      baseURL: 'http://127.0.0.1:1',
      envKey: 'FIRECRAWL_API_KEY',
      type: 'firecrawl',
      upstreamBaseURL,
    })
    const requestBody = JSON.stringify({
      messages: [{ content: 'hello', role: 'user' }],
      model: 'deepseek/deepseek-v4-flash',
      stream: true,
      tools: [{ name: 'WebSearch' }],
    })

    try {
      const response = await fetch(`${proxy.baseURL}/v1/messages?beta=true`, {
        body: requestBody,
        headers: {
          'Authorization': 'Bearer gateway-test',
          'Content-Type': 'application/json',
        },
        method: 'POST',
      })

      expect(response.status).toBe(200)
      expect(await response.text()).toBe(
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      )
      expect(upstreamAuthorization).toBe('Bearer gateway-test')
      expect(upstreamBody).toBe(requestBody)
    } finally {
      await proxy.close()
    }
  })

  test('aborts the upstream request when the downstream client disconnects', async () => {
    let destroyUpstream: (() => void) | undefined
    let markUpstreamClosed: (() => void) | undefined
    const upstreamClosed = new Promise<void>((resolve) => {
      markUpstreamClosed = resolve
    })
    const upstreamBaseURL = await listen((request, response) => {
      const interval = setInterval(() => {
        response.write('event: ping\ndata: {}\n\n')
      }, 10)
      destroyUpstream = () => {
        clearInterval(interval)
        response.destroy()
      }
      request.once('aborted', () => {
        clearInterval(interval)
        markUpstreamClosed?.()
      })
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write('event: ping\ndata: {}\n\n')
    })
    const proxy = await startSearchProxy({
      apiKey: 'fc-test',
      baseURL: 'http://127.0.0.1:1',
      envKey: 'FIRECRAWL_API_KEY',
      type: 'firecrawl',
      upstreamBaseURL,
    })
    let proxyClosed = false

    try {
      const body = JSON.stringify({
        messages: [{ content: 'hello', role: 'user' }],
        model: 'test-model',
        stream: true,
        tools: [],
      })
      const proxyURL = new URL(proxy.baseURL)
      await settleWithin(
        new Promise<void>((resolve, reject) => {
          const socket = connect(
            Number(proxyURL.port),
            proxyURL.hostname,
            () => {
              socket.write(
                [
                  'POST /v1/messages HTTP/1.1',
                  `Host: ${proxyURL.host}`,
                  'Content-Type: application/json',
                  `Content-Length: ${String(Buffer.byteLength(body))}`,
                  '',
                  body,
                ].join('\r\n'),
              )
            },
          )
          socket.once('data', () => {
            socket.destroy()
            resolve()
          })
          socket.once('error', reject)
        }),
        'downstream disconnect',
      )
      await settleWithin(proxy.close(), 'abort-test proxy close')
      proxyClosed = true
      await settleWithin(upstreamClosed, 'upstream cancellation')
    } finally {
      destroyUpstream?.()
      if (!proxyClosed) {
        await settleWithin(proxy.close(), 'abort-test proxy close')
      }
    }
  })

  test('aborts an active upstream request when the proxy closes', async () => {
    let destroyUpstream: (() => void) | undefined
    let markUpstreamClosed: (() => void) | undefined
    const upstreamClosed = new Promise<void>((resolve) => {
      markUpstreamClosed = resolve
    })
    const upstreamBaseURL = await listen((request, response) => {
      const interval = setInterval(() => {
        response.write('event: ping\ndata: {}\n\n')
      }, 10)
      destroyUpstream = () => {
        clearInterval(interval)
        response.destroy()
      }
      request.once('aborted', () => {
        clearInterval(interval)
        markUpstreamClosed?.()
      })
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write('event: ping\ndata: {}\n\n')
    })
    const proxy = await startSearchProxy({
      apiKey: 'fc-test',
      baseURL: 'http://127.0.0.1:1',
      envKey: 'FIRECRAWL_API_KEY',
      type: 'firecrawl',
      upstreamBaseURL,
    })
    let proxyClosed = false

    try {
      const response = await fetch(`${proxy.baseURL}/v1/messages`, {
        body: JSON.stringify({
          messages: [{ content: 'hello', role: 'user' }],
          model: 'test-model',
          stream: true,
          tools: [],
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })

      expect(response.status).toBe(200)
      await settleWithin(proxy.close(), 'active-stream proxy close')
      proxyClosed = true
      await settleWithin(upstreamClosed, 'proxy-close upstream cancellation')
      await response.body?.cancel()
    } finally {
      destroyUpstream?.()
      if (!proxyClosed) {
        await settleWithin(proxy.close(), 'active-stream proxy close')
      }
    }
  })

  test('preserves a configured upstream path prefix', async () => {
    let upstreamPath: string | undefined
    const upstreamOrigin = await listen((request, response) => {
      upstreamPath = request.url
      response.writeHead(204)
      response.end()
    })
    const proxy = await startSearchProxy({
      apiKey: 'fc-test',
      baseURL: 'http://127.0.0.1:1',
      envKey: 'FIRECRAWL_API_KEY',
      type: 'firecrawl',
      upstreamBaseURL: `${upstreamOrigin}/gateway`,
    })

    try {
      const response = await fetch(`${proxy.baseURL}/v1/messages?beta=true`, {
        body: JSON.stringify({ ordinary: true }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })

      expect(response.status).toBe(204)
      expect(upstreamPath).toBe('/gateway/v1/messages?beta=true')
    } finally {
      await proxy.close()
    }
  })

  test('forwards search-shaped requests outside the Messages endpoint', async () => {
    let firecrawlRequests = 0
    let upstreamPath: string | undefined
    const firecrawlBaseURL = await listen((_request, response) => {
      firecrawlRequests += 1
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          data: { web: [] },
          success: true,
        }),
      )
    })
    const upstreamBaseURL = await listen((request, response) => {
      upstreamPath = request.url
      response.writeHead(204)
      response.end()
    })
    const proxy = await startSearchProxy({
      apiKey: 'fc-test',
      baseURL: firecrawlBaseURL,
      envKey: 'FIRECRAWL_API_KEY',
      type: 'firecrawl',
      upstreamBaseURL,
    })

    try {
      const response = await fetch(`${proxy.baseURL}/not-messages`, {
        body: JSON.stringify({
          messages: [
            {
              content: [
                {
                  text: 'Perform a web search for the query: route isolation',
                  type: 'text',
                },
              ],
              role: 'user',
            },
          ],
          model: 'test-model',
          tools: [{ type: 'web_search_20250305' }],
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })

      expect(response.status).toBe(204)
      expect(upstreamPath).toBe('/not-messages')
      expect(firecrawlRequests).toBe(0)
    } finally {
      await proxy.close()
    }
  })

  test('never lets an absolute-form request override the configured upstream', async () => {
    let upstreamAuthorization: string | undefined
    let upstreamHost: string | undefined
    let upstreamPath: string | undefined
    const upstreamBaseURL = await listen((request, response) => {
      upstreamAuthorization = request.headers.authorization
      upstreamHost = request.headers.host
      upstreamPath = request.url
      response.writeHead(200)
      response.end('upstream')
    })
    const proxy = await startSearchProxy({
      apiKey: 'fc-test',
      baseURL: 'http://127.0.0.1:1',
      envKey: 'FIRECRAWL_API_KEY',
      type: 'firecrawl',
      upstreamBaseURL,
    })

    try {
      const response = await rawRequest({
        baseURL: proxy.baseURL,
        headers: { Authorization: 'Bearer provider-secret' },
        path: 'https://attacker.invalid/collect?source=proxy',
      })

      expect(response.status).toBe(200)
      expect(response.body).toContain('upstream')
      expect(upstreamAuthorization).toBe('Bearer provider-secret')
      expect(upstreamHost).toBe(new URL(upstreamBaseURL).host)
      expect(upstreamPath).toBe('/collect?source=proxy')
    } finally {
      await proxy.close()
    }
  })

  test('returns bounded provider errors without killing the proxy', async () => {
    let firecrawlRequests = 0
    const firecrawlBaseURL = await listen((_request, response) => {
      firecrawlRequests += 1
      if (firecrawlRequests === 1) {
        response.writeHead(429, { 'Content-Type': 'text/plain' })
        response.end(`rate limited ${'x'.repeat(1_000)}`)
        return
      }
      if (firecrawlRequests === 2) {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ success: true }))
        return
      }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          data: {
            web: [
              {
                title: 'Recovered result',
                url: 'https://example.com/recovered',
              },
            ],
          },
          success: true,
        }),
      )
    })
    const upstreamBaseURL = await listen((_request, response) => {
      response.writeHead(500)
      response.end()
    })
    const proxy = await startSearchProxy({
      apiKey: 'fc-test',
      baseURL: firecrawlBaseURL,
      envKey: 'FIRECRAWL_API_KEY',
      type: 'firecrawl',
      upstreamBaseURL,
    })

    try {
      const rateLimited = await search(proxy.baseURL, 'rate limited')
      const invalidSchema = await search(proxy.baseURL, 'invalid schema')
      const recovered = await search(proxy.baseURL, 'recovered')

      expect(rateLimited.status).toBe(502)
      expect(rateLimited.body).toContain('Firecrawl search failed: HTTP 429')
      expect(rateLimited.body.length).toBeLessThan(700)
      expect(invalidSchema.status).toBe(502)
      expect(invalidSchema.body).toContain(
        'Firecrawl search returned an unexpected response',
      )
      expect(recovered.status).toBe(200)
      expect(recovered.body).toContain('Recovered result')
    } finally {
      await proxy.close()
    }
  })

  test('rejects hidden searches without a query before contacting a provider', async () => {
    let firecrawlRequests = 0
    let upstreamRequests = 0
    const firecrawlBaseURL = await listen((_request, response) => {
      firecrawlRequests += 1
      response.writeHead(500)
      response.end()
    })
    const upstreamBaseURL = await listen((_request, response) => {
      upstreamRequests += 1
      response.writeHead(500)
      response.end()
    })
    const proxy = await startSearchProxy({
      apiKey: 'fc-test',
      baseURL: firecrawlBaseURL,
      envKey: 'FIRECRAWL_API_KEY',
      type: 'firecrawl',
      upstreamBaseURL,
    })

    try {
      const missing = await fetch(`${proxy.baseURL}/v1/messages`, {
        body: JSON.stringify({
          ...webSearchRequest('unused', false),
          messages: [{ content: 'No search instruction', role: 'user' }],
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })
      const empty = await fetch(`${proxy.baseURL}/v1/messages`, {
        body: JSON.stringify(webSearchRequest('   ', false)),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })

      expect(missing.status).toBe(502)
      expect(await missing.text()).toContain('could not extract the query')
      expect(empty.status).toBe(502)
      expect(await empty.text()).toContain('sent an empty query')
      expect(firecrawlRequests).toBe(0)
      expect(upstreamRequests).toBe(0)
    } finally {
      await proxy.close()
    }
  })

  test('keeps concurrent search and upstream responses paired', async () => {
    let firecrawlRequests = 0
    let upstreamRequests = 0
    const firecrawlBaseURL = await listen(async (request, response) => {
      firecrawlRequests += 1
      const query = jsonStringField(await requestText(request), 'query')
      await delay((query.length % 4) * 3)
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          data: {
            web: [
              {
                title: `Result for ${query}`,
                url: `https://example.com/${encodeURIComponent(query)}`,
              },
            ],
          },
          success: true,
        }),
      )
    })
    const upstreamBaseURL = await listen(async (request, response) => {
      upstreamRequests += 1
      await delay(((request.url?.length ?? 0) % 3) * 2)
      response.writeHead(200, { 'Content-Type': 'text/plain' })
      response.end(`upstream:${request.url ?? ''}`)
    })
    const proxy = await startSearchProxy({
      apiKey: 'fc-test',
      baseURL: firecrawlBaseURL,
      envKey: 'FIRECRAWL_API_KEY',
      type: 'firecrawl',
      upstreamBaseURL,
    })

    try {
      const queries = Array.from({ length: 12 }, (_, index) => `query-${index}`)
      const upstreamPaths = Array.from(
        { length: 5 },
        (_, index) => `/ordinary-${index}`,
      )
      const [searchResults, upstreamResults] = await Promise.all([
        Promise.all(queries.map(async (query) => search(proxy.baseURL, query))),
        Promise.all(
          upstreamPaths.map(async (path) => {
            const response = await fetch(`${proxy.baseURL}${path}`)
            return { body: await response.text(), status: response.status }
          }),
        ),
      ])

      for (const [index, result] of searchResults.entries()) {
        expect(result.status).toBe(200)
        expect(result.body).toContain(`Result for ${queries[index] ?? ''}`)
      }
      for (const [index, result] of upstreamResults.entries()) {
        expect(result.status).toBe(200)
        expect(result.body).toBe(`upstream:${upstreamPaths[index] ?? ''}`)
      }
      expect(firecrawlRequests).toBe(queries.length)
      expect(upstreamRequests).toBe(upstreamPaths.length)
    } finally {
      await proxy.close()
    }
  })

  test('replaces successful Claude Code WebFetch output with Firecrawl content', async () => {
    let firecrawlAuthorization: string | undefined
    let firecrawlRequest: unknown
    const firecrawlBaseURL = await listen(async (request, response) => {
      firecrawlAuthorization = request.headers.authorization
      firecrawlRequest = JSON.parse((await requestText(request)) || '{}')
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          data: {
            markdown:
              '# Firecrawl page\n\nFetched through the selected provider.',
            metadata: { statusCode: 200 },
          },
          success: true,
        }),
      )
    })
    const upstreamBaseURL = await listen((_request, response) => {
      response.writeHead(500)
      response.end()
    })
    const proxy = await startSearchProxy({
      apiKey: 'fc-test',
      baseURL: firecrawlBaseURL,
      envKey: 'FIRECRAWL_API_KEY',
      type: 'firecrawl',
      upstreamBaseURL,
    })

    try {
      const response = await fetch(`${proxy.baseURL}/hooks/web-fetch`, {
        body: JSON.stringify({
          hook_event_name: 'PostToolUse',
          tool_input: {
            prompt: 'Summarize the page',
            url: 'https://example.com/page',
          },
          tool_name: 'WebFetch',
          tool_response: {
            bytes: 1234,
            code: 200,
            codeText: 'OK',
            durationMs: 50,
            result: 'Native fetch result',
            url: 'https://example.com/page',
          },
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          updatedToolOutput: {
            bytes: 56,
            code: 200,
            codeText: 'OK',
            durationMs: 50,
            result:
              'Firecrawl fetched https://example.com/page for the WebFetch prompt "Summarize the page":\n\n# Firecrawl page\n\nFetched through the selected provider.',
            url: 'https://example.com/page',
          },
        },
      })
      expect(firecrawlAuthorization).toBe('Bearer fc-test')
      expect(firecrawlRequest).toEqual(
        expect.objectContaining({
          formats: ['markdown'],
          onlyMainContent: true,
          url: 'https://example.com/page',
        }),
      )
    } finally {
      await proxy.close()
    }
  })

  test('supplies Firecrawl content when native WebFetch fails', async () => {
    const firecrawlBaseURL = await listen((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          data: { markdown: 'Firecrawl recovered the page.' },
          success: true,
        }),
      )
    })
    const upstreamBaseURL = await listen((_request, response) => {
      response.writeHead(500)
      response.end()
    })
    const proxy = await startSearchProxy({
      apiKey: 'fc-test',
      baseURL: firecrawlBaseURL,
      envKey: 'FIRECRAWL_API_KEY',
      type: 'firecrawl',
      upstreamBaseURL,
    })

    try {
      const response = await fetch(`${proxy.baseURL}/hooks/web-fetch`, {
        body: JSON.stringify({
          error: 'native fetch failed',
          hook_event_name: 'PostToolUseFailure',
          tool_input: {
            prompt: 'Extract the launch date',
            url: 'https://example.com/blocked',
          },
          tool_name: 'WebFetch',
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        hookSpecificOutput: {
          additionalContext:
            'Native WebFetch failed, but Firecrawl fetched https://example.com/blocked for the WebFetch prompt "Extract the launch date":\n\nFirecrawl recovered the page.',
          hookEventName: 'PostToolUseFailure',
        },
      })
    } finally {
      await proxy.close()
    }
  })

  test('updates WebFetch status code and status text together', async () => {
    const firecrawlBaseURL = await listen((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          data: {
            markdown: 'The upstream page was not found.',
            metadata: { statusCode: 404 },
          },
          success: true,
        }),
      )
    })
    const upstreamBaseURL = await listen((_request, response) => {
      response.writeHead(500)
      response.end()
    })
    const proxy = await startSearchProxy({
      apiKey: 'fc-test',
      baseURL: firecrawlBaseURL,
      envKey: 'FIRECRAWL_API_KEY',
      type: 'firecrawl',
      upstreamBaseURL,
    })

    try {
      const response = await fetch(`${proxy.baseURL}/hooks/web-fetch`, {
        body: JSON.stringify({
          hook_event_name: 'PostToolUse',
          tool_input: {
            prompt: 'Read the page',
            url: 'https://example.com/missing',
          },
          tool_name: 'WebFetch',
          tool_response: {
            bytes: 100,
            code: 200,
            codeText: 'OK',
            durationMs: 10,
            result: 'Native fetch result',
            url: 'https://example.com/missing',
          },
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })
      const body = JSON.stringify(await response.json())

      expect(response.status).toBe(200)
      expect(body).toContain('"code":404')
      expect(body).toContain('"codeText":"Not Found"')
    } finally {
      await proxy.close()
    }
  })

  test('rejects malformed WebFetch hooks before contacting Firecrawl', async () => {
    let firecrawlRequests = 0
    const firecrawlBaseURL = await listen((_request, response) => {
      firecrawlRequests += 1
      response.writeHead(500)
      response.end()
    })
    const upstreamBaseURL = await listen((_request, response) => {
      response.writeHead(500)
      response.end()
    })
    const proxy = await startSearchProxy({
      apiKey: 'fc-test',
      baseURL: firecrawlBaseURL,
      envKey: 'FIRECRAWL_API_KEY',
      type: 'firecrawl',
      upstreamBaseURL,
    })

    try {
      const invalidJson = await fetch(`${proxy.baseURL}/hooks/web-fetch`, {
        body: '{',
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })
      const wrongTool = await fetch(`${proxy.baseURL}/hooks/web-fetch`, {
        body: JSON.stringify({
          hook_event_name: 'PostToolUse',
          tool_input: { prompt: 'test', url: 'https://example.com' },
          tool_name: 'Bash',
          tool_response: {},
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })

      expect(invalidJson.status).toBe(502)
      expect(await invalidJson.text()).toContain('sent invalid JSON')
      expect(wrongTool.status).toBe(502)
      expect(await wrongTool.text()).toContain('sent an unexpected payload')
      expect(firecrawlRequests).toBe(0)
    } finally {
      await proxy.close()
    }
  })

  test('returns scrape errors without emitting a partial hook replacement', async () => {
    let firecrawlRequests = 0
    const firecrawlBaseURL = await listen((_request, response) => {
      firecrawlRequests += 1
      if (firecrawlRequests === 1) {
        response.writeHead(503, { 'Content-Type': 'text/plain' })
        response.end('scrape unavailable')
        return
      }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          data: { markdown: 'Recovered scrape' },
          success: true,
        }),
      )
    })
    const upstreamBaseURL = await listen((_request, response) => {
      response.writeHead(500)
      response.end()
    })
    const proxy = await startSearchProxy({
      apiKey: 'fc-test',
      baseURL: firecrawlBaseURL,
      envKey: 'FIRECRAWL_API_KEY',
      type: 'firecrawl',
      upstreamBaseURL,
    })

    try {
      const failed = await webFetch(proxy.baseURL, {
        prompt: 'first attempt',
        url: 'https://example.com/failure',
      })
      const recovered = await webFetch(proxy.baseURL, {
        prompt: 'second attempt',
        url: 'https://example.com/recovery',
      })

      expect(failed.status).toBe(502)
      expect(failed.body).toContain('Firecrawl scrape failed: HTTP 503')
      expect(failed.body).not.toContain('hookSpecificOutput')
      expect(recovered.status).toBe(200)
      expect(recovered.body).toContain('Recovered scrape')
    } finally {
      await proxy.close()
    }
  })

  test('keeps concurrent WebFetch hook outputs paired', async () => {
    let firecrawlRequests = 0
    const firecrawlBaseURL = await listen(async (request, response) => {
      firecrawlRequests += 1
      const url = jsonStringField(await requestText(request), 'url')
      await delay((url.length % 4) * 3)
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          data: { markdown: `Markdown for ${url}` },
          success: true,
        }),
      )
    })
    const upstreamBaseURL = await listen((_request, response) => {
      response.writeHead(500)
      response.end()
    })
    const proxy = await startSearchProxy({
      apiKey: 'fc-test',
      baseURL: firecrawlBaseURL,
      envKey: 'FIRECRAWL_API_KEY',
      type: 'firecrawl',
      upstreamBaseURL,
    })

    try {
      const inputs = Array.from({ length: 10 }, (_, index) => ({
        prompt: `prompt-${index}`,
        url: `https://example.com/page-${index}`,
      }))
      const results = await Promise.all(
        inputs.map(async (input) => webFetch(proxy.baseURL, input)),
      )

      for (const [index, result] of results.entries()) {
        const input = inputs[index]
        expect(result.status).toBe(200)
        expect(result.body).toContain(`Markdown for ${input.url}`)
        expect(result.body).toContain(input.prompt)
      }
      expect(firecrawlRequests).toBe(inputs.length)
    } finally {
      await proxy.close()
    }
  })

  test('scopes the proxy URL and lifetime to the launched harness process', async () => {
    let firecrawlRequests = 0
    const firecrawlBaseURL = await listen((_request, response) => {
      firecrawlRequests += 1
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          data: {
            web: [{ title: 'Lifecycle result', url: 'https://example.com' }],
          },
          success: true,
        }),
      )
    })
    const upstreamBaseURL = await listen((_request, response) => {
      response.writeHead(500)
      response.end()
    })
    const childScript = `
      const body = {
        messages: [{
          content: [{
            text: 'Perform a web search for the query: proxy lifetime',
            type: 'text'
          }],
          role: 'user'
        }],
        model: 'test-model',
        stream: false,
        tools: [{ type: 'web_search_20250305' }]
      }
      const response = await fetch(
        process.env.ANTHROPIC_BASE_URL + '/v1/messages?beta=true',
        {
          body: JSON.stringify(body),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST'
        }
      )
      const text = await response.text()
      if (!response.ok || !text.includes('Lifecycle result')) process.exit(2)
      if (process.env.FIRECRAWL_API_KEY) process.exit(4)
    `

    const previousKey = process.env.FIRECRAWL_API_KEY
    process.env.FIRECRAWL_API_KEY = 'ambient-secret'
    let code: number | undefined
    try {
      code = await launch({
        args: ['-e', childScript],
        bin: process.execPath,
        env: { ANTHROPIC_BASE_URL: upstreamBaseURL },
        notes: [],
        searchProxy: {
          apiKey: 'fc-test',
          baseURL: firecrawlBaseURL,
          envKey: 'FIRECRAWL_API_KEY',
          type: 'firecrawl',
          upstreamBaseURL,
        },
      })
    } finally {
      restoreEnv('FIRECRAWL_API_KEY', previousKey)
    }

    expect(code).toBe(0)
    expect(firecrawlRequests).toBe(1)
  })

  test('chains search, cost capture, and Gateway provider routing', async () => {
    let firecrawlRequests = 0
    let upstreamBody: unknown
    let upstreamRequests = 0
    const firecrawlBaseURL = await listen((_request, response) => {
      firecrawlRequests += 1
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          data: {
            web: [
              { title: 'Chained result', url: 'https://example.com/chained' },
            ],
          },
          success: true,
        }),
      )
    })
    const upstreamBaseURL = await listen(async (request, response) => {
      upstreamRequests += 1
      upstreamBody = JSON.parse(await requestText(request))
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ content: [], type: 'message' }))
    })
    const childScript = `
      if (process.env.EH_GATEWAY_COST_CAPTURE !== '1') process.exit(2)
      if (!process.env.EH_SEARCH_PROXY_URL) process.exit(3)
      if (process.env.FIRECRAWL_API_KEY) process.exit(4)
      const ordinary = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', {
        body: JSON.stringify({
          messages: [{ content: 'hello', role: 'user' }],
          model: 'test-model',
          stream: false,
          tools: []
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST'
      })
      if (!ordinary.ok) process.exit(5)
      const search = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', {
        body: JSON.stringify({
          messages: [{
            content: [{
              text: 'Perform a web search for the query: chained proxies',
              type: 'text'
            }],
            role: 'user'
          }],
          model: 'test-model',
          stream: false,
          tools: [{ type: 'web_search_20250305' }]
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST'
      })
      if (!search.ok || !(await search.text()).includes('Chained result')) {
        process.exit(6)
      }
    `

    const code = await launch({
      args: ['-e', childScript],
      bin: process.execPath,
      env: { ANTHROPIC_BASE_URL: upstreamBaseURL },
      gatewayCostCapture: { resumed: false },
      gatewayRouting: {
        provider: 'fireworks',
        targetBaseURL: upstreamBaseURL,
      },
      notes: [],
      searchProxy: {
        apiKey: 'fc-test',
        baseURL: firecrawlBaseURL,
        envKey: 'FIRECRAWL_API_KEY',
        type: 'firecrawl',
        upstreamBaseURL: 'http://127.0.0.1:1',
      },
    })

    expect(code).toBe(0)
    expect(firecrawlRequests).toBe(1)
    expect(upstreamRequests).toBe(1)
    expect(upstreamBody).toEqual({
      messages: [{ content: 'hello', role: 'user' }],
      model: 'test-model',
      providerOptions: { gateway: { only: ['fireworks'] } },
      stream: false,
      tools: [],
    })
  })

  test('isolates two concurrently launched search proxies', async () => {
    let firecrawlARequests = 0
    let firecrawlBRequests = 0
    const firecrawlABaseURL = await listen((_request, response) => {
      firecrawlARequests += 1
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          data: { web: [{ title: 'Provider A', url: 'https://a.example' }] },
          success: true,
        }),
      )
    })
    const firecrawlBBaseURL = await listen((_request, response) => {
      firecrawlBRequests += 1
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          data: { web: [{ title: 'Provider B', url: 'https://b.example' }] },
          success: true,
        }),
      )
    })
    const upstreamBaseURL = await listen((_request, response) => {
      response.writeHead(500)
      response.end()
    })
    const childScript = `
      const query = process.env.EXPECTED_PROVIDER
      const body = {
        messages: [{
          content: [{
            text: 'Perform a web search for the query: ' + query,
            type: 'text'
          }],
          role: 'user'
        }],
        model: 'test-model',
        stream: false,
        tools: [{ type: 'web_search_20250305' }]
      }
      const response = await fetch(
        process.env.ANTHROPIC_BASE_URL + '/v1/messages',
        {
          body: JSON.stringify(body),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST'
        }
      )
      const text = await response.text()
      if (!response.ok || !text.includes('Provider ' + query)) process.exit(2)
    `

    const [codeA, codeB] = await Promise.all([
      launch({
        args: ['-e', childScript],
        bin: process.execPath,
        env: {
          ANTHROPIC_BASE_URL: upstreamBaseURL,
          EXPECTED_PROVIDER: 'A',
        },
        notes: [],
        searchProxy: {
          apiKey: 'fc-a',
          baseURL: firecrawlABaseURL,
          envKey: 'FIRECRAWL_API_KEY',
          type: 'firecrawl',
          upstreamBaseURL,
        },
      }),
      launch({
        args: ['-e', childScript],
        bin: process.execPath,
        env: {
          ANTHROPIC_BASE_URL: upstreamBaseURL,
          EXPECTED_PROVIDER: 'B',
        },
        notes: [],
        searchProxy: {
          apiKey: 'fc-b',
          baseURL: firecrawlBBaseURL,
          envKey: 'FIRECRAWL_API_KEY',
          type: 'firecrawl',
          upstreamBaseURL,
        },
      }),
    ])

    expect(codeA).toBe(0)
    expect(codeB).toBe(0)
    expect(firecrawlARequests).toBe(1)
    expect(firecrawlBRequests).toBe(1)
  })

  test('leaves native launches free of search proxy variables', async () => {
    const childScript = `
      if (process.env.ANTHROPIC_BASE_URL !== 'https://native.example') {
        process.exit(2)
      }
      if (process.env.EH_SEARCH_PROXY_URL) process.exit(3)
      if (process.env.EH_GATEWAY_COST_CAPTURE) process.exit(4)
    `
    const previousProxyURL = process.env.EH_SEARCH_PROXY_URL
    const previousCostCapture = process.env.EH_GATEWAY_COST_CAPTURE
    process.env.EH_SEARCH_PROXY_URL = 'http://127.0.0.1:9/hooks/web-fetch'
    process.env.EH_GATEWAY_COST_CAPTURE = '1'
    let code: number | undefined
    try {
      code = await launch({
        args: ['-e', childScript],
        bin: process.execPath,
        env: { ANTHROPIC_BASE_URL: 'https://native.example' },
        notes: [],
      })
    } finally {
      restoreEnv('EH_SEARCH_PROXY_URL', previousProxyURL)
      restoreEnv('EH_GATEWAY_COST_CAPTURE', previousCostCapture)
    }

    expect(code).toBe(0)
  })
})

async function closeServer(server: Server) {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

async function delay(milliseconds: number) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function jsonStringField(body: string, name: string) {
  const match = new RegExp(`"${name}":"([^"]+)"`).exec(body)
  return match?.[1] ?? 'missing'
}

async function listen(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => Promise<void> | void,
) {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response))
  })
  openServers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('test server did not bind a TCP port')
  }
  return `http://127.0.0.1:${String(address.port)}`
}

async function rawRequest(props: {
  baseURL: string
  headers: Record<string, string>
  path: string
}) {
  const proxy = new URL(props.baseURL)
  return new Promise<{ body: string; status: number | undefined }>(
    (resolve, reject) => {
      const socket = connect(Number(proxy.port), proxy.hostname)
      let response = ''
      socket.setEncoding('utf8')
      socket.on('connect', () => {
        const headers = Object.entries(props.headers)
          .map(([name, value]) => `${name}: ${value}`)
          .join('\r\n')
        socket.write(
          `GET ${props.path} HTTP/1.1\r\nHost: ${proxy.host}\r\n${headers}\r\nConnection: close\r\n\r\n`,
        )
      })
      socket.on('data', (chunk: string) => {
        response += chunk
      })
      socket.on('end', () => {
        const separator = response.indexOf('\r\n\r\n')
        const statusLine = response.slice(0, response.indexOf('\r\n'))
        const statusMatch = /^HTTP\/1\.1 (\d{3})/.exec(statusLine)
        resolve({
          body: separator === -1 ? '' : response.slice(separator + 4),
          status: statusMatch ? Number(statusMatch[1]) : undefined,
        })
      })
      socket.on('error', reject)
    },
  )
}

async function requestText(request: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const rawChunk of request) {
    const chunk: unknown = rawChunk
    if (typeof chunk === 'string' || chunk instanceof Uint8Array) {
      chunks.push(Buffer.from(chunk))
    }
  }
  return Buffer.concat(chunks).toString('utf8')
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) Reflect.deleteProperty(process.env, name)
  else process.env[name] = value
}

async function search(baseURL: string, query: string) {
  const response = await fetch(`${baseURL}/v1/messages`, {
    body: JSON.stringify(webSearchRequest(query, false)),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })
  return { body: await response.text(), status: response.status }
}

async function settleWithin<T>(promise: Promise<T>, label: string) {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`timed out waiting for ${label}`)),
          1_000,
        )
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function webFetch(
  baseURL: string,
  input: { prompt: string; url: string },
) {
  const response = await fetch(`${baseURL}/hooks/web-fetch`, {
    body: JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_input: input,
      tool_name: 'WebFetch',
      tool_response: {
        bytes: 100,
        code: 200,
        codeText: 'OK',
        durationMs: 10,
        result: 'Native fetch result',
        url: input.url,
      },
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })
  return { body: await response.text(), status: response.status }
}

function webSearchRequest(query: string, stream: boolean) {
  return {
    messages: [
      {
        content: [
          {
            text: `Perform a web search for the query: ${query}`,
            type: 'text',
          },
        ],
        role: 'user',
      },
    ],
    model: 'test-model',
    stream,
    tools: [{ type: 'web_search_20250305' }],
  }
}
