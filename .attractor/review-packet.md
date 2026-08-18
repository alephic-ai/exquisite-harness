# Review Context Packet

## Acceptance criteria (review basis)

Ticket AI-3109: eh run: reserved exit codes for eh-detected failure categories

- AC1: eh-detected categories exit with distinct documented codes from one reserved contiguous block at >=64 (exact numbers implementer's choice, recorded in the README table): at minimum spawn failure (binary missing/unspawnable), semantic harness failure (resultIsError with child exit 0), and preflight/usage errors (TTY or empty stdin, invalid flag values). Clean completion remains 0. Proof: extend the existing missing-binary / semantic-failure / preflight subprocess tests to assert the reserved codes.
- AC2: Invariant: a raw child exit code is never remapped when eh has no category for the failure — the existing nonzero-passthrough and 128 + signal behaviors are unchanged, and run.completed.exitCode continues to carry the raw child code (its field semantics do not change).
- AC3: README gains an "Exit codes" table (mirrored in DESIGN.md's headless section) documenting the reserved block, the passthrough rule, and the caveat that a harness's own code may numerically collide with the reserved block only in the passthrough case.

Changed files in review scope (vs `origin/main`, pipeline artifacts filtered out):

- DESIGN.md
- README.md
- docs/qa/eh-cli.md
- package.json
- src/gateway-routing.test.ts
- src/headless-run.test.ts
- src/headless-run.ts

## Unified diff

```diff
diff --git a/DESIGN.md b/DESIGN.md
index 7ab2607..1a49e8f 100644
--- a/DESIGN.md
+++ b/DESIGN.md
@@ -94,7 +94,13 @@ of native arguments, which `eh` prepends before its mandatory machine-mode
 arguments. The five native adapters are Claude `stream-json`, Codex `--json`,
 Grok `streaming-json`, pi `--mode json`, and opencode `run --format json`; pi
 and opencode keep prompt input on stdin and expose their native session IDs,
-text, usage, cost, and semantic errors through the same normalized contract.
+text, usage, cost, and semantic errors through the same normalized contract. For
+failures `eh` detects itself it reserves a contiguous exit-code block at `>=64`:
+`64` (preflight/usage error — nothing spawned), `65` (spawn failure — binary
+missing/unspawnable), and `66` (semantic harness failure — `resultIsError` while
+the child exited `0`). Every other code is the raw child exit code passed
+through unchanged (including `128 + signal`), so a harness's own code can
+collide with the reserved block only in that passthrough case.
 
 **Phase 2 (later): local router.** An opt-in localhost proxy that receives
 Anthropic Messages / OpenAI requests and fulfills them via the Vercel AI SDK
diff --git a/README.md b/README.md
index 723bdc3..05e651d 100644
--- a/README.md
+++ b/README.md
@@ -165,6 +165,25 @@ preserved as `harness.output`. Harness stderr remains stderr. A semantically
 failed native result makes both `run.completed.exitCode` and the `eh` process
 exit code non-zero, even when the child process exits zero.
 
+#### Exit codes
+
+`eh` owns a small reserved block of exit codes for failures it detects itself;
+any other code is the harness's own, passed through unchanged.
+
+| Exit code | Meaning                                                                                                      |
+| --------- | ------------------------------------------------------------------------------------------------------------ |
+| `0`       | Clean completion                                                                                             |
+| `64`      | Preflight/usage error — TTY, empty stdin, invalid flag values, unknown harness/provider; nothing was spawned |
+| `65`      | Spawn failure — the harness binary is missing or otherwise unspawnable                                       |
+| `66`      | Semantic harness failure — `resultIsError` while the child process exited `0`                                |
+| any other | Raw child exit code, passed through unchanged (including `128 + signal` for a signalled child)               |
+
+`run.completed.exitCode` always equals the `eh` process exit code and, in the
+passthrough case, carries the raw child code. Because raw codes pass through
+untouched, a harness's own exit code may numerically collide with this reserved
+block only in the passthrough case; classify from the `run.error` event when the
+distinction matters.
+
 The fully specified command never opens UI, updates recents, or installs a
 statusline. Claude, Codex, pi, and opencode receive the prompt over stdin; pi
 runs with `--mode json`, and opencode uses `run --format json`. Grok receives a
diff --git a/docs/qa/eh-cli.md b/docs/qa/eh-cli.md
index 8468b22..929115f 100644
--- a/docs/qa/eh-cli.md
+++ b/docs/qa/eh-cli.md
@@ -293,10 +293,12 @@ Drive each with the PTY; assert on screen text.
    prompt stays off argv, native policy args precede mandatory machine-mode
    args, `--resume-session` reaches the native CLI, session/text/usage/cost are
    normalized, and a native semantic error makes both completion and process
-   exits non-zero even if the fake child exits 0. Preflight cases cover empty
-   stdin, malformed native args, invalid effort, unknown harness/provider, pi
-   provider incompatibility, and missing keys; each must emit only versioned
-   `run.error` + failed `run.completed` records on stdout and exit non-zero.
+   exits `66` even if the fake child exits 0. Preflight cases cover empty stdin,
+   malformed native args, invalid effort, unknown harness/provider, pi provider
+   incompatibility, and missing keys; each must emit only versioned
+   `run.error` + failed `run.completed` records on stdout and exit `64`. A raw
+   nonzero child exit code still passes through unchanged (including
+   `128 + signal`).
 2. With Ollama running and a pulled model declared for the `ollama` provider in
    pi's `models.json`, run a short real pi request (replace `<model>`):
 
@@ -324,9 +326,10 @@ Drive each with the PTY; assert on screen text.
    events remain available as `harness.event`; stderr contains no TUI.
 
 4. Repeat the pi and opencode fake-binary cases with a nonexistent child binary
-   and with the real native error event shape. → each emits one `run.error`, a
-   failed `run.completed`, and a non-zero `eh` exit while preserving native
-   stderr separately.
+   and with the real native error event shape. → the nonexistent-binary case
+   exits `65` (spawn failure) and the native-error case exits `66` (semantic
+   harness failure); each emits one `run.error`, a failed `run.completed`, and
+   preserves native stderr separately.
 
 ## Known limitations
 
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
index def570f..be1cfaa 100644
--- a/src/gateway-routing.test.ts
+++ b/src/gateway-routing.test.ts
@@ -417,6 +417,10 @@ describe('gateway provider routing', () => {
   })
 
   test('uses a non-empty auth token when the provider key variable is deliberately blank', async () => {
+    // CI/sandbox may export ANTHROPIC_API_KEY; the plan's blank value must win,
+    // so clear the ambient var to keep this test hermetic against it.
+    const priorApiKey = process.env.ANTHROPIC_API_KEY
+    delete process.env.ANTHROPIC_API_KEY
     let validationAuthorization = ''
     const upstream = await startUpstream((request, response) => {
       validationAuthorization = request.headers.authorization ?? ''
@@ -451,6 +455,8 @@ describe('gateway provider routing', () => {
       expect(validationAuthorization).toBe('Bearer qa-auth-token')
     } finally {
       await upstream.close()
+      if (priorApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
+      else process.env.ANTHROPIC_API_KEY = priorApiKey
     }
   })
 
diff --git a/src/headless-run.test.ts b/src/headless-run.test.ts
index 63965f6..533c7a9 100644
--- a/src/headless-run.test.ts
+++ b/src/headless-run.test.ts
@@ -202,7 +202,7 @@ describe('eh run', () => {
     const events = parseEvents(stdout)
 
     expect(stderr).toBe('')
-    expect(exitCode).toBe(1)
+    expect(exitCode).toBe(65)
     expect(events).toHaveLength(3)
     expect(events[0]).toEqual({
       effort: 'auto',
@@ -218,7 +218,7 @@ describe('eh run', () => {
       v: 1,
     })
     expect(events[2]).toEqual({
-      exitCode: 1,
+      exitCode: 65,
       resultIsError: true,
       type: 'run.completed',
       v: 1,
@@ -358,7 +358,7 @@ describe('eh run', () => {
       ])
 
       expect(stderr).toBe('')
-      expect(exitCode).toBe(1)
+      expect(exitCode).toBe(64)
       expect(parseEvents(stdout)).toEqual([
         {
           message: expect.stringContaining(
@@ -370,7 +370,7 @@ describe('eh run', () => {
           v: 1,
         },
         {
-          exitCode: 1,
+          exitCode: 64,
           resultIsError: true,
           type: 'run.completed',
           v: 1,
@@ -1045,14 +1045,14 @@ describe('eh run', () => {
       ])
       const events = parseEvents(stdout)
 
-      expect(exitCode).toBe(1)
+      expect(exitCode).toBe(66)
       expect(events).toContainEqual({
         message: `expected ${harness} failure`,
         type: 'run.error',
         v: 1,
       })
       expect(events).toContainEqual({
-        exitCode: 1,
+        exitCode: 66,
         resultIsError: true,
         type: 'run.completed',
         v: 1,
@@ -1124,14 +1124,14 @@ describe('eh run', () => {
       .split('\n')
       .map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)))
 
-    expect(exitCode).toBe(1)
+    expect(exitCode).toBe(66)
     expect(events).toContainEqual({
       message: 'expected failure',
       type: 'run.error',
       v: 1,
     })
     expect(events).toContainEqual({
-      exitCode: 1,
+      exitCode: 66,
       resultIsError: true,
       type: 'run.completed',
       v: 1,
diff --git a/src/headless-run.ts b/src/headless-run.ts
index 76acfe8..2603c5c 100644
--- a/src/headless-run.ts
+++ b/src/headless-run.ts
@@ -15,6 +15,13 @@ import { buildLaunchPlan } from './harnesses.js'
 import { EFFORT_LEVELS } from './types.js'
 
 const PROTOCOL_VERSION = 1
+// Reserved eh exit codes for eh-detected failure categories — a contiguous
+// block at >=64 (sysexits.h's EX_ range). Raw child codes pass through
+// unchanged when eh has no category, so a harness's own code may only collide
+// with this block in the passthrough case. Documented in README's "Exit codes".
+const EH_EXIT_PREFLIGHT = 64
+const EH_EXIT_SPAWN = 65
+const EH_EXIT_HARNESS_ERROR = 66
 const PROMPT_STDIN_HELP =
   "eh run expects a prompt on stdin; pipe one in, for example: printf 'fix the parser' | eh run codex ollama qwen3-coder"
 const recordSchema = z.record(z.string(), z.unknown())
@@ -107,8 +114,12 @@ export async function runHeadless(options: HeadlessRunOptions) {
     })
   } catch (error) {
     emit({ message: errorMessage(error), type: 'run.error' })
-    emit({ exitCode: 1, resultIsError: true, type: 'run.completed' })
-    return 1
+    emit({
+      exitCode: EH_EXIT_PREFLIGHT,
+      resultIsError: true,
+      type: 'run.completed',
+    })
+    return EH_EXIT_PREFLIGHT
   }
 }
 
@@ -251,8 +262,12 @@ async function executePreparedHeadlessPlan(options: {
           completed.error.message || `Failed to spawn "${options.plan.bin}"`,
         type: 'run.error',
       })
-      emit({ exitCode: 1, resultIsError: true, type: 'run.completed' })
-      return 1
+      emit({
+        exitCode: EH_EXIT_SPAWN,
+        resultIsError: true,
+        type: 'run.completed',
+      })
+      return EH_EXIT_SPAWN
     }
     const signalNumber = completed.signal
       ? os.constants.signals[completed.signal]
@@ -268,7 +283,10 @@ async function executePreparedHeadlessPlan(options: {
       })
     }
     const resultIsError = state.resultIsError || childExitCode !== 0
-    const exitCode = resultIsError && childExitCode === 0 ? 1 : childExitCode
+    const exitCode =
+      resultIsError && childExitCode === 0
+        ? EH_EXIT_HARNESS_ERROR
+        : childExitCode
     emit({ exitCode, resultIsError, type: 'run.completed' })
     return exitCode
   } finally {
```
