# Review Context Packet

## Acceptance criteria (review basis)

Ticket AI-3108: eh run: add --result-file <path> and document the terminal-event guarantee

- AC1: `eh run` accepts `--result-file <path>`. After the run, the file contains exactly the run's final result text: the harness-native terminal result string for harnesses that define one, else all `assistant.text` content concatenated in stream order. The file is always created — empty when the run produced no result text (including error runs). Proof: subprocess tests per fake harness comparing file bytes against the canned expected result, including one no-result error case.
- AC2: Invariant: `--result-file` changes nothing else — the NDJSON stream, exit code, and stderr are byte-identical with and without the flag (aside from the file write). Proof: subprocess test running the same fake-harness scenario twice, with and without the flag, asserting identical event streams and exit codes.
- AC3: README `### Headless runs` and DESIGN.md document `run.completed` as the guaranteed final NDJSON line, with a regression test asserting no event is ever emitted after it.

Changed files in review scope (vs `origin/main`, pipeline artifacts filtered out):

- DESIGN.md
- README.md
- docs/qa/eh-cli.md
- package.json
- src/headless-run.test.ts
- src/headless-run.ts
- src/main.ts

## Unified diff

```diff
diff --git a/DESIGN.md b/DESIGN.md
index 642009f..a972c28 100644
--- a/DESIGN.md
+++ b/DESIGN.md
@@ -105,7 +105,15 @@ spawned), `65` (spawn failure — binary missing/unspawnable), and `66` (semanti
 harness failure — `resultIsError` while the child exited `0`). Every other code
 is the raw child exit code passed through unchanged (including `128 + signal`),
 so a harness's own code can collide with the reserved block only in that
-passthrough case.
+passthrough case. `run.completed` is by construction the final NDJSON line: it
+is emitted exactly once per run, after stdout EOF and child close, and every
+completion path returns immediately after emitting it, so no event can follow —
+orchestrators treat it as the end-of-run marker. `--result-file <path>` writes
+the run's final result text — the harness-native terminal result string where a
+harness defines one (only Claude's `result` event does today), otherwise every
+`assistant.text` value joined in stream order — and always creates the file,
+empty for no-result or error runs. The write completes before `run.completed` is
+emitted, so the file is ready once that line appears.
 
 **Phase 2 (later): local router.** An opt-in localhost proxy that receives
 Anthropic Messages / OpenAI requests and fulfills them via the Vercel AI SDK
diff --git a/README.md b/README.md
index 23a84d3..2dd519e 100644
--- a/README.md
+++ b/README.md
@@ -166,6 +166,11 @@ preserved as `harness.output`. Harness stderr remains stderr. A semantically
 failed native result makes both `run.completed.exitCode` and the `eh` process
 exit code non-zero, even when the child process exits zero.
 
+`run.completed` is emitted exactly once and is always the last NDJSON line —
+every completion path (success, spawn failure, preflight/usage error, timeout)
+ends by emitting it, and nothing follows. Orchestrators can rely on it as the
+end-of-run signal.
+
 #### Exit codes
 
 `eh` owns a small reserved block of exit codes for failures it detects itself;
@@ -200,7 +205,12 @@ runs through Claude, Codex, Grok, opencode, or pi may also use
 loudly: on expiry `eh` emits a `run.error` naming the limit, sends `SIGTERM`,
 then escalates to `SIGKILL` after a 10s grace period; `run.completed` is still
 the final event and a timed-out child exits `143`. Omitting the flag keeps
-today's no-deadline behavior.
+today's no-deadline behavior. Pass `--result-file <path>` to capture the run's
+final result text: the harness-native terminal result string where the harness
+defines one (only Claude does today), otherwise every `assistant.text` value
+joined in stream order. The file is always created — empty when the run produced
+no result text, including error and preflight runs — and is written before
+`run.completed`, so a `run.completed` on stdout means the file is ready to read.
 
 ### Keys
 
diff --git a/docs/qa/eh-cli.md b/docs/qa/eh-cli.md
index ebe1e4b..f290b11 100644
--- a/docs/qa/eh-cli.md
+++ b/docs/qa/eh-cli.md
@@ -361,6 +361,17 @@ Drive each with the PTY; assert on screen text.
    → the harness runs in `/tmp`; a nonexistent `--cwd` exits `64` with a
    `run.error` before any `harness.event`.
 
+6. Step 1's automated suite also covers `--result-file`: a per-harness byte
+   comparison of the written file (Claude's native `result` string wins over its
+   assistant text; codex/grok/opencode/pi fall back to `assistant.text` joined
+   in stream order), multi-turn concat joined with `\n`, a no-result error run
+   that yields an empty file at exit `66`, and the with/without invariant
+   proving the flag leaves the NDJSON stream, exit code, and stderr
+   byte-identical. It also asserts `run.completed` is the final NDJSON line for
+   both a successful and a semantic-error run. For a live check, add
+   `--result-file /tmp/eh-result.txt` to the step 2 pi request and confirm the
+   file holds exactly the reply text.
+
 ## Known limitations
 
 - Interactive steps are driven by a PTY harness, not a human; rendering quirks
diff --git a/package.json b/package.json
index 9c008c3..be92b6c 100644
--- a/package.json
+++ b/package.json
@@ -1,6 +1,6 @@
 {
   "name": "exquisite-harness",
-  "version": "0.15.0",
+  "version": "0.16.0",
   "private": true,
   "description": "Choose a harness, choose a provider, go.",
   "type": "module",
diff --git a/src/headless-run.test.ts b/src/headless-run.test.ts
index 95e87c7..a296a34 100644
--- a/src/headless-run.test.ts
+++ b/src/headless-run.test.ts
@@ -7,6 +7,7 @@ import {
   existsSync,
   mkdirSync,
   mkdtempSync,
+  readFileSync,
   realpathSync,
   rmSync,
   writeFileSync,
@@ -1680,6 +1681,180 @@ describe('eh run', () => {
     expect(without.exitCode).toBe(0)
     expect(withTimeout.events).toEqual(without.events)
   }, 20_000)
+
+  describe('--result-file', () => {
+    const runWithResultFile = async (options: {
+      env?: Record<string, string>
+      fixture: { binDir: string; configDir: string }
+      harness: string
+      prompt: string
+    }) => {
+      const dir = mkdtempSync(path.join(tmpdir(), 'eh-result-file-'))
+      tempDirs.push(dir)
+      const resultPath = path.join(dir, 'result.txt')
+      const child = spawn(
+        process.execPath,
+        [
+          'run',
+          'src/main.ts',
+          'run',
+          options.harness,
+          'ollama',
+          'qwen3-coder',
+          '--result-file',
+          resultPath,
+        ],
+        {
+          cwd: repoRoot,
+          env: {
+            ...process.env,
+            ...options.env,
+            PATH: `${options.fixture.binDir}${path.delimiter}${process.env.PATH ?? ''}`,
+            PI_CODING_AGENT_DIR: options.fixture.configDir,
+            XDG_CONFIG_HOME: options.fixture.configDir,
+          },
+        },
+      )
+      child.stdin.end(options.prompt)
+      const [exitCode] = await Promise.all([
+        childExitCode(child),
+        readStream(child.stdout),
+        readStream(child.stderr),
+      ])
+      return { exitCode, resultPath }
+    }
+
+    test.each([
+      ['claude', createFakeClaude, 'claude-result: fix the parser'],
+      ['codex', createFakeCodex, 'saw: fix the parser'],
+      ['grok', createFakeGrok, 'saw: fix the parser'],
+      ['opencode', createFakeOpencode, 'saw: fix the parser'],
+      ['pi', createFakePi, 'saw: fix the parser'],
+    ] as const)(
+      'writes the final result text for %s',
+      async (harness, createFixture, expected) => {
+        const { exitCode, resultPath } = await runWithResultFile({
+          fixture: createFixture(),
+          harness,
+          prompt: 'fix the parser',
+        })
+
+        expect(exitCode).toBe(0)
+        expect(readFileSync(resultPath, 'utf8')).toBe(expected)
+      },
+    )
+
+    test('joins multi-turn assistant text in stream order with newlines', async () => {
+      const { exitCode, resultPath } = await runWithResultFile({
+        env: { EH_TEST_CODEX_MULTITURN: '1' },
+        fixture: createFakeCodex(),
+        harness: 'codex',
+        prompt: 'do the task',
+      })
+
+      expect(exitCode).toBe(0)
+      expect(readFileSync(resultPath, 'utf8')).toBe('part one\npart two')
+    })
+
+    test('creates an empty result file for a no-result error run', async () => {
+      const { exitCode, resultPath } = await runWithResultFile({
+        env: { EH_TEST_CODEX_FAIL: '1' },
+        fixture: createFakeCodex(),
+        harness: 'codex',
+        prompt: 'fail this run',
+      })
+
+      expect(exitCode).toBe(66)
+      expect(readFileSync(resultPath, 'utf8')).toBe('')
+    })
+
+    test('leaves the NDJSON stream, exit code, and stderr unchanged aside from the file write', async () => {
+      const runCodex = async (extraArgs: string[]) => {
+        const fixture = createFakeCodex()
+        const child = spawn(
+          process.execPath,
+          [
+            'run',
+            'src/main.ts',
+            'run',
+            'codex',
+            'ollama',
+            'qwen3-coder',
+            ...extraArgs,
+          ],
+          {
+            cwd: repoRoot,
+            env: {
+              ...process.env,
+              PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ''}`,
+              XDG_CONFIG_HOME: fixture.configDir,
+            },
+          },
+        )
+        child.stdin.end('do the task')
+        const [exitCode, stderr, stdout] = await Promise.all([
+          childExitCode(child),
+          readStream(child.stderr),
+          readStream(child.stdout),
+        ])
+        return { events: parseEvents(stdout), exitCode, stderr }
+      }
+
+      const dir = mkdtempSync(path.join(tmpdir(), 'eh-result-file-'))
+      tempDirs.push(dir)
+      const withFlag = await runCodex([
+        '--result-file',
+        path.join(dir, 'result.txt'),
+      ])
+      const without = await runCodex([])
+
+      expect(withFlag.exitCode).toBe(0)
+      expect(withFlag.events).toEqual(without.events)
+      expect(withFlag.exitCode).toBe(without.exitCode)
+      expect(withFlag.stderr).toBe(without.stderr)
+    })
+  })
+
+  test.each([
+    { env: {}, expectedExit: 0, name: 'a successful run' },
+    {
+      env: { EH_TEST_CODEX_FAIL: '1' },
+      expectedExit: 66,
+      name: 'a semantic-error run',
+    },
+  ])(
+    'emits run.completed as the final NDJSON line for $name',
+    async ({ env, expectedExit }) => {
+      const fixture = createFakeCodex()
+      const child = spawn(
+        process.execPath,
+        ['run', 'src/main.ts', 'run', 'codex', 'ollama', 'qwen3-coder'],
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
+      child.stdin.end('do the task')
+
+      const [exitCode, stdout] = await Promise.all([
+        childExitCode(child),
+        readStream(child.stdout),
+        readStream(child.stderr),
+      ])
+      const events = parseEvents(stdout)
+
+      expect(exitCode).toBe(expectedExit)
+      const completedIndex = events.findIndex(
+        (event) => event.type === 'run.completed',
+      )
+      expect(completedIndex).toBe(events.length - 1)
+    },
+  )
 })
 
 function asRecord(value: unknown) {
@@ -1720,6 +1895,7 @@ emit({
 })
 emit({
   type: 'result',
+  result: 'claude-result: ' + prompt,
   session_id: 'claude-session',
   total_cost_usd: 0.25,
   usage: {
@@ -1749,6 +1925,15 @@ if (process.env.EH_TEST_CODEX_FAIL === '1') {
   emit({ type: 'turn.failed', error: { message: 'expected failure' } })
   process.exit(0)
 }
+if (process.env.EH_TEST_CODEX_MULTITURN === '1') {
+  emit({ type: 'item.completed', item: { type: 'agent_message', text: 'part one' } })
+  emit({ type: 'item.completed', item: { type: 'agent_message', text: 'part two' } })
+  emit({
+    type: 'turn.completed',
+    usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 },
+  })
+  process.exit(0)
+}
 emit({
   type: 'item.completed',
   item: { type: 'agent_message', text: 'saw: ' + prompt },
diff --git a/src/headless-run.ts b/src/headless-run.ts
index fda6af3..e29b015 100644
--- a/src/headless-run.ts
+++ b/src/headless-run.ts
@@ -40,11 +40,14 @@ export interface HeadlessRunOptions {
   model: string
   nativeArgsJson?: string
   provider: string
+  resultFile?: string
   resumeSessionId?: string
   timeout?: string
 }
 
 interface NormalizerState {
+  assistantText: string
+  nativeResult: string | undefined
   pendingGrokText: string
   resultIsError: boolean
   sessionId: string | undefined
@@ -58,6 +61,7 @@ interface ResolvedHeadlessRunOptions {
   model: string
   nativeArgs: string[]
   provider: string
+  resultFile: string | undefined
   resumeSessionId: string | undefined
   timeoutSeconds: number | undefined
 }
@@ -86,6 +90,7 @@ export async function runHeadless(options: HeadlessRunOptions) {
           ? []
           : parseNativeArgsJson(options.nativeArgsJson),
       provider: options.provider,
+      resultFile: options.resultFile,
       resumeSessionId: options.resumeSessionId,
       timeoutSeconds: parseTimeoutSeconds(options.timeout),
     }
@@ -137,6 +142,7 @@ export async function runHeadless(options: HeadlessRunOptions) {
             state.executionStarted = true
           },
           plan: prepared.plan,
+          resultFile: resolved.resultFile,
           stdin: prepared.stdin,
           timeoutSeconds: resolved.timeoutSeconds,
         })
@@ -144,6 +150,7 @@ export async function runHeadless(options: HeadlessRunOptions) {
     })
   } catch (error) {
     if (state.executionStarted) throw error
+    await writeResultFile(options.resultFile, '')
     emit({ message: errorMessage(error), type: 'run.error' })
     emit({
       exitCode: EH_EXIT_PREFLIGHT,
@@ -175,6 +182,15 @@ function emit(event: Record<string, unknown>) {
   process.stdout.write(`${JSON.stringify({ ...event, v: PROTOCOL_VERSION })}\n`)
 }
 
+function emitAssistantText(text: string, state: NormalizerState) {
+  emit({ text, type: 'assistant.text' })
+  return {
+    ...state,
+    assistantText:
+      state.assistantText === '' ? text : `${state.assistantText}\n${text}`,
+  }
+}
+
 function emitGrokUsage(event: Record<string, unknown>, cumulative: boolean) {
   const usage = asRecord(event.usage)
   if (!usage) return
@@ -244,6 +260,7 @@ async function executeHeadlessPlan(options: {
   harness: string
   markSpawned: () => void
   plan: LaunchPlan
+  resultFile?: string
   stdin?: string
   timeoutSeconds?: number
 }) {
@@ -257,6 +274,7 @@ async function executePreparedHeadlessPlan(options: {
   harness: string
   markSpawned: () => void
   plan: LaunchPlan
+  resultFile?: string
   stdin?: string
   timeoutSeconds?: number
 }) {
@@ -319,6 +337,8 @@ async function executePreparedHeadlessPlan(options: {
     }
 
     let state: NormalizerState = {
+      assistantText: '',
+      nativeResult: undefined,
       pendingGrokText: '',
       resultIsError: false,
       sessionId: undefined,
@@ -331,6 +351,7 @@ async function executePreparedHeadlessPlan(options: {
       })
     }
     if (options.harness === 'grok') state = flushGrokText(state)
+    const resultText = state.nativeResult ?? state.assistantText
 
     const completed = await completion
     if ('error' in completed) {
@@ -339,6 +360,7 @@ async function executePreparedHeadlessPlan(options: {
           completed.error.message || `Failed to spawn "${options.plan.bin}"`,
         type: 'run.error',
       })
+      await writeResultFile(options.resultFile, resultText)
       emit({
         exitCode: EH_EXIT_SPAWN,
         resultIsError: true,
@@ -365,6 +387,7 @@ async function executePreparedHeadlessPlan(options: {
       resultIsError && childExitCode === 0
         ? EH_EXIT_HARNESS_ERROR
         : childExitCode
+    await writeResultFile(options.resultFile, resultText)
     emit({ exitCode, resultIsError, type: 'run.completed' })
     return exitCode
   } finally {
@@ -378,8 +401,10 @@ async function executePreparedHeadlessPlan(options: {
 
 function flushGrokText(state: NormalizerState) {
   if (!state.pendingGrokText) return state
-  emit({ text: state.pendingGrokText, type: 'assistant.text' })
-  return { ...state, pendingGrokText: '' }
+  return emitAssistantText(state.pendingGrokText, {
+    ...state,
+    pendingGrokText: '',
+  })
 }
 
 function isGrokTextDelta(
@@ -392,9 +417,9 @@ function normalizeClaudeEvent(
   event: Record<string, unknown>,
   state: NormalizerState,
 ) {
-  let sessionId = state.sessionId
+  let next = state
   if (event.type === 'system') {
-    sessionId = emitSession(event.session_id, sessionId)
+    next = { ...next, sessionId: emitSession(event.session_id, next.sessionId) }
   }
 
   if (event.type === 'assistant') {
@@ -403,14 +428,14 @@ function normalizeClaudeEvent(
       for (const rawBlock of message.content) {
         const block = asRecord(rawBlock)
         if (block?.type === 'text' && typeof block.text === 'string') {
-          emit({ text: block.text, type: 'assistant.text' })
+          next = emitAssistantText(block.text, next)
         }
       }
     }
   }
 
-  if (event.type !== 'result') return { ...state, sessionId }
-  sessionId = emitSession(event.session_id, sessionId)
+  if (event.type !== 'result') return next
+  next = { ...next, sessionId: emitSession(event.session_id, next.sessionId) }
   const usage = asRecord(event.usage)
   if (usage) {
     emitUsage({
@@ -427,9 +452,10 @@ function normalizeClaudeEvent(
     (typeof event.subtype === 'string' && event.subtype !== 'success')
   if (resultIsError) emitRunError(event, 'Claude reported a failed result')
   return {
-    ...state,
-    resultIsError: state.resultIsError || resultIsError,
-    sessionId,
+    ...next,
+    nativeResult:
+      typeof event.result === 'string' ? event.result : next.nativeResult,
+    resultIsError: next.resultIsError || resultIsError,
   }
 }
 
@@ -437,15 +463,15 @@ function normalizeCodexEvent(
   event: Record<string, unknown>,
   state: NormalizerState,
 ) {
-  const sessionId =
+  let next =
     event.type === 'thread.started'
-      ? emitSession(event.thread_id, state.sessionId)
-      : state.sessionId
+      ? { ...state, sessionId: emitSession(event.thread_id, state.sessionId) }
+      : state
 
   if (event.type === 'item.completed') {
     const item = asRecord(event.item)
     if (item?.type === 'agent_message' && typeof item.text === 'string') {
-      emit({ text: item.text, type: 'assistant.text' })
+      next = emitAssistantText(item.text, next)
     }
   }
 
@@ -467,10 +493,10 @@ function normalizeCodexEvent(
 
   if (event.type === 'turn.failed' || event.type === 'error') {
     emitRunError(event, 'Codex reported a failed turn')
-    return { ...state, resultIsError: true, sessionId }
+    return { ...next, resultIsError: true }
   }
 
-  return { ...state, sessionId }
+  return next
 }
 
 function normalizeGrokEvent(
@@ -546,7 +572,7 @@ function normalizeOpencodeEvent(
   event: Record<string, unknown>,
   state: NormalizerState,
 ) {
-  const nextState = emitNewSession(event.sessionID, state)
+  let next = emitNewSession(event.sessionID, state)
   const part = asRecord(event.part)
 
   if (
@@ -554,7 +580,7 @@ function normalizeOpencodeEvent(
     part?.type === 'text' &&
     typeof part.text === 'string'
   ) {
-    emit({ text: part.text, type: 'assistant.text' })
+    next = emitAssistantText(part.text, next)
   }
 
   if (event.type === 'step_finish' && part?.type === 'step-finish') {
@@ -574,25 +600,25 @@ function normalizeOpencodeEvent(
 
   if (event.type === 'error') {
     emitRunError(event, 'OpenCode reported an error')
-    return { ...nextState, resultIsError: true }
+    return { ...next, resultIsError: true }
   }
-  return nextState
+  return next
 }
 
 function normalizePiEvent(
   event: Record<string, unknown>,
   state: NormalizerState,
 ) {
-  const nextState = emitNewSession(event.id, state)
-  if (event.type !== 'message_end') return nextState
+  let next = emitNewSession(event.id, state)
+  if (event.type !== 'message_end') return next
 
   const message = asRecord(event.message)
-  if (message?.role !== 'assistant') return nextState
+  if (message?.role !== 'assistant') return next
   if (Array.isArray(message.content)) {
     for (const rawBlock of message.content) {
       const block = asRecord(rawBlock)
       if (block?.type === 'text' && typeof block.text === 'string') {
-        emit({ text: block.text, type: 'assistant.text' })
+        next = emitAssistantText(block.text, next)
       }
     }
   }
@@ -614,8 +640,8 @@ function normalizePiEvent(
     message.stopReason === 'error' || message.stopReason === 'aborted'
   if (resultIsError) emitRunError(message, 'Pi reported a failed result')
   return {
-    ...nextState,
-    resultIsError: nextState.resultIsError || resultIsError,
+    ...next,
+    resultIsError: next.resultIsError || resultIsError,
   }
 }
 
@@ -775,3 +801,8 @@ function timeoutKillGraceMs() {
   const parsed = Number(raw)
   return Number.isFinite(parsed) && parsed >= 0 ? parsed : TIMEOUT_KILL_GRACE_MS
 }
+
+async function writeResultFile(resultFile: string | undefined, text: string) {
+  if (resultFile === undefined) return
+  await writeFile(resultFile, text)
+}
diff --git a/src/main.ts b/src/main.ts
index 181c21f..3dffaff 100644
--- a/src/main.ts
+++ b/src/main.ts
@@ -142,6 +142,10 @@ program
     '--timeout <seconds>',
     'fail the run if the harness runs longer than <seconds> (SIGTERM, then SIGKILL after a grace period)',
   )
+  .option(
+    '--result-file <path>',
+    "write the run's final result text to <path> (created empty when the run produced no result)",
+  )
   .action(async (harness, provider, model, opts) => {
     process.exitCode = await runHeadless({
       cwd: opts.cwd,
@@ -154,6 +158,7 @@ program
       model,
       nativeArgsJson: opts.nativeArgsJson,
       provider,
+      resultFile: opts.resultFile,
       resumeSessionId: opts.resumeSession,
       timeout: opts.timeout,
     })
```
