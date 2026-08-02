# QA: Firecrawl search and fetch proxy

Scope: the selectable Firecrawl provider from configuration through a real
Claude Code session, including the loopback Anthropic Messages proxy, WebFetch
hooks, provider failures, concurrent traffic, and process lifetime.

## Prerequisites

- `pnpm install` has completed.
- `claude --version` reports the locally installed Claude Code version.
- A Firecrawl key is configured without printing it: either `FIRECRAWL_API_KEY`
  is set or `eh search key firecrawl` has stored one.
- The selected model provider has a configured key. The primary live matrix is
  Vercel AI Gateway with `deepseek/deepseek-v4-flash`.
- Run evidence goes under `tmp/qa-runs/firecrawl-search-proxy/`, which must be
  gitignored.

## A. Static and automated gates

1. Run `pnpm lint:ci`. → ESLint, Prettier, and TypeScript all exit 0.
2. Run `pnpm test`. → every repository test exits 0.
3. Run `pnpm build`, then `./dist/eh --version`. → the standalone binary builds
   and prints the package version.
4. Run `git diff --check`. → exits 0 with no whitespace errors.

## B. Provider selection and persistence

1. Launch `eh` with a clean temporary config and choose **providers**. → one
   screen contains separate **Model providers** and **Search providers**
   headings, plus **Native** and **Firecrawl** search rows with key/default
   status. A keyed Firecrawl row sorts before Native; a missing-key Firecrawl
   row sorts after Native.
2. Choose **Firecrawl**, then **make default**. → the success message says
   Firecrawl is the default, the provider row gains `· default`, and
   `config.json` persists `defaultSearchProvider: "firecrawl"` without any
   credential value.
3. Start a fully specified Claude launch without `--search`. → no search prompt
   interrupts the zero-prompt path, the launch inherits Firecrawl, and its
   recent persists that choice. An explicit `--search native` still overrides
   the default.
4. Reopen the menu, make **Native** default, and reopen once more. → Native is
   labeled as default and the persisted setting is `"native"`.
5. Store a key with `eh search key firecrawl`. → the CLI asks whether Firecrawl
   should become the default. Delete the stored key while Firecrawl is default.
   → the default resets to Native only when no environment or stored credential
   remains.

## C. Search protocol contract

1. Run `bun test src/search-proxy.test.ts`. → a streaming Claude hidden
   `web_search_*` request calls Firecrawl `POST /v2/search` and returns valid
   `server_tool_use`, `web_search_tool_result`, text, and usage SSE events.
2. Exercise the non-stream Messages form with empty and filtered Firecrawl
   results. → the response is Anthropic JSON, invalid non-HTTP URLs are omitted,
   titles/descriptions are normalized, and empty results remain a successful
   search with a clear message.
3. Send separate hidden requests with `allowed_domains` and `blocked_domains`. →
   the official SDK request carries `includeDomains` and `excludeDomains`,
   respectively.
4. Send ordinary model requests and a search-shaped request on a non-Messages
   path. → both pass through to the configured upstream without contacting
   Firecrawl; a configured upstream path prefix, headers, query string, status,
   and streamed body survive.
5. Send concurrent searches with distinct queries while ordinary upstream
   traffic is active. → every response contains only its own query/results, all
   requests finish, and no traffic is cross-wired.

## D. Search failure behavior

1. Return HTTP 401, HTTP 429, invalid JSON, and a schema-invalid success body
   from the fake Firecrawl boundary. → the proxy returns an Anthropic-shaped
   HTTP 502 with a bounded, actionable error and does not crash.
2. Send a hidden search request with no extractable or empty query. → the proxy
   returns HTTP 502 and does not call Firecrawl or the model upstream.
3. After each failure, send a valid search and ordinary upstream request. → the
   same proxy process remains healthy.

## E. WebFetch hook contract

1. Send real `PostToolUse` payloads to `/hooks/web-fetch`. → Firecrawl
   `POST /v2/scrape` receives the URL; the returned hook output replaces native
   content, preserves native metadata, updates bytes and the HTTP code/status
   text as a pair, and carries the original prompt and URL.
2. Send real `PostToolUseFailure` payloads. → successful Firecrawl markdown
   appears as recovery context for the model.
3. Send malformed hook payloads and make Firecrawl return HTTP and schema
   failures. → the hook endpoint returns HTTP 502 without crashing or emitting a
   partial replacement.
4. Run concurrent fetch hooks for distinct URLs/prompts. → each result is paired
   with its own request and no output is cross-wired.

## F. Process isolation and lifecycle

1. Launch a child through `launch.exec` with Firecrawl selected. → only that
   child receives loopback `ANTHROPIC_BASE_URL` and `EH_SEARCH_PROXY_URL`; the
   selected provider credential remains parent-only.
2. Let the child execute search and fetch traffic, then exit. → `eh` returns the
   child exit code and closes the loopback listener.
3. Launch two proxy-backed children concurrently. → they receive different
   loopback ports and each uses its own provider configuration.
4. Launch without a search provider. → no proxy variables are added and the
   native model-provider URL remains unchanged, even if the parent process has a
   stale `EH_SEARCH_PROXY_URL`.

## G. Real Claude Code acceptance

For each run, record the Claude Code version, model provider/model, session ID,
exit status, transcript path, number of persisted search/fetch tool results, and
whether the final answer cited or used the returned content. Never record
credential values.

1. **Search happy path:** ask Claude to perform exactly one WebSearch for a
   unique query and report one source URL. → the UI reports one search; the
   transcript contains Firecrawl results and `web_search_requests: 1`; the final
   answer uses a returned source.
2. **Fetch happy path:** ask Claude to perform exactly one WebFetch for a stable
   public page and return a recognizable field. → the persisted tool result
   begins `Firecrawl fetched`, contains page markdown, and the final answer uses
   it.
3. **Combined research:** ask for a search followed by fetches of two discovered
   pages. → search and fetch markers both persist, the answer uses the fetched
   pages, and repeated calls remain correctly paired.
4. **Repeated runs:** repeat the search and fetch scenarios in fresh sessions at
   least three times total. → every fresh process receives a working proxy and
   exits cleanly.
5. **Native control:** launch a fresh Claude session with `--search native`. →
   no Firecrawl marker appears, proving the configured choice controls the
   behavior.

## Known limitations

- `PostToolUse` runs after Claude's native WebFetch downloader. Firecrawl
  controls model-visible content but cannot prevent or shorten the native
  request.
- Live acceptance depends on nondeterministic model tool choice and third-party
  availability. A run only passes when the requested tool call is observed in
  the transcript, not merely when the final prose looks correct.
- Cross-platform credential stores and process behavior require separate macOS,
  Linux, and Windows runs. This runbook's primary live environment is macOS.
- Provider account exhaustion and destructive rate-limit testing are excluded;
  controlled HTTP 429 behavior is exercised at the loopback boundary.

## Automated coverage

- `src/search-proxy.test.ts`: HTTP routing, Anthropic JSON/SSE contracts,
  WebFetch hooks, provider errors, concurrency, and process lifetime.
- `src/config.test.ts`: explicit/default/native selection and recent/profile
  persistence semantics.
- `pnpm lint:ci`, `pnpm test`, `pnpm build`, and `git diff --check`: repository
  static, runtime, packaging, and whitespace gates.
