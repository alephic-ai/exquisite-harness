import { text } from 'node:stream/consumers'

const HOOK_TIMEOUT_MS = 65_000

// Claude Code runs this command after WebFetch. It deliberately knows only the
// process-scoped loopback URL; the Firecrawl credential stays in the eh parent.
export async function runWebFetchHook() {
  const proxyURL = process.env.EH_SEARCH_PROXY_URL
  if (!proxyURL) return

  const response = await fetch(proxyURL, {
    body: await text(process.stdin),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
    signal: AbortSignal.timeout(HOOK_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(
      `web fetch provider hook failed: HTTP ${String(response.status)}`,
    )
  }
  process.stdout.write(await response.text())
}
