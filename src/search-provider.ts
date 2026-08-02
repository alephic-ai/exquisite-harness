import Firecrawl, {
  type Document,
  SdkError,
  type SearchResultWeb,
} from '@mendable/firecrawl-js'

import type { Config } from './config.js'

import { getSearchProvider, searchProviderKeyAccount } from './config.js'
import { resolveApiKey } from './keys.js'

const FIRECRAWL_TIMEOUT_MS = 60_000

export async function resolveSearchBackend(config: Config, name: string) {
  if (name === 'native') return undefined
  const provider = getSearchProvider(config, name)
  if (!provider) throw new Error(`unknown search provider "${name}"`)
  const key = await resolveApiKey(
    provider.envKey,
    searchProviderKeyAccount(provider.name),
  )
  if (key.source === 'none') {
    throw new Error(
      `no API key for search provider "${name}" — set ${provider.envKey} or run \`eh search key ${name}\``,
    )
  }
  return {
    apiKey: key.value,
    baseURL: provider.baseURL,
    envKey: provider.envKey,
    type: provider.type,
  }
}

export async function scrapeFirecrawl(props: {
  apiKey: string
  baseURL: string
  url: string
}) {
  let document: Document
  try {
    document = await firecrawlClient(props).scrape(props.url, {
      formats: ['markdown'],
      onlyMainContent: true,
    })
  } catch (error) {
    throw firecrawlError('scrape', error)
  }
  if (typeof document.markdown !== 'string') {
    throw new Error('Firecrawl scrape returned an unexpected response')
  }
  return {
    markdown: document.markdown,
    statusCode: document.metadata?.statusCode,
  }
}

export async function searchFirecrawl(props: {
  apiKey: string
  baseURL: string
  excludeDomains?: string[]
  includeDomains?: string[]
  query: string
}) {
  let data: Awaited<ReturnType<Firecrawl['search']>>
  try {
    data = await firecrawlClient(props).search(props.query, {
      ...(props.excludeDomains ? { excludeDomains: props.excludeDomains } : {}),
      ...(props.includeDomains ? { includeDomains: props.includeDomains } : {}),
      limit: 10,
      sources: ['web'],
    })
  } catch (error) {
    throw firecrawlError('search', error)
  }
  if (!Array.isArray(data.web)) {
    throw new Error('Firecrawl search returned an unexpected response')
  }
  const results = data.web.flatMap((result) => {
    const metadata = resultMetadata(result)
    const rawURL =
      'url' in result ? result.url : (metadata?.sourceURL ?? metadata?.url)
    const url = typeof rawURL === 'string' ? httpUrl(rawURL) : undefined
    if (!url) return []
    const rawTitle = 'title' in result ? result.title : metadata?.title
    const rawDescription =
      'description' in result ? result.description : metadata?.description
    return [
      {
        description: cleanLine(rawDescription),
        title: cleanLine(rawTitle) ?? url.hostname,
        url: url.href,
      },
    ]
  })
  return { results, text: formatResults(props.query, results) }
}

function cleanLine(value: null | string | undefined) {
  const cleaned = value?.replaceAll(/\s+/g, ' ').trim()
  return cleaned ? cleaned : undefined
}

function escapeLinkText(value: string) {
  return value.replaceAll('[', '\\[').replaceAll(']', '\\]')
}

function firecrawlClient(props: { apiKey: string; baseURL: string }) {
  return new Firecrawl({
    apiKey: props.apiKey,
    apiUrl: props.baseURL,
    maxRetries: 1,
    timeoutMs: FIRECRAWL_TIMEOUT_MS,
  })
}

function firecrawlError(operation: 'scrape' | 'search', error: unknown) {
  const detail =
    error instanceof Error ? error.message.trim().slice(0, 500) : ''
  const status = error instanceof SdkError ? error.status : undefined
  return new Error(
    `Firecrawl ${operation} failed${status === undefined ? '' : `: HTTP ${String(status)}`}${detail ? ` — ${detail}` : ''}`,
  )
}

function formatResults(
  query: string,
  results: { description: string | undefined; title: string; url: string }[],
) {
  const formatted = results.map((result, index) =>
    [
      `${String(index + 1)}. [${escapeLinkText(result.title)}](${result.url})`,
      ...(result.description
        ? [`   ${result.description.slice(0, 1_200)}`]
        : []),
    ].join('\n'),
  )
  if (formatted.length === 0) {
    return `Firecrawl returned no web results for: ${query}`
  }
  return `Firecrawl web results for: ${query}\n\n${formatted.join('\n\n')}`
}

function httpUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url
      : undefined
  } catch {
    return undefined
  }
}

function resultMetadata(result: Document | SearchResultWeb) {
  return 'metadata' in result ? result.metadata : undefined
}
