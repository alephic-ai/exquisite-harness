# Review Context Packet

Changed files in review scope (vs `origin/main`, pipeline artifacts filtered
out):

- DESIGN.md
- README.md
- src/headless-run.test.ts
- src/headless-run.ts
- src/pricing.test.ts
- src/pricing.ts

## Unified diff

```diff
diff --git a/DESIGN.md b/DESIGN.md
index 642009f..3d824b4 100644
--- a/DESIGN.md
+++ b/DESIGN.md
@@ -107,6 +107,23 @@ is the raw child exit code passed through unchanged (including `128 + signal`),
 so a harness's own code can collide with the reserved block only in that
 passthrough case.

+**Headless computed cost:** `eh run` does not trust the inner harness's
+self-reported cost as authoritative. It accumulates its own normalized usage
+across the run (a `cumulative: true` total from the harness wins outright;
+otherwise per-event deltas are summed, so a harness like grok that emits both is
+not double-counted) and, before `run.completed`, emits one final summary `usage`
+event carrying `costUsd` that it computes from that usage times the resolved
+model's gateway rates. Rates come from the model's per-endpoint pricing when
+`--gateway-provider` is pinned (honoring prompt/completion tiers as context
+brackets), else the model-aggregate rates. `costSource` records provenance:
+`gateway-rates`, `free` (zero-rate providers like ollama), or `unavailable` —
+and when unavailable no `costUsd` is emitted, never a fabricated `$0`. Cache
+read/write tokens bill at the endpoint's published cache rates; when an endpoint
+publishes none they bill at the regular input rate (a provider that gives no
+cache discount charges cache tokens as ordinary input). Any harness-reported
+cost is preserved separately as `harnessCostUsd`, never promoted to `costUsd`.
+Because the event shape changed, the NDJSON stream version `v` is now `2`.
+
 **Phase 2 (later): local router.** An opt-in localhost proxy that receives
 Anthropic Messages / OpenAI requests and fulfills them via the Vercel AI SDK
 (`createProviderRegistry` + `customProvider` aliases). Unlocks the ⚠️ cell
@@ -492,7 +509,7 @@ src/headless-run.ts  non-interactive harness execution + NDJSON normalization
 src/approval-mode.ts  approval labels + per-harness native argument mapping
 src/config.ts     schema, load/save, recents, profiles, XDG paths
 src/providers.ts  provider types: protocols, model listing, status checks
-src/pricing.ts    provider rates/ranges ($/1M) and fallback cost estimates
+src/pricing.ts    provider rates/ranges ($/1M), headless rate cards + computed cost
 src/gateway-costs.ts transparent Vercel stream proxy + exact session ledger
 src/gateway-routing.ts process-scoped request rewriter for Gateway provider pins / ZDR-only routing
 src/statusline.ts Claude statusline render + session settings writer
diff --git a/README.md b/README.md
index 23a84d3..d7625f8 100644
--- a/README.md
+++ b/README.md
@@ -159,13 +159,23 @@ printf 'fix the parser' |
   eh run codex ollama qwen3-coder --reasoning-effort high
```

-Every output object carries `v: 1`. The normalized events are `run.started`,
+Every output object carries `v: 2`. The normalized events are `run.started`,
`session.started`, `assistant.text`, `usage`, `run.error`, and `run.completed`.
Native machine events are preserved as `harness.event`; non-JSON output is
preserved as `harness.output`. Harness stderr remains stderr. A semantically
failed native result makes both `run.completed.exitCode` and the `eh` process
exit code non-zero, even when the child process exits zero.

+Per-event `usage` objects carry the harness's own cost estimate (when it
reports +one) as `harnessCostUsd`. Before `run.completed`, `eh` emits one
final +`cumulative: true` summary `usage` event that adds `costUsd` — the cost
`eh` +computes itself from its own accumulated normalized usage times the
resolved +model's gateway rates (per-endpoint and tiered when
`--gateway-provider` is +pinned) — and `costSource`: `gateway-rates` when
computed, `free` for zero-rate +providers such as ollama, or `unavailable` when
no rates could be resolved (in +which case `costUsd` is omitted rather than
fabricated). Any `harnessCostUsd` is +preserved on the summary too, never
promoted to `costUsd`. +

#### Exit codes

`eh` owns a small reserved block of exit codes for failures it detects itself;
diff --git a/src/headless-run.test.ts b/src/headless-run.test.ts index
95e87c7..0c2c1b5 100644 --- a/src/headless-run.test.ts +++
b/src/headless-run.test.ts @@ -73,17 +73,17 @@ describe('eh run', () => { model:
'qwen3-coder', provider: 'ollama', type: 'run.started',

-      v: 1,

*      v: 2,
  }) expect(events).toContainEqual({ sessionId: 'thread-123', type:
  'session.started',

-      v: 1,

*      v: 2,
  }) expect(events).toContainEqual({ text: 'saw: fix the parser', type:
  'assistant.text',

-      v: 1,

*      v: 2,
  }) expect(events).toContainEqual({ cacheReadTokens: 4, @@ -92,13 +92,27 @@
  describe('eh run', () => { inputTokens: 10, outputTokens: 2, type: 'usage',

-      v: 1,

*      v: 2,
* })
* // Final summary usage event: eh computes cost from its own usage. On the
* // free ollama provider that is $0 from `gateway-rates`-free, and codex
* // reports no cost of its own, so no harnessCostUsd is present.
* expect(events).toContainEqual({
*      cacheReadTokens: 4,
*      cacheWriteTokens: 0,
*      costSource: 'free',
*      costUsd: 0,
*      cumulative: true,
*      inputTokens: 10,
*      outputTokens: 2,
*      type: 'usage',
*      v: 2,
  }) expect(events).toContainEqual({ exitCode: 0, resultIsError: false, type:
  'run.completed',

-      v: 1,

*      v: 2,

  })

  const argsEvent = events @@ -223,13 +237,13 @@ describe('eh run', () => { {
  message: expect.stringContaining(missing), type: 'run.error',

-        v: 1,

*        v: 2,
       },
       {
         exitCode: 64,
         resultIsError: true,
         type: 'run.completed',

-        v: 1,

*        v: 2,
       },
  ]) }) @@ -275,13 +289,13 @@ describe('eh run', () => { { message:
  expect.stringContaining(file), type: 'run.error',

-        v: 1,

*        v: 2,
       },
       {
         exitCode: 64,
         resultIsError: true,
         type: 'run.completed',

-        v: 1,

*        v: 2,
       },
  ]) }) @@ -369,18 +383,18 @@ describe('eh run', () => { model: 'qwen3-coder',
  provider: 'ollama', type: 'run.started',

-      v: 1,

*      v: 2,
  }) expect(events[1]).toEqual({ message: expect.stringContaining('codex'),
  type: 'run.error',

-      v: 1,

*      v: 2,
  }) expect(events[2]).toEqual({ exitCode: 65, resultIsError: true, type:
  'run.completed',

-      v: 1,

*      v: 2,
  }) })

@@ -535,13 +549,13 @@ describe('eh run', () => { : expectedMessage, ), type:
'run.error',

-          v: 1,

*          v: 2,
         },
         {
           exitCode: 64,
           resultIsError: true,
           type: 'run.completed',

-          v: 1,

*          v: 2,
         },
       ])
  }, @@ -584,23 +598,38 @@ describe('eh run', () => { { sessionId:
  'claude-session', type: 'session.started',

-        v: 1,

*        v: 2,
       },
  ]) expect(events).toContainEqual({ text: 'saw: review the change', type:
  'assistant.text',

-      v: 1,

*      v: 2,
  }) expect(events).toContainEqual({ cacheReadTokens: 3, cacheWriteTokens: 2,

-      costUsd: 0.25,
       cumulative: false,

*      harnessCostUsd: 0.25,
*      inputTokens: 9,
*      outputTokens: 4,
*      type: 'usage',
*      v: 2,
* })
* // AC-2: the harness's own $0.25 is preserved as harnessCostUsd on the
* // summary event, never promoted to costUsd — eh's computed cost wins and,
* // on free ollama, is $0.
* expect(events).toContainEqual({
*      cacheReadTokens: 3,
*      cacheWriteTokens: 2,
*      costSource: 'free',
*      costUsd: 0,
*      cumulative: true,
*      harnessCostUsd: 0.25,
       inputTokens: 9,
       outputTokens: 4,
       type: 'usage',

-      v: 1,

*      v: 2,

  })

  const argsEvent = events @@ -683,7 +712,7 @@ describe('eh run', () => { model:
  'test-model', provider: 'test-gateway', type: 'run.started',

-      v: 1,

*      v: 2,

  }) const fakeEvent = z .object({ @@ -699,6 +728,121 @@ describe('eh run', ()
  => { ) })

* test('emits a gateway-rate costUsd on the final usage event for a pinned run',
  async () => {
* const fixture = createFakeClaude()
* // A gateway stub that publishes per-endpoint pricing for the pinned
* // provider: input $1/1M, output $5/1M, and no cache rate.
* const server = createServer((request, response) => {
*      if (request.url?.endsWith('/endpoints')) {
*        response.setHeader('content-type', 'application/json')
*        response.end(
*          JSON.stringify({
*            data: {
*              endpoints: [
*                {
*                  pricing: { completion: '0.000005', prompt: '0.000001' },
*                  provider_name: 'bedrock',
*                  status: 0,
*                },
*              ],
*            },
*          }),
*        )
*        return
*      }
*      response.statusCode = 500
*      response.end('unexpected request')
* })
* await new Promise<void>((resolve, reject) => {
*      server.once('error', reject)
*      server.listen(0, '127.0.0.1', () => {
*        server.off('error', reject)
*        resolve()
*      })
* })
* const address = server.address()
* if (!address || typeof address === 'string') {
*      server.close()
*      throw new Error('gateway stub did not bind a TCP port')
* }
* const ehConfigDir = path.join(fixture.configDir, 'eh')
* mkdirSync(ehConfigDir, { recursive: true })
* writeFileSync(
*      path.join(ehConfigDir, 'config.json'),
*      JSON.stringify({
*        profiles: {},
*        providers: {
*          'test-gateway': {
*            baseURL: `http://127.0.0.1:${String(address.port)}`,
*            envKey: 'EH_TEST_GATEWAY_KEY',
*            type: 'vercel-gateway',
*          },
*        },
*        recent: [],
*        version: 1,
*      }),
* )
* const child = spawn(
*      process.execPath,
*      [
*        'run',
*        'src/main.ts',
*        'run',
*        'claude',
*        'test-gateway',
*        'test-model',
*        '--gateway-provider',
*        'bedrock',
*      ],
*      {
*        cwd: repoRoot,
*        env: {
*          ...process.env,
*          EH_TEST_GATEWAY_KEY: 'qa-key',
*          PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ''}`,
*          XDG_CONFIG_HOME: fixture.configDir,
*        },
*      },
* )
* child.stdin.end('estimate the cost')
*
* const [exitCode, stderr, stdout] = await Promise.all([
*      childExitCode(child),
*      readStream(child.stderr),
*      readStream(child.stdout),
* ])
* await new Promise<void>((resolve, reject) => {
*      server.close((error) => {
*        if (error) reject(error)
*        else resolve()
*      })
* })
* const events = parseEvents(stdout)
*
* expect(stderr).toBe('')
* expect(exitCode).toBe(0)
* // The summary usage event is the only usage event carrying costSource.
* const summary = z
*      .object({
*        costSource: z.string(),
*        costUsd: z.number(),
*        harnessCostUsd: z.number(),
*      })
*      .parse(
*        events.find(
*          (event) =>
*            event.type === 'usage' && typeof event.costSource === 'string',
*        ),
*      )
* // Per-endpoint rates × claude's usage (9 in / 4 out / 3 cache-read /
* // 2 cache-write); cache bills at the $1/1M input rate (AC-4), so
* // (9 + 3 + 2) * $1 + 4 * $5 = 34 units = $0.000034.
* expect(summary.costSource).toBe('gateway-rates')
* expect(summary.costUsd).toBeCloseTo(0.000034, 10)
* // AC-2: the harness's own $0.25 estimate is preserved, never preferred.
* expect(summary.harnessCostUsd).toBe(0.25)
* })
* test('routes an opencode Gateway provider pin through the proxy', async () =>
  { const fixture = createFakeOpencode() const gateway = await
  startGatewayStub() @@ -760,7 +904,7 @@ describe('eh run', () => { model:
  'test-model', provider: 'test-gateway', type: 'run.started',

-      v: 1,

*      v: 2,
  }) const fakeEvent = z .object({ @@ -861,7 +1005,7 @@ describe('eh run', () =>
  { model: 'test-model', provider: 'test-gateway', type: 'run.started',

-      v: 1,

*      v: 2,
  }) const fakeEvent = z .object({ @@ -951,18 +1095,18 @@ describe('eh run', ()
  => { model: 'test-model', provider: 'test-gateway', type: 'run.started',

-        v: 1,

*        v: 2,
       },
       {
         message: expect.stringContaining('unavailable'),
         type: 'run.error',

-        v: 1,

*        v: 2,
       },
       {
         exitCode: 64,
         resultIsError: true,
         type: 'run.completed',

-        v: 1,

*        v: 2,
       },
  ]) }) @@ -1040,18 +1184,18 @@ describe('eh run', () => {
  expect(events).toContainEqual({ sessionId: 'grok-session', type:
  'session.started',

-      v: 1,

*      v: 2,
  }) expect(events).toContainEqual({ text: 'saw: inspect the diff', type:
  'assistant.text',

-      v: 1,

*      v: 2,
  }) expect(events.filter((event) => event.type === 'assistant.text')).toEqual([
  { text: 'saw: inspect the diff', type: 'assistant.text',

-        v: 1,

*        v: 2,
       },
  ]) const assistantTextIndex = events.findIndex( @@ -1075,17 +1219,33 @@
  describe('eh run', () => { inputTokens: 5, outputTokens: 2, type: 'usage',

-      v: 1,

*      v: 2,
* })
* expect(events).toContainEqual({
*      cacheReadTokens: 4,
*      cacheWriteTokens: 6,
*      cumulative: true,
*      harnessCostUsd: 0.12,
*      inputTokens: 20,
*      outputTokens: 8,
*      type: 'usage',
*      v: 2,
  })
* // Summary uses grok's `end` cumulative totals (20/8/4/6), NOT the summed
* // per-step deltas (which would be 25/10/5/9) — the accumulator lets a
* // cumulative:true total win. harnessCostUsd is carried through; cost is $0
* // (free ollama). expect(events).toContainEqual({ cacheReadTokens: 4,
  cacheWriteTokens: 6,

-      costUsd: 0.12,

*      costSource: 'free',
*      costUsd: 0,
       cumulative: true,
*      harnessCostUsd: 0.12,
       inputTokens: 20,
       outputTokens: 8,
       type: 'usage',

-      v: 1,

*      v: 2,
  }) })

@@ -1131,22 +1291,22 @@ describe('eh run', () => {
expect(events).toContainEqual({ sessionId: 'pi-session', type:
'session.started',

-      v: 1,

*      v: 2,
  }) expect(events).toContainEqual({ text: 'saw: inspect the parser', type:
  'assistant.text',

-      v: 1,

*      v: 2,
  }) expect(events).toContainEqual({ cacheReadTokens: 2, cacheWriteTokens: 1,

-      costUsd: 0.02,
       cumulative: false,

*      harnessCostUsd: 0.02,
       inputTokens: 11,
       outputTokens: 3,
       type: 'usage',

-      v: 1,

*      v: 2,

  })

  const argsEvent = events @@ -1217,22 +1377,22 @@ describe('eh run', () => {
  expect(events).toContainEqual({ sessionId: 'opencode-session', type:
  'session.started',

-      v: 1,

*      v: 2,
  }) expect(events).toContainEqual({ text: 'saw: review the adapter', type:
  'assistant.text',

-      v: 1,

*      v: 2,
  }) expect(events).toContainEqual({ cacheReadTokens: 4, cacheWriteTokens: 2,

-      costUsd: 0.03,
       cumulative: false,

*      harnessCostUsd: 0.03,
       inputTokens: 12,
       outputTokens: 5,
       type: 'usage',

-      v: 1,

*      v: 2,

  })

  const argsEvent = events @@ -1295,13 +1455,13 @@ describe('eh run', () => {
  expect(events).toContainEqual({ message: `expected ${harness} failure`, type:
  'run.error',

-        v: 1,

*        v: 2,
       })
       expect(events).toContainEqual({
         exitCode: 66,
         resultIsError: true,
         type: 'run.completed',

-        v: 1,

*        v: 2,
       })

  }, ) @@ -1337,7 +1497,7 @@ describe('eh run', () => {

  expect(exitCode).toBe(0) expect(events.filter((event) => event.type ===
  'assistant.text')).toEqual([

-      { text: 'saw: text only', type: 'assistant.text', v: 1 },

*      { text: 'saw: text only', type: 'assistant.text', v: 2 },
  ]) expect(assistantTextIndex).toBeGreaterThan(-1)
  expect(completedIndex).toBeGreaterThan(assistantTextIndex) @@ -1374,13
  +1534,13 @@ describe('eh run', () => { expect(events).toContainEqual({
  message: 'expected failure', type: 'run.error',

-      v: 1,

*      v: 2,
  }) expect(events).toContainEqual({ exitCode: 66, resultIsError: true, type:
  'run.completed',

-      v: 1,

*      v: 2,
  }) })

@@ -1413,13 +1573,13 @@ describe('eh run', () => {
expect(events).toContainEqual({ message: 'codex exited with code 7', type:
'run.error',

-      v: 1,

*      v: 2,
  }) expect(events).toContainEqual({ exitCode: 7, resultIsError: true, type:
  'run.completed',

-      v: 1,

*      v: 2,
  }) })

@@ -1480,13 +1640,13 @@ describe('eh run', () => {
expect(events).toContainEqual({ message: 'grok exited with signal SIGTERM',
type: 'run.error',

-        v: 1,

*        v: 2,
       })
       expect(events).toContainEqual({
         exitCode: 128 + os.constants.signals.SIGTERM,
         resultIsError: true,
         type: 'run.completed',

-        v: 1,

*        v: 2,
       })
  } finally { if (fakeArgs) { @@ -1545,9 +1705,9 @@ describe('eh run', () => {
  '--timeout must be a positive integer', ), type: 'run.error',

-          v: 1,

*          v: 2,
         },

-        { exitCode: 64, resultIsError: true, type: 'run.completed', v: 1 },

*        { exitCode: 64, resultIsError: true, type: 'run.completed', v: 2 },
       ])
       expect(
         events.some((event) => asRecord(event.event)?.type === 'fake.args'),

@@ -1627,7 +1787,7 @@ describe('eh run', () => { exitCode: 128 + expectedSignal,
resultIsError: true, type: 'run.completed',

-          v: 1,

*          v: 2,
         })
       } finally {
         if (fakePid !== undefined) {

diff --git a/src/headless-run.ts b/src/headless-run.ts index fda6af3..9692556
100644 --- a/src/headless-run.ts +++ b/src/headless-run.ts @@ -6,6 +6,7 @@
import path from 'node:path' import { createInterface } from 'node:readline'
import { z } from 'zod'

+import type { HeadlessRateCard, NormalizedUsage } from './pricing.js' import
type { EffortLevel, LaunchPlan } from './types.js'

import { withCleanup } from './cleanup.js' @@ -17,9 +18,10 @@ import {
getHarness, resolveAvailableEfforts, } from './harnesses.js' +import {
fetchHeadlessRateCard, headlessCost } from './pricing.js' import { EFFORT_LEVELS
} from './types.js'

-const PROTOCOL_VERSION = 1 +const PROTOCOL_VERSION = 2 // Reserved eh exit
codes for eh-detected failure categories — a contiguous // block at >=64
(sysexits.h's EX_ range). Raw child codes pass through // unchanged when eh has
no category, so a harness's own code may only collide @@ -48,6 +50,7 @@
interface NormalizerState { pendingGrokText: string resultIsError: boolean
sessionId: string | undefined

- usage: UsageAccumulator }

interface ResolvedHeadlessRunOptions { @@ -62,6 +65,25 @@ interface
ResolvedHeadlessRunOptions { timeoutSeconds: number | undefined }

+// eh's per-run usage accumulator: a cumulative total (when the harness reports
+// one) or the sum of per-event deltas, each with the harness's own cost.
+interface UsageAccumulator {

- cumulative: NormalizedUsage | undefined
- cumulativeHarnessCostUsd: number | undefined
- delta: NormalizedUsage
- deltaHarnessCostUsd: number | undefined +}
-

+// A single normalized usage event before it is emitted and folded. +interface
UsageEvent {

- cacheReadTokens: number
- cacheWriteTokens: number
- cumulative: boolean
- harnessCostUsd: number | undefined
- inputTokens: number
- outputTokens: number +}
-

export async function runHeadless(options: HeadlessRunOptions) { // Set after
spawn so pre-spawn setup (including withGatewayRouting // validation) still maps
to 64. After spawn, rethrow so teardown cannot @@ -101,6 +123,13 @@ export async
function runHeadless(options: HeadlessRunOptions) { await
resolveAvailableEfforts(def, provider, resolved.model), ) }

- // Resolve rates here (headless never installs the statusline that would
- // otherwise fetch them) so the final usage event can carry a computed cost.
- const rateCard = await fetchHeadlessRateCard({
-      gatewayProvider: resolved.gatewayProvider,
-      modelId: resolved.model,
-      provider,
- }) const plan = await buildLaunchPlan( resolved.harness, provider, @@ -137,6
  +166,7 @@ export async function runHeadless(options: HeadlessRunOptions) {
  state.executionStarted = true }, plan: prepared.plan,
-          rateCard,
           stdin: prepared.stdin,
           timeoutSeconds: resolved.timeoutSeconds,
         })

@@ -154,6 +184,11 @@ export async function runHeadless(options:
HeadlessRunOptions) { } }

+function addOptional(a: number | undefined, b: number | undefined) {

- if (a === undefined && b === undefined) return undefined
- return (a ?? 0) + (b ?? 0) +}
-

function asRecord(value: unknown) { const parsed = recordSchema.safeParse(value)
return parsed.success ? parsed.data : undefined @@ -175,16 +210,20 @@ function
emit(event: Record<string, unknown>) {
process.stdout.write(`${JSON.stringify({ ...event, v: PROTOCOL_VERSION })}\n`) }

-function emitGrokUsage(event: Record<string, unknown>, cumulative: boolean) {
+function emitGrokUsage(

- state: NormalizerState,
- event: Record<string, unknown>,
- cumulative: boolean, +) { const usage = asRecord(event.usage)

* if (!usage) return
* emitUsage({

- if (!usage) return state
- return recordUsage(state, { cacheReadTokens: numberField(usage,
  'cache_read_input_tokens'), cacheWriteTokens: numberField(usage,
  'cache_creation_input_tokens'),

* costUsd:

- cumulative,
- harnessCostUsd: optionalNumberField(event, 'total_cost_usd') ??
  optionalNumberField(event, 'cost_usd'),

* cumulative, inputTokens: numberField(usage, 'input_tokens'), outputTokens:
  numberField(usage, 'output_tokens'), }) @@ -216,19 +255,17 @@ function
  emitSession(value: unknown, current: string | undefined) { return current }

-function emitUsage(usage: {

- cacheReadTokens: number
- cacheWriteTokens: number
- costUsd: number | undefined
- cumulative: boolean
- inputTokens: number
- outputTokens: number -}) { +// Per-event usage carries the harness's own cost
  estimate as harnessCostUsd — +// never as costUsd. eh's authoritative computed
  cost is emitted once, on the +// final summary usage event, so the two are
  never conflated. +function emitUsage(usage: UsageEvent) { emit({
  cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens:
  usage.cacheWriteTokens,
- ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
  cumulative: usage.cumulative,

* ...(usage.harnessCostUsd === undefined
*      ? {}
*      : { harnessCostUsd: usage.harnessCostUsd }),
  inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, type:
  'usage', @@ -244,6 +281,7 @@ async function executeHeadlessPlan(options: {
  harness: string markSpawned: () => void plan: LaunchPlan
* rateCard: HeadlessRateCard stdin?: string timeoutSeconds?: number }) { @@
  -257,6 +295,7 @@ async function executePreparedHeadlessPlan(options: {
  harness: string markSpawned: () => void plan: LaunchPlan
* rateCard: HeadlessRateCard stdin?: string timeoutSeconds?: number }) { @@
  -322,6 +361,12 @@ async function executePreparedHeadlessPlan(options: {
  pendingGrokText: '', resultIsError: false, sessionId: undefined,
*      usage: {
*        cumulative: undefined,
*        cumulativeHarnessCostUsd: undefined,
*        delta: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
*        deltaHarnessCostUsd: undefined,
*      },
  } for await (const line of lines) { state = normalizeHarnessLine({ @@ -365,6
  +410,7 @@ async function executePreparedHeadlessPlan(options: { resultIsError
  && childExitCode === 0 ? EH_EXIT_HARNESS_ERROR : childExitCode
* emitCostSummary(state.usage, options.rateCard) emit({ exitCode, resultIsError,
  type: 'run.completed' }) return exitCode } finally { @@ -376,6 +422,88 @@
  async function executePreparedHeadlessPlan(options: { } }

+// Emit the per-event usage and fold it into the run accumulator. +function
recordUsage(state: NormalizerState, usage: UsageEvent) {

- emitUsage(usage)
- return { ...state, usage: foldUsage(state.usage, usage) } +}
-

+// Total usage for the summary event, or undefined when the run reported none
+// (e.g. a spawn/timeout kill before any usage) — so no phantom $0 is emitted.
+function finalUsage(acc: UsageAccumulator) {

- if (acc.cumulative) {
- return {
-      harnessCostUsd: acc.cumulativeHarnessCostUsd,
-      usage: acc.cumulative,
- }
- }
- const { cacheRead, cacheWrite, input, output } = acc.delta
- if (
- cacheRead === 0 &&
- cacheWrite === 0 &&
- input === 0 &&
- output === 0 &&
- acc.deltaHarnessCostUsd === undefined
- ) {
- return undefined
- }
- return { harnessCostUsd: acc.deltaHarnessCostUsd, usage: acc.delta } +}
-

+// Accumulate eh's own normalized usage. A cumulative:true total wins outright;
+// otherwise per-event deltas are summed. This avoids double-counting harnesses
+// (grok) that emit both per-step deltas and a final cumulative total.
+function foldUsage(acc: UsageAccumulator, usage: UsageEvent): UsageAccumulator
{

- const tokens: NormalizedUsage = {
- cacheRead: usage.cacheReadTokens,
- cacheWrite: usage.cacheWriteTokens,
- input: usage.inputTokens,
- output: usage.outputTokens,
- }
- if (usage.cumulative) {
- return {
-      ...acc,
-      cumulative: tokens,
-      cumulativeHarnessCostUsd: usage.harnessCostUsd,
- }
- }
- return {
- ...acc,
- delta: {
-      cacheRead: acc.delta.cacheRead + tokens.cacheRead,
-      cacheWrite: acc.delta.cacheWrite + tokens.cacheWrite,
-      input: acc.delta.input + tokens.input,
-      output: acc.delta.output + tokens.output,
- },
- deltaHarnessCostUsd: addOptional(
-      acc.deltaHarnessCostUsd,
-      usage.harnessCostUsd,
- ),
- } +}
-

+// Emit the final summary usage event: eh's own cumulative normalized usage
with +// the cost it computed from the resolved gateway rates (costUsd +
costSource), +// plus the harness's own estimate preserved separately as
harnessCostUsd. +function emitCostSummary(acc: UsageAccumulator, rateCard:
HeadlessRateCard) {

- const final = finalUsage(acc)
- if (!final) return
- const { costSource, costUsd } = headlessCost(rateCard, final.usage)
- emit({
- cacheReadTokens: final.usage.cacheRead,
- cacheWriteTokens: final.usage.cacheWrite,
- costSource,
- ...(costUsd === undefined ? {} : { costUsd }),
- cumulative: true,
- ...(final.harnessCostUsd === undefined
-      ? {}
-      : { harnessCostUsd: final.harnessCostUsd }),
- inputTokens: final.usage.input,
- outputTokens: final.usage.output,
- type: 'usage',
- }) +}
-

function flushGrokText(state: NormalizerState) { if (!state.pendingGrokText)
return state emit({ text: state.pendingGrokText, type: 'assistant.text' }) @@
-412,12 +540,13 @@ function normalizeClaudeEvent( if (event.type !== 'result')
return { ...state, sessionId } sessionId = emitSession(event.session_id,
sessionId) const usage = asRecord(event.usage)

- let nextState = state if (usage) {

* emitUsage({

- nextState = recordUsage(nextState, { cacheReadTokens: numberField(usage,
  'cache_read_input_tokens'), cacheWriteTokens: numberField(usage,
  'cache_creation_input_tokens'),

*      costUsd: optionalNumberField(event, 'total_cost_usd'),
       cumulative: false,

-      harnessCostUsd: optionalNumberField(event, 'total_cost_usd'),
       inputTokens: numberField(usage, 'input_tokens'),
       outputTokens: numberField(usage, 'output_tokens'),
  }) @@ -427,8 +556,8 @@ function normalizeClaudeEvent( (typeof event.subtype
  === 'string' && event.subtype !== 'success') if (resultIsError)
  emitRunError(event, 'Claude reported a failed result') return {

* ...state,
* resultIsError: state.resultIsError || resultIsError,

- ...nextState,
- resultIsError: nextState.resultIsError || resultIsError, sessionId, } } @@
  -449,16 +578,17 @@ function normalizeCodexEvent( } }

- let nextState = state if (event.type === 'turn.completed') { const usage =
  asRecord(event.usage) if (usage) {

*      emitUsage({

-      nextState = recordUsage(nextState, {
         cacheReadTokens: numberField(usage, 'cached_input_tokens'),
         cacheWriteTokens: 0,

*        costUsd:

-        cumulative: true,
-        harnessCostUsd:
           optionalNumberField(event, 'total_cost_usd') ??
           optionalNumberField(event, 'cost_usd'),

*        cumulative: true,
         inputTokens: numberField(usage, 'input_tokens'),
         outputTokens: numberField(usage, 'output_tokens'),
       })

@@ -467,10 +597,10 @@ function normalizeCodexEvent(

if (event.type === 'turn.failed' || event.type === 'error') {
emitRunError(event, 'Codex reported a failed turn')

- return { ...state, resultIsError: true, sessionId }

* return { ...nextState, resultIsError: true, sessionId } }

- return { ...state, sessionId }

* return { ...nextState, sessionId } }

function normalizeGrokEvent( @@ -481,13 +611,13 @@ function normalizeGrokEvent(
return { ...state, pendingGrokText: state.pendingGrokText + event.data } } let
nextState = state

- if (event.type === 'usage') emitGrokUsage(event, false)

* if (event.type === 'usage') nextState = emitGrokUsage(nextState, event, false)
  if (event.type === 'end') { nextState = { ...nextState, sessionId:
  emitSession(event.sessionId, nextState.sessionId), }

- emitGrokUsage(event, true)

* nextState = emitGrokUsage(nextState, event, true) } if (event.type ===
  'error') { emitRunError(event, 'Grok reported an error') @@ -546,7 +676,7 @@
  function normalizeOpencodeEvent( event: Record<string, unknown>, state:
  NormalizerState, ) {

- const nextState = emitNewSession(event.sessionID, state)

* let nextState = emitNewSession(event.sessionID, state) const part =
  asRecord(event.part)

  if ( @@ -561,11 +691,11 @@ function normalizeOpencodeEvent( const tokens =
  asRecord(part.tokens) const cache = tokens ? asRecord(tokens.cache) :
  undefined if (tokens) {

-      emitUsage({

*      nextState = recordUsage(nextState, {
         cacheReadTokens: cache ? numberField(cache, 'read') : 0,
         cacheWriteTokens: cache ? numberField(cache, 'write') : 0,

-        costUsd: optionalNumberField(part, 'cost'),
         cumulative: false,

*        harnessCostUsd: optionalNumberField(part, 'cost'),
         inputTokens: numberField(tokens, 'input'),
         outputTokens: numberField(tokens, 'output'),
       })

@@ -583,7 +713,7 @@ function normalizePiEvent( event: Record<string, unknown>,
state: NormalizerState, ) {

- const nextState = emitNewSession(event.id, state)

* let nextState = emitNewSession(event.id, state) if (event.type !==
  'message_end') return nextState

  const message = asRecord(event.message) @@ -600,11 +730,11 @@ function
  normalizePiEvent( const usage = asRecord(message.usage) if (usage) { const
  cost = asRecord(usage.cost)

- emitUsage({

* nextState = recordUsage(nextState, { cacheReadTokens: numberField(usage,
  'cacheRead'), cacheWriteTokens: numberField(usage, 'cacheWrite'),

-      costUsd: cost ? optionalNumberField(cost, 'total') : undefined,
       cumulative: false,

*      harnessCostUsd: cost ? optionalNumberField(cost, 'total') : undefined,
       inputTokens: numberField(usage, 'input'),
       outputTokens: numberField(usage, 'output'),
  }) diff --git a/src/pricing.test.ts b/src/pricing.test.ts index
  229e4f1..a72c98f 100644 --- a/src/pricing.test.ts +++ b/src/pricing.test.ts @@
  -1,7 +1,15 @@ import { expect, test } from 'bun:test' import { createServer }
  from 'node:http'

-import { fetchModelMeta } from './pricing.js' +import type { EndpointPricing }
from './pricing.js' + +import {

- endpointRates,
- fetchHeadlessRateCard,
- fetchModelMeta,
- gatewayCostUsd,
- headlessCost, +} from './pricing.js'

test('reports the full active gateway rate range including context tiers', async
() => { const server = createServer((request, response) => { @@ -181,3 +189,223
@@ test('pins OpenRouter rate labels to the endpoint tag, not the display name',
as }) } }) + +test('fetchHeadlessRateCard resolves per-endpoint pricing for a
gateway pin', async () => {

- const server = createServer((request, response) => {
- response.setHeader('content-type', 'application/json')
- if (request.url === '/v1/models') {
-      response.end(
-        JSON.stringify({
-          data: [
-            {
-              context_window: 1_000_000,
-              id: 'test/model',
-              pricing: { input: '0.000001', output: '0.000004' },
-            },
-          ],
-        }),
-      )
-      return
- }
- if (request.url?.endsWith('/endpoints')) {
-      response.end(
-        JSON.stringify({
-          data: {
-            endpoints: [
-              {
-                pricing: { completion: '0.0000044', prompt: '0.0000014' },
-                provider_name: 'nebius',
-                status: 0,
-              },
-              {
-                pricing: { completion: '0.000009', prompt: '0.000008' },
-                provider_name: 'fireworks',
-                status: 0,
-              },
-            ],
-          },
-        }),
-      )
-      return
- }
- response.statusCode = 500
- response.end('unexpected request')
- })
- await new Promise<void>((resolve, reject) => {
- server.once('error', reject)
- server.listen(0, '127.0.0.1', resolve)
- })
- const address = server.address()
- if (!address || typeof address === 'string') {
- server.close()
- throw new Error('test pricing server did not bind a TCP port')
- }
-
- try {
- const provider = {
-      baseURL: `http://127.0.0.1:${String(address.port)}`,
-      name: 'test-gateway',
-      type: 'vercel-gateway' as const,
- }
- const usage = {
-      cacheRead: 0,
-      cacheWrite: 0,
-      input: 1_000_000,
-      output: 1_000_000,
- }
-
- const pinned = await fetchHeadlessRateCard({
-      gatewayProvider: 'nebius',
-      modelId: 'test/model',
-      provider,
- })
- expect(pinned.kind).toBe('endpoint')
- // The pin bills the nebius endpoint's rates ($1.4 + $4.4), not the
- // model-aggregate ($1 + $4) — proof the pin drives per-endpoint pricing.
- expect(headlessCost(pinned, usage).costUsd).toBeCloseTo(5.8, 10)
-
- const unpinned = await fetchHeadlessRateCard({
-      modelId: 'test/model',
-      provider,
- })
- expect(unpinned).toEqual({
-      kind: 'rates',
-      rates: {
-        cacheReadPerMillion: undefined,
-        cacheWritePerMillion: undefined,
-        inputPerMillion: 1,
-        outputPerMillion: 4,
-      },
- })
-
- const unknown = await fetchHeadlessRateCard({
-      modelId: 'missing/model',
-      provider,
- })
- expect(unknown).toEqual({ kind: 'unavailable' })
- } finally {
- await new Promise<void>((resolve, reject) => {
-      server.close((error) => {
-        if (error) reject(error)
-        else resolve()
-      })
- })
- } +})
-

+test('fetchHeadlessRateCard is free for ollama without any network', async ()
=> {

- // An unreachable baseURL proves the ollama branch returns before any fetch;
- // a network attempt would resolve to `unavailable`, not `free`.
- const card = await fetchHeadlessRateCard({
- modelId: 'qwen3-coder',
- provider: {
-      baseURL: 'http://127.0.0.1:1',
-      name: 'ollama',
-      type: 'ollama',
- },
- })
- expect(card).toEqual({ kind: 'free' }) +})
-

+test('gatewayCostUsd bills input, output, and cache tokens per million', () =>
{

- const rates = { inputPerMillion: 1.4, outputPerMillion: 4.4 }
- // 200k input * $1.4/1M = $0.28; 50k output * $4.4/1M = $0.22.
- expect(
- gatewayCostUsd(rates, {
-      cacheRead: 0,
-      cacheWrite: 0,
-      input: 200_000,
-      output: 50_000,
- }),
- ).toBeCloseTo(0.5, 10) +})
-

+test('gatewayCostUsd bills cache tokens at the input rate when unpublished', ()
=> {

- const rates = { inputPerMillion: 1.4, outputPerMillion: 4.4 }
- // No cache rate → 100k cache reads bill at the $1.4/1M input rate = $0.14.
- expect(
- gatewayCostUsd(rates, {
-      cacheRead: 100_000,
-      cacheWrite: 0,
-      input: 0,
-      output: 0,
- }),
- ).toBeCloseTo(0.14, 10)
- // A published cache-read rate is used instead: 100k * $0.14/1M = $0.014.
- expect(
- gatewayCostUsd(
-      { ...rates, cacheReadPerMillion: 0.14 },
-      { cacheRead: 100_000, cacheWrite: 0, input: 0, output: 0 },
- ),
- ).toBeCloseTo(0.014, 10) +})
-

+test('endpointRates selects the tier bracket containing the token count', () =>
{

- const pricing: EndpointPricing = {
- completion: '0.000005',
- prompt_tiers: [
-      { cost: '0.000001', max: 200_001, min: 0 },
-      { cost: '0.000004', min: 200_001 },
- ],
- }
- expect(
- endpointRates(pricing, {
-      cacheRead: 0,
-      cacheWrite: 0,
-      input: 1_000,
-      output: 1_000,
- })?.inputPerMillion,
- ).toBe(1)
- expect(
- endpointRates(pricing, {
-      cacheRead: 0,
-      cacheWrite: 0,
-      input: 300_000,
-      output: 1_000,
- })?.inputPerMillion,
- ).toBe(4) +})
-

+test('endpointRates falls back to the base rate, then undefined', () => {

- const usage = { cacheRead: 0, cacheWrite: 0, input: 1_000, output: 1_000 }
- expect(
- endpointRates({ completion: '0.000005', prompt: '0.000001' }, usage),
- ).toEqual({
- cacheReadPerMillion: undefined,
- cacheWritePerMillion: undefined,
- inputPerMillion: 1,
- outputPerMillion: 5,
- })
- // No prompt rate and no prompt tiers → no input rate → whole card undefined.
- expect(endpointRates({ completion: '0.000005' }, usage)).toBeUndefined() +})
-

+test('headlessCost classifies the source and never fabricates cost', () => {

- const usage = {
- cacheRead: 0,
- cacheWrite: 0,
- input: 1_000_000,
- output: 1_000_000,
- }
- expect(headlessCost({ kind: 'free' }, usage)).toEqual({
- costSource: 'free',
- costUsd: 0,
- })
- expect(headlessCost({ kind: 'unavailable' }, usage)).toEqual({
- costSource: 'unavailable',
- costUsd: undefined,
- })
- // All-zero paid rates collapse to free, not a $0 gateway-rates bill.
- expect(
- headlessCost(
-      { kind: 'rates', rates: { inputPerMillion: 0, outputPerMillion: 0 } },
-      usage,
- ),
- ).toEqual({ costSource: 'free', costUsd: 0 })
- const paid = headlessCost(
- { kind: 'rates', rates: { inputPerMillion: 1.4, outputPerMillion: 4.4 } },
- usage,
- )
- expect(paid.costSource).toBe('gateway-rates')
- expect(paid.costUsd).toBeCloseTo(5.8, 10) +}) diff --git a/src/pricing.ts
  b/src/pricing.ts index 3f97285..a708a3d 100644 --- a/src/pricing.ts +++
  b/src/pricing.ts @@ -20,6 +20,27 @@ export interface ModelMeta { rates:
  ModelRates | undefined }

+// How a headless run's cost was derived: from gateway rates, free (a zero-rate
+// provider), or unavailable when no rates could be resolved. +export type
HeadlessCostSource = 'free' | 'gateway-rates' | 'unavailable' + +// eh's own
normalized token counts for a run, summed across harness events. +export
interface NormalizedUsage {

- cacheRead: number
- cacheWrite: number
- input: number
- output: number +}
-

+// The rate source resolved for a headless run. `endpoint` carries the raw +//
per-endpoint pricing (tier selection is usage-dependent, so it's deferred to +//
cost time); `rates` is the model-aggregate fallback when no pin is given.
+export type HeadlessRateCard =

- | { kind: 'endpoint'; pricing: EndpointPricing }
- | { kind: 'free' }
- | { kind: 'rates'; rates: ModelRates }
- | { kind: 'unavailable' }
-

// Providers disagree on string vs number and camelCase vs snake_case. const
priceField = z.union([z.string(), z.number()]).optional() const priceValue =
z.union([z.string(), z.number()]) @@ -65,16 +86,26 @@ const gatewayModelsSchema
= z.object({ ), })

+// Per-endpoint pricing. Cache fields are declared so headless cost computation
+// can read them; the gateway publishes them under either naming. +const
gatewayEndpointPricingSchema = z.looseObject({

- cacheCreationInputTokens: priceField,
- cachedInputTokens: priceField,
- completion: priceField,
- completion_tiers: z.array(priceTierSchema).optional(),
- input_cache_read: priceField,
- input_cache_write: priceField,
- prompt: priceField,
- prompt_tiers: z.array(priceTierSchema).optional(), +})
-

+export type EndpointPricing = z.infer<typeof gatewayEndpointPricingSchema> +
const gatewayEndpointsSchema = z.object({ data: z.looseObject({ endpoints:
z.array( z.looseObject({

-        pricing: z.looseObject({
-          completion: priceField,
-          completion_tiers: z.array(priceTierSchema).optional(),
-          prompt: priceField,
-          prompt_tiers: z.array(priceTierSchema).optional(),
-        }),

*        pricing: gatewayEndpointPricingSchema,
         provider_name: z.string(),
         status: z.number().optional(),
         tag: z.string().optional(),

@@ -128,6 +159,42 @@ export async function fetchModelMeta(props: { } }

+// Resolve the rate source for a headless run. A `--gateway-provider` pin gets
+// per-endpoint pricing (AC-1); otherwise fall back to the model-aggregate
rates. +// Never throws — any failure resolves to `unavailable` so no cost is
fabricated. +export async function fetchHeadlessRateCard(props: {

- gatewayProvider?: string
- modelId: string
- provider: ResolvedProvider +}): Promise<HeadlessRateCard> {
- const { gatewayProvider, modelId, provider } = props
- if (provider.type === 'ollama') return { kind: 'free' }
- const key = provider.envKey
- ? await resolveApiKey(provider.envKey, provider.name)
- : undefined
- const apiKey = key && key.source !== 'none' ? key.value : undefined
- try {
- if (
-      gatewayProvider != null &&
-      (provider.type === 'vercel-gateway' || provider.type === 'openrouter')
- ) {
-      const pricing = await fetchEndpointPricing({
-        apiKey,
-        baseURL: provider.baseURL,
-        gatewayProvider,
-        modelId,
-      })
-      if (pricing) return { kind: 'endpoint', pricing }
- }
- const meta = await fetchModelMeta({ gatewayProvider, modelId, provider })
- if (!meta.rates) return { kind: 'unavailable' }
- if (ratesAreFree(meta.rates)) return { kind: 'free' }
- return { kind: 'rates', rates: meta.rates }
- } catch {
- return { kind: 'unavailable' }
- } +}
-

export function formatExactSessionCostUsd(amount: string) { return `$${amount}`
} @@ -159,6 +226,37 @@ export function formatStatuslineCost(props: { return
`~${props.estimatedCost}` }

+// The pricing of the first active endpoint matching the pin. Mirrors the
fetch + +// filter of `fetchGatewayRateLabel`, but returns usable rates, not a
label. +// Returns undefined on any failure so the caller can fall back to model
rates. +async function fetchEndpointPricing(props: {

- apiKey: string | undefined
- baseURL: string
- gatewayProvider: string
- modelId: string +}): Promise<EndpointPricing | undefined> {
- try {
- const modelPath = props.modelId.split('/').map(encodeURIComponent).join('/')
- const body = await fetchJson(
-      `${withV1(props.baseURL)}/models/${modelPath}/endpoints`,
-      props.apiKey,
- )
- const match = gatewayEndpointsSchema
-      .parse(body)
-      .data.endpoints.find(
-        (endpoint) =>
-          (endpoint.status == null || endpoint.status === 0) &&
-          gatewaySlugMatches(
-            endpoint.tag ?? endpoint.provider_name,
-            props.gatewayProvider,
-          ),
-      )
- return match?.pricing
- } catch {
- return undefined
- } +}
-

// Compact $ for the bar: $1.5, $0.15, $12 — drop trailing zeros past 2 decimals
// when the value is whole-ish, keep more for sub-cent rates. export function
formatUsd(amount: number) { @@ -195,6 +293,87 @@ export function sessionCostUsd(
return formatSessionCostUsd(usd) }

+// Cost of eh's own normalized usage against a resolved rate card. Returns the
+// cost source so unavailable rates are reported, never fabricated as $0.
+export function headlessCost(

- card: HeadlessRateCard,
- usage: NormalizedUsage, +): { costSource: HeadlessCostSource; costUsd: number
  | undefined } {
- if (card.kind === 'free') return { costSource: 'free', costUsd: 0 }
- if (card.kind === 'unavailable') {
- return { costSource: 'unavailable', costUsd: undefined }
- }
- const rates =
- card.kind === 'endpoint' ? endpointRates(card.pricing, usage) : card.rates
- if (!rates) return { costSource: 'unavailable', costUsd: undefined }
- if (ratesAreFree(rates)) return { costSource: 'free', costUsd: 0 }
- return { costSource: 'gateway-rates', costUsd: gatewayCostUsd(rates, usage) }
  +}
-

+// Numeric cost from per-million rates. Unlike sessionCostUsd this never
returns +// undefined for missing cache rates: AC-4 bills cache reads/writes at
the +// regular input rate when the endpoint publishes no cache rate — a
provider that +// gives no cache discount charges cache tokens as ordinary
input, so input-rate +// is the non-fabricating default (zero would understate
the bill). +export function gatewayCostUsd(rates: ModelRates, usage:
NormalizedUsage) {

- const cacheReadRate = rates.cacheReadPerMillion ?? rates.inputPerMillion
- const cacheWriteRate = rates.cacheWritePerMillion ?? rates.inputPerMillion
- return (
- (usage.input * rates.inputPerMillion +
-      usage.output * rates.outputPerMillion +
-      usage.cacheRead * cacheReadRate +
-      usage.cacheWrite * cacheWriteRate) /
- 1_000_000
- ) +}
-

+// Convert per-endpoint pricing to per-million rates for the given usage. Tiers
+// are treated as context brackets: the bucket is charged at the matched tier's
+// rate. Returns undefined when neither a base rate nor a tier resolves.
+export function endpointRates(

- pricing: EndpointPricing,
- usage: NormalizedUsage, +): ModelRates | undefined {
- const inputPerMillion = tierRate(
- pricing.prompt,
- pricing.prompt_tiers,
- usage.input,
- )
- const outputPerMillion = tierRate(
- pricing.completion,
- pricing.completion_tiers,
- usage.output,
- )
- if (inputPerMillion == null || outputPerMillion == null) return undefined
- return {
- cacheReadPerMillion: perTokenToPerMillion(
-      pricing.cachedInputTokens ?? pricing.input_cache_read,
- ),
- cacheWritePerMillion: perTokenToPerMillion(
-      pricing.cacheCreationInputTokens ?? pricing.input_cache_write,
- ),
- inputPerMillion,
- outputPerMillion,
- } +}
-

+// Pick the tier bracket containing `count` and return its per-million rate;
+// fall back to the base rate, then the first tier. +function tierRate(

- base: number | string | undefined,
- tiers: undefined | z.infer<typeof priceTierSchema>[],
- count: number, +) {
- const match = tiers?.find(
- (tier) =>
-      count >= (tier.min ?? 0) && (tier.max == null || count <= tier.max),
- )
- if (match) return perTokenToPerMillion(match.cost)
- const fromBase = perTokenToPerMillion(base)
- if (fromBase != null) return fromBase
- return perTokenToPerMillion(tiers?.[0]?.cost) +}
-

// Context % matching Claude Code's formula (input-side only; not output): //
(input + cache_creation + cache_read) / window_size * 100 export function
contextUsedPercentage(props: {

```

```
