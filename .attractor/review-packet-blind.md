# Review Context Packet

Changed files in review scope (vs `origin/main`, pipeline artifacts filtered out):

- DESIGN.md
- README.md
- docs/qa/eh-cli.md
- package.json
- src/gateway-routing.test.ts
- src/headless-run.test.ts
- src/headless-run.ts
- src/main.ts

## Unified diff

```diff
diff --git a/DESIGN.md b/DESIGN.md
index 7ab2607..e8b947a 100644
--- a/DESIGN.md
+++ b/DESIGN.md
@@ -87,14 +87,17 @@ orchestrator boundary alongside the interactive launcher. It reads the prompt
 from stdin, selects each harness's native machine-output mode, preserves native
 events inside a versioned NDJSON envelope, and emits normalized session, text,
 usage, and completion events. It does not open UI, write recents, or install the
-Claude statusline. The caller owns cwd, scratch/config roots, process timeouts,
-and lifecycle policy; `eh` owns provider wiring and harness protocol parsing.
-Callers can preserve harness-specific policy with a validated JSON string array
-of native arguments, which `eh` prepends before its mandatory machine-mode
-arguments. The five native adapters are Claude `stream-json`, Codex `--json`,
-Grok `streaming-json`, pi `--mode json`, and opencode `run --format json`; pi
-and opencode keep prompt input on stdin and expose their native session IDs,
-text, usage, cost, and semantic errors through the same normalized contract.
+Claude statusline. The caller owns cwd, scratch/config roots, and lifecycle
+policy, though `eh run` offers an optional `--timeout <seconds>` deadline that
+emits a `run.error`, sends `SIGTERM`, then escalates to `SIGKILL` after the
+named `TIMEOUT_KILL_GRACE_MS` grace (overridable via `EH_TIMEOUT_KILL_GRACE_MS`
+for tests); `eh` owns provider wiring and harness protocol parsing. Callers can
+preserve harness-specific policy with a validated JSON string array of native
+arguments, which `eh` prepends before its mandatory machine-mode arguments. The
+five native adapters are Claude `stream-json`, Codex `--json`, Grok
+`streaming-json`, pi `--mode json`, and opencode `run --format json`; pi and
+opencode keep prompt input on stdin and expose their native session IDs, text,
+usage, cost, and semantic errors through the same normalized contract.
 
 **Phase 2 (later): local router.** An opt-in localhost proxy that receives
 Anthropic Messages / OpenAI requests and fulfills them via the Vercel AI SDK
diff --git a/README.md b/README.md
index 723bdc3..dc89f7a 100644
--- a/README.md
+++ b/README.md
@@ -174,7 +174,11 @@ for all five harnesses with `--resume-session <id>`. Orchestrators that must
 preserve harness-specific policy flags can pass a JSON string array with
 `--native-args-json`; those args are prepended before `eh`'s required
 machine-output flags. OpenRouter and Vercel AI Gateway runs through Claude,
-Codex, Grok, opencode, or pi may also use `--gateway-provider <slug>`.
+Codex, Grok, opencode, or pi may also use `--gateway-provider <slug>`. Pass
+`--timeout <seconds>` to fail a hung lane loudly: on expiry `eh` emits a
+`run.error` naming the limit, sends `SIGTERM`, then escalates to `SIGKILL` after
+a 10s grace period; `run.completed` is still the final event and a timed-out
+child exits `143`. Omitting the flag keeps today's no-deadline behavior.
 
 ### Keys
 
diff --git a/docs/qa/eh-cli.md b/docs/qa/eh-cli.md
index 8468b22..40e9dc2 100644
--- a/docs/qa/eh-cli.md
+++ b/docs/qa/eh-cli.md
@@ -296,7 +296,12 @@ Drive each with the PTY; assert on screen text.
    exits non-zero even if the fake child exits 0. Preflight cases cover empty
    stdin, malformed native args, invalid effort, unknown harness/provider, pi
    provider incompatibility, and missing keys; each must emit only versioned
-   `run.error` + failed `run.completed` records on stdout and exit non-zero.
+   `run.error` + failed `run.completed` records on stdout and exit non-zero. The
+   suite also covers `--timeout`: preflight rejection of
+   non-positive/negative/non-numeric values (the fake harness is never invoked),
+   SIGTERM-on-expiry with a single limit-naming `run.error` before the final
+   `run.completed`, SIGKILL escalation via `EH_TIMEOUT_KILL_GRACE_MS`, and the
+   no-effect invariant when a run finishes before the deadline.
 2. With Ollama running and a pulled model declared for the `ollama` provider in
    pi's `models.json`, run a short real pi request (replace `<model>`):
 
diff --git a/package.json b/package.json
index b09077d..b29f006 100644
--- a/package.json
+++ b/package.json
@@ -1,6 +1,6 @@
 {
   "name": "exquisite-harness",
-  "version": "0.11.0",
+  "version": "0.12.0",
   "private": true,
   "description": "Choose a harness, choose a provider, go.",
   "type": "module",
diff --git a/src/gateway-routing.test.ts b/src/gateway-routing.test.ts
index def570f..86f5cd1 100644
--- a/src/gateway-routing.test.ts
+++ b/src/gateway-routing.test.ts
@@ -428,6 +428,11 @@ describe('gateway provider routing', () => {
       )
     })
 
+    // gatewayValidationHeaders also falls back to the ambient process.env value
+    // for the key, so clear it here to keep the "deliberately blank" case blank
+    // even when the environment injects a real ANTHROPIC_API_KEY.
+    const ambientApiKey = process.env.ANTHROPIC_API_KEY
+    delete process.env.ANTHROPIC_API_KEY
     try {
       await withGatewayRouting(
         {
@@ -450,6 +455,8 @@ describe('gateway provider routing', () => {
       )
       expect(validationAuthorization).toBe('Bearer qa-auth-token')
     } finally {
+      if (ambientApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
+      else process.env.ANTHROPIC_API_KEY = ambientApiKey
       await upstream.close()
     }
   })
diff --git a/src/headless-run.test.ts b/src/headless-run.test.ts
index 63965f6..9b8d5e4 100644
--- a/src/headless-run.test.ts
+++ b/src/headless-run.test.ts
@@ -1256,6 +1256,184 @@ describe('eh run', () => {
       }
     }
   })
+
+  test.each(['0', '-5', 'soon'])(
+    'rejects the invalid --timeout %s before spawning the harness',
+    async (value) => {
+      const fixture = createFakeCodex()
+      const child = spawn(
+        process.execPath,
+        [
+          'run',
+          'src/main.ts',
+          'run',
+          'codex',
+          'ollama',
+          'qwen3-coder',
+          '--timeout',
+          value,
+        ],
+        {
+          cwd: repoRoot,
+          env: {
+            ...process.env,
+            PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ''}`,
+            XDG_CONFIG_HOME: fixture.configDir,
+          },
+        },
+      )
+      child.stdin.end('run the task')
+
+      const [exitCode, stderr, stdout] = await Promise.all([
+        childExitCode(child),
+        readStream(child.stderr),
+        readStream(child.stdout),
+      ])
+      const events = parseEvents(stdout)
+
+      expect(stderr).toBe('')
+      expect(exitCode).toBe(1)
+      expect(events).toEqual([
+        {
+          message: expect.stringContaining(
+            '--timeout must be a positive integer',
+          ),
+          type: 'run.error',
+          v: 1,
+        },
+        { exitCode: 1, resultIsError: true, type: 'run.completed', v: 1 },
+      ])
+      expect(
+        events.some((event) => asRecord(event.event)?.type === 'fake.args'),
+      ).toBe(false)
+    },
+  )
+
+  test.each([
+    {
+      env: {},
+      expectedSignal: os.constants.signals.SIGTERM,
+      makeFake: createFakeSleeper,
+      name: 'sends SIGTERM and names the limit when a hung harness exceeds --timeout',
+    },
+    {
+      env: { EH_TIMEOUT_KILL_GRACE_MS: '100' },
+      expectedSignal: os.constants.signals.SIGKILL,
+      makeFake: createFakeSigtermTrap,
+      name: 'escalates to SIGKILL when the timed-out harness traps SIGTERM',
+    },
+  ])(
+    '$name',
+    async ({ env, expectedSignal, makeFake }) => {
+      const fixture = makeFake()
+      const child = spawn(
+        process.execPath,
+        [
+          'run',
+          'src/main.ts',
+          'run',
+          'codex',
+          'ollama',
+          'qwen3-coder',
+          '--timeout',
+          '1',
+        ],
+        {
+          cwd: repoRoot,
+          env: {
+            ...process.env,
+            ...env,
+            PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ''}`,
+            XDG_CONFIG_HOME: fixture.configDir,
+          },
+        },
+      )
+      child.stdin.end('hang forever')
+
+      let fakePid: number | undefined
+      try {
+        const [exitCode, stderr, stdout] = await Promise.all([
+          childExitCode(child),
+          readStream(child.stderr),
+          readStream(child.stdout),
+        ])
+        const events = parseEvents(stdout)
+        fakePid = timeoutFakePid(events)
+
+        expect(stderr).toBe('')
+        expect(exitCode).toBe(128 + expectedSignal)
+
+        // Exactly one run.error — the timeout's limit-naming one — so the generic
+        // "exited with signal" error is suppressed.
+        const runErrors = events.filter((event) => event.type === 'run.error')
+        expect(runErrors).toHaveLength(1)
+        expect(String(runErrors[0]?.message)).toContain('1s')
+
+        const errorIndex = events.findIndex(
+          (event) => event.type === 'run.error',
+        )
+        const completedIndex = events.findIndex(
+          (event) => event.type === 'run.completed',
+        )
+        expect(errorIndex).toBeLessThan(completedIndex)
+        expect(completedIndex).toBe(events.length - 1)
+        expect(events[completedIndex]).toEqual({
+          exitCode: 128 + expectedSignal,
+          resultIsError: true,
+          type: 'run.completed',
+          v: 1,
+        })
+      } finally {
+        if (fakePid !== undefined) {
+          try {
+            process.kill(fakePid, 'SIGKILL')
+          } catch {
+            // The timeout path already reaped the fake harness.
+          }
+        }
+      }
+    },
+    20_000,
+  )
+
+  test('leaves a run that finishes before the deadline unchanged', async () => {
+    const runFast = async (extraArgs: string[]) => {
+      const fixture = createFakeCodex()
+      const child = spawn(
+        process.execPath,
+        [
+          'run',
+          'src/main.ts',
+          'run',
+          'codex',
+          'ollama',
+          'qwen3-coder',
+          ...extraArgs,
+        ],
+        {
+          cwd: repoRoot,
+          env: {
+            ...process.env,
+            PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ''}`,
+            XDG_CONFIG_HOME: fixture.configDir,
+          },
+        },
+      )
+      child.stdin.end('do the task')
+      const [exitCode, stdout] = await Promise.all([
+        childExitCode(child),
+        readStream(child.stdout),
+      ])
+      return { events: parseEvents(stdout), exitCode }
+    }
+
+    const withTimeout = await runFast(['--timeout', '60'])
+    const without = await runFast([])
+
+    expect(withTimeout.exitCode).toBe(0)
+    expect(without.exitCode).toBe(0)
+    expect(withTimeout.events).toEqual(without.events)
+  }, 20_000)
 })
 
 function asRecord(value: unknown) {
@@ -1520,6 +1698,30 @@ emit({
   return fixture
 }
 
+function createFakeSigtermTrap() {
+  // Like the sleeper but ignores SIGTERM, forcing the SIGKILL grace escalation.
+  return createFakeHarness(
+    'codex',
+    `const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n')
+process.on('SIGTERM', () => {})
+emit({ type: 'thread.started', thread_id: 'thread-timeout' })
+emit({ type: 'fake.args', args: process.argv.slice(2), pid: process.pid })
+setInterval(() => {}, 1000)`,
+  )
+}
+
+function createFakeSleeper() {
+  // Emits its args (with pid) then hangs forever — used to prove the --timeout
+  // deadline terminates a lane that would otherwise never exit.
+  return createFakeHarness(
+    'codex',
+    `const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n')
+emit({ type: 'thread.started', thread_id: 'thread-timeout' })
+emit({ type: 'fake.args', args: process.argv.slice(2), pid: process.pid })
+setInterval(() => {}, 1000)`,
+  )
+}
+
 function parseEvents(stdout: string) {
   return stdout
     .trim()
@@ -1575,3 +1777,13 @@ async function startGatewayStub() {
     },
   }
 }
+
+function timeoutFakePid(events: Record<string, unknown>[]) {
+  for (const event of events) {
+    const inner = asRecord(event.event)
+    if (inner?.type === 'fake.args' && typeof inner.pid === 'number') {
+      return inner.pid
+    }
+  }
+  return undefined
+}
diff --git a/src/headless-run.ts b/src/headless-run.ts
index 76acfe8..6a00ea0 100644
--- a/src/headless-run.ts
+++ b/src/headless-run.ts
@@ -15,6 +15,7 @@ import { buildLaunchPlan } from './harnesses.js'
 import { EFFORT_LEVELS } from './types.js'
 
 const PROTOCOL_VERSION = 1
+const TIMEOUT_KILL_GRACE_MS = 10_000
 const PROMPT_STDIN_HELP =
   "eh run expects a prompt on stdin; pipe one in, for example: printf 'fix the parser' | eh run codex ollama qwen3-coder"
 const recordSchema = z.record(z.string(), z.unknown())
@@ -27,6 +28,7 @@ export interface HeadlessRunOptions {
   nativeArgsJson?: string
   provider: string
   resumeSessionId?: string
+  timeout?: string
 }
 
 interface NormalizerState {
@@ -43,6 +45,7 @@ interface ResolvedHeadlessRunOptions {
   nativeArgs: string[]
   provider: string
   resumeSessionId: string | undefined
+  timeoutSeconds: number | undefined
 }
 
 export async function runHeadless(options: HeadlessRunOptions) {
@@ -65,6 +68,7 @@ export async function runHeadless(options: HeadlessRunOptions) {
           : parseNativeArgsJson(options.nativeArgsJson),
       provider: options.provider,
       resumeSessionId: options.resumeSessionId,
+      timeoutSeconds: parseTimeoutSeconds(options.timeout),
     }
     const config = loadConfig()
     const provider = getProvider(config, resolved.provider)
@@ -102,6 +106,7 @@ export async function runHeadless(options: HeadlessRunOptions) {
           harness: resolved.harness,
           plan: prepared.plan,
           stdin: prepared.stdin,
+          timeoutSeconds: resolved.timeoutSeconds,
         })
       })
     })
@@ -189,6 +194,7 @@ async function executeHeadlessPlan(options: {
   harness: string
   plan: LaunchPlan
   stdin?: string
+  timeoutSeconds?: number
 }) {
   return withGatewayRouting(options.plan, async (plan) =>
     executePreparedHeadlessPlan({ ...options, plan }),
@@ -199,6 +205,7 @@ async function executePreparedHeadlessPlan(options: {
   harness: string
   plan: LaunchPlan
   stdin?: string
+  timeoutSeconds?: number
 }) {
   const child = spawn(options.plan.bin, options.plan.args, {
     env: { ...process.env, ...options.plan.env },
@@ -225,11 +232,37 @@ async function executePreparedHeadlessPlan(options: {
     return { handler, signal }
   })
 
+  // Held in an object so the deferred callback's mutation is visible to the
+  // read below — a plain `let` boolean would be narrowed to its initial value.
+  const timeout = { fired: false }
+  let timeoutTimer: ReturnType<typeof setTimeout> | undefined
+  let killTimer: ReturnType<typeof setTimeout> | undefined
+
   try {
     child.stderr.pipe(process.stderr)
     child.stdin.on('error', () => undefined)
     child.stdin.end(options.stdin)
 
+    if (options.timeoutSeconds !== undefined) {
+      timeoutTimer = setTimeout(() => {
+        // Only act while the child is still running; if it already finished, the
+        // timer is a no-op and the normal completion path reports the real exit.
+        if (child.exitCode === null && child.signalCode === null) {
+          timeout.fired = true
+          emit({
+            message: `${options.harness} exceeded the --timeout limit of ${options.timeoutSeconds}s`,
+            type: 'run.error',
+          })
+          child.kill('SIGTERM')
+          killTimer = setTimeout(() => {
+            if (child.exitCode === null && child.signalCode === null) {
+              child.kill('SIGKILL')
+            }
+          }, timeoutKillGraceMs())
+        }
+      }, options.timeoutSeconds * 1000)
+    }
+
     let state: NormalizerState = {
       pendingGrokText: '',
       resultIsError: false,
@@ -259,7 +292,7 @@ async function executePreparedHeadlessPlan(options: {
       : undefined
     const childExitCode =
       completed.code ?? (signalNumber ? 128 + signalNumber : 1)
-    if (!state.resultIsError && childExitCode !== 0) {
+    if (!state.resultIsError && childExitCode !== 0 && !timeout.fired) {
       emit({
         message: completed.signal
           ? `${options.harness} exited with signal ${completed.signal}`
@@ -272,6 +305,8 @@ async function executePreparedHeadlessPlan(options: {
     emit({ exitCode, resultIsError, type: 'run.completed' })
     return exitCode
   } finally {
+    if (timeoutTimer) clearTimeout(timeoutTimer)
+    if (killTimer) clearTimeout(killTimer)
     for (const { handler, signal } of signalHandlers) {
       process.off(signal, handler)
     }
@@ -546,6 +581,17 @@ function parseNativeArgsJson(value: string) {
   return parsed.data
 }
 
+function parseTimeoutSeconds(value: string | undefined) {
+  if (value === undefined) return undefined
+  const seconds = Number(value)
+  if (!Number.isInteger(seconds) || seconds <= 0) {
+    throw new Error(
+      `--timeout must be a positive integer number of seconds (got "${value}")`,
+    )
+  }
+  return seconds
+}
+
 async function prepareHeadlessPlan(options: {
   options: ResolvedHeadlessRunOptions
   plan: LaunchPlan
@@ -657,3 +703,12 @@ function readPrompt() {
   if (!prompt.trim()) throw new Error(PROMPT_STDIN_HELP)
   return prompt
 }
+
+// The grace period between SIGTERM and SIGKILL. Overridable via the env var so
+// the escalation test doesn't have to sleep the full 10 real seconds.
+function timeoutKillGraceMs() {
+  const raw = process.env.EH_TIMEOUT_KILL_GRACE_MS
+  if (raw === undefined) return TIMEOUT_KILL_GRACE_MS
+  const parsed = Number(raw)
+  return Number.isFinite(parsed) && parsed >= 0 ? parsed : TIMEOUT_KILL_GRACE_MS
+}
diff --git a/src/main.ts b/src/main.ts
index 1f77095..f1c9d11 100644
--- a/src/main.ts
+++ b/src/main.ts
@@ -137,6 +137,10 @@ program
     'pin OpenRouter or Vercel AI Gateway to one upstream provider',
   )
   .option('--resume-session <id>', 'resume an existing native session')
+  .option(
+    '--timeout <seconds>',
+    'fail the run if the harness runs longer than <seconds> (SIGTERM, then SIGKILL after a grace period)',
+  )
   .action(async (harness, provider, model, opts) => {
     process.exitCode = await runHeadless({
       effort: opts.reasoningEffort,
@@ -149,6 +153,7 @@ program
       nativeArgsJson: opts.nativeArgsJson,
       provider,
       resumeSessionId: opts.resumeSession,
+      timeout: opts.timeout,
     })
   })
```
