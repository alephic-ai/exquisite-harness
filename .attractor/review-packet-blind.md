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
index 7ab2607..e68e018 100644
--- a/DESIGN.md
+++ b/DESIGN.md
@@ -89,12 +89,14 @@ events inside a versioned NDJSON envelope, and emits normalized session, text,
 usage, and completion events. It does not open UI, write recents, or install the
 Claude statusline. The caller owns cwd, scratch/config roots, process timeouts,
 and lifecycle policy; `eh` owns provider wiring and harness protocol parsing.
-Callers can preserve harness-specific policy with a validated JSON string array
-of native arguments, which `eh` prepends before its mandatory machine-mode
-arguments. The five native adapters are Claude `stream-json`, Codex `--json`,
-Grok `streaming-json`, pi `--mode json`, and opencode `run --format json`; pi
-and opencode keep prompt input on stdin and expose their native session IDs,
-text, usage, cost, and semantic errors through the same normalized contract.
+`--cwd <dir>` lets the caller set the spawned child's working directory,
+validated to be an existing directory before spawn. Callers can preserve
+harness-specific policy with a validated JSON string array of native arguments,
+which `eh` prepends before its mandatory machine-mode arguments. The five native
+adapters are Claude `stream-json`, Codex `--json`, Grok `streaming-json`, pi
+`--mode json`, and opencode `run --format json`; pi and opencode keep prompt
+input on stdin and expose their native session IDs, text, usage, cost, and
+semantic errors through the same normalized contract.
 
 **Phase 2 (later): local router.** An opt-in localhost proxy that receives
 Anthropic Messages / OpenAI requests and fulfills them via the Vercel AI SDK
diff --git a/README.md b/README.md
index 723bdc3..32ab894 100644
--- a/README.md
+++ b/README.md
@@ -170,11 +170,13 @@ statusline. Claude, Codex, pi, and opencode receive the prompt over stdin; pi
 runs with `--mode json`, and opencode uses `run --format json`. Grok receives a
 private temporary prompt file because its headless CLI exposes `--prompt-file`;
 `eh` removes that file after the child exits. Native session resume is available
-for all five harnesses with `--resume-session <id>`. Orchestrators that must
-preserve harness-specific policy flags can pass a JSON string array with
-`--native-args-json`; those args are prepended before `eh`'s required
-machine-output flags. OpenRouter and Vercel AI Gateway runs through Claude,
-Codex, Grok, opencode, or pi may also use `--gateway-provider <slug>`.
+for all five harnesses with `--resume-session <id>`. Pass `--cwd <dir>` to run
+the spawned harness child in `<dir>`; a missing or non-directory value fails
+before launch. Orchestrators that must preserve harness-specific policy flags
+can pass a JSON string array with `--native-args-json`; those args are prepended
+before `eh`'s required machine-output flags. OpenRouter and Vercel AI Gateway
+runs through Claude, Codex, Grok, opencode, or pi may also use
+`--gateway-provider <slug>`.
 
 ### Keys
 
diff --git a/docs/qa/eh-cli.md b/docs/qa/eh-cli.md
index 8468b22..16d9c49 100644
--- a/docs/qa/eh-cli.md
+++ b/docs/qa/eh-cli.md
@@ -327,6 +327,20 @@ Drive each with the PTY; assert on screen text.
    and with the real native error event shape. → each emits one `run.error`, a
    failed `run.completed`, and a non-zero `eh` exit while preserving native
    stderr separately.
+5. Confirm `--cwd` controls the spawned child's working directory. Step 1's
+   automated suite runs a fake codex under `--cwd <scratch>` and asserts the
+   child reports that directory as its cwd, plus preflight failures for a
+   nonexistent path and a file-not-directory path (each emits only `run.error` +
+   failed `run.completed` on stdout, exits non-zero, and never spawns the
+   child). For a live check with a real provider and key:
+
+   ```bash
+   printf 'run pwd and print it' |
+     eh run claude vercel-ai-gateway <model> --cwd /tmp
+   ```
+
+   → the harness runs in `/tmp`; a nonexistent `--cwd` exits non-zero with a
+   `run.error` before any `harness.event`.
 
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
index def570f..245328d 100644
--- a/src/gateway-routing.test.ts
+++ b/src/gateway-routing.test.ts
@@ -428,6 +428,11 @@ describe('gateway provider routing', () => {
       )
     })
 
+    // Keep this hermetic: the auth resolver also falls back to
+    // process.env[apiKeyEnvKey], so blank the ambient key to force the plan
+    // ANTHROPIC_AUTH_TOKEN fall-through regardless of the shell environment.
+    const priorApiKey = process.env.ANTHROPIC_API_KEY
+    delete process.env.ANTHROPIC_API_KEY
     try {
       await withGatewayRouting(
         {
@@ -450,6 +455,11 @@ describe('gateway provider routing', () => {
       )
       expect(validationAuthorization).toBe('Bearer qa-auth-token')
     } finally {
+      if (priorApiKey === undefined) {
+        delete process.env.ANTHROPIC_API_KEY
+      } else {
+        process.env.ANTHROPIC_API_KEY = priorApiKey
+      }
       await upstream.close()
     }
   })
diff --git a/src/headless-run.test.ts b/src/headless-run.test.ts
index 63965f6..da5a0f6 100644
--- a/src/headless-run.test.ts
+++ b/src/headless-run.test.ts
@@ -7,6 +7,7 @@ import {
   existsSync,
   mkdirSync,
   mkdtempSync,
+  realpathSync,
   rmSync,
   writeFileSync,
 } from 'node:fs'
@@ -127,6 +128,164 @@ describe('eh run', () => {
     expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
   })
 
+  test('runs the spawned harness in the --cwd directory', async () => {
+    const fixture = createFakeCodex()
+    const scratch = mkdtempSync(path.join(tmpdir(), 'eh-cwd-test-'))
+    tempDirs.push(scratch)
+    const child = spawn(
+      process.execPath,
+      [
+        'run',
+        'src/main.ts',
+        'run',
+        'codex',
+        'ollama',
+        'qwen3-coder',
+        '--cwd',
+        scratch,
+      ],
+      {
+        cwd: repoRoot,
+        env: {
+          ...process.env,
+          PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ''}`,
+          XDG_CONFIG_HOME: fixture.configDir,
+        },
+      },
+    )
+    child.stdin.end('fix the parser')
+
+    const [exitCode, stderr, stdout] = await Promise.all([
+      childExitCode(child),
+      readStream(child.stderr),
+      readStream(child.stdout),
+    ])
+
+    expect(stderr).toBe('')
+    expect(exitCode).toBe(0)
+
+    const argsEvent = parseEvents(stdout)
+      .map((event) =>
+        z
+          .object({
+            event: z.object({
+              cwd: z.string(),
+              type: z.literal('fake.args'),
+            }),
+            type: z.literal('harness.event'),
+          })
+          .safeParse(event),
+      )
+      .find((result) => result.success)
+    const childCwd = argsEvent?.data.event.cwd
+    // /tmp is a symlink on macOS, so compare resolved real paths.
+    expect(childCwd && realpathSync(childCwd)).toBe(realpathSync(scratch))
+  })
+
+  test('fails preflight when --cwd does not exist, without spawning the child', async () => {
+    const fixture = createFakeCodex()
+    const scratch = mkdtempSync(path.join(tmpdir(), 'eh-cwd-test-'))
+    tempDirs.push(scratch)
+    const missing = path.join(scratch, 'does-not-exist')
+    const child = spawn(
+      process.execPath,
+      [
+        'run',
+        'src/main.ts',
+        'run',
+        'codex',
+        'ollama',
+        'qwen3-coder',
+        '--cwd',
+        missing,
+      ],
+      {
+        cwd: repoRoot,
+        env: {
+          ...process.env,
+          PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ''}`,
+          XDG_CONFIG_HOME: fixture.configDir,
+        },
+      },
+    )
+    child.stdin.end('fix the parser')
+
+    const [exitCode, stderr, stdout] = await Promise.all([
+      childExitCode(child),
+      readStream(child.stderr),
+      readStream(child.stdout),
+    ])
+
+    expect(stderr).toBe('')
+    expect(exitCode).toBe(1)
+    // Exactly these two events prove the child never spawned (no fake.args).
+    expect(parseEvents(stdout)).toEqual([
+      {
+        message: expect.stringContaining(missing),
+        type: 'run.error',
+        v: 1,
+      },
+      {
+        exitCode: 1,
+        resultIsError: true,
+        type: 'run.completed',
+        v: 1,
+      },
+    ])
+  })
+
+  test('fails preflight when --cwd is a file, without spawning the child', async () => {
+    const fixture = createFakeCodex()
+    const scratch = mkdtempSync(path.join(tmpdir(), 'eh-cwd-test-'))
+    tempDirs.push(scratch)
+    const file = path.join(scratch, 'a-file')
+    writeFileSync(file, 'not a directory')
+    const child = spawn(
+      process.execPath,
+      [
+        'run',
+        'src/main.ts',
+        'run',
+        'codex',
+        'ollama',
+        'qwen3-coder',
+        '--cwd',
+        file,
+      ],
+      {
+        cwd: repoRoot,
+        env: {
+          ...process.env,
+          PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ''}`,
+          XDG_CONFIG_HOME: fixture.configDir,
+        },
+      },
+    )
+    child.stdin.end('fix the parser')
+
+    const [exitCode, stderr, stdout] = await Promise.all([
+      childExitCode(child),
+      readStream(child.stderr),
+      readStream(child.stdout),
+    ])
+
+    expect(stderr).toBe('')
+    expect(exitCode).toBe(1)
+    expect(parseEvents(stdout)).toEqual([
+      {
+        message: expect.stringContaining(file),
+        type: 'run.error',
+        v: 1,
+      },
+      {
+        exitCode: 1,
+        resultIsError: true,
+        type: 'run.completed',
+        v: 1,
+      },
+    ])
+  })
+
   test('applies the global approval default to headless runs', async () => {
     const fixture = createFakeCodex()
     const ehConfigDir = path.join(fixture.configDir, 'eh')
@@ -1316,7 +1475,7 @@ for await (const chunk of process.stdin) chunks.push(chunk)
 const prompt = Buffer.concat(chunks).toString('utf8')
 const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n')
 emit({ type: 'thread.started', thread_id: 'thread-123' })
-emit({ type: 'fake.args', args: process.argv.slice(2) })
+emit({ type: 'fake.args', args: process.argv.slice(2), cwd: process.cwd() })
 if (process.env.EH_TEST_CODEX_EXIT_CODE) {
   process.stderr.write('native failure\\n')
   process.exit(Number(process.env.EH_TEST_CODEX_EXIT_CODE))
diff --git a/src/headless-run.ts b/src/headless-run.ts
index 76acfe8..9f15ea6 100644
--- a/src/headless-run.ts
+++ b/src/headless-run.ts
@@ -1,5 +1,5 @@
 import { spawn } from 'node:child_process'
-import { readFileSync } from 'node:fs'
+import { readFileSync, statSync } from 'node:fs'
 import { mkdtemp, rm, writeFile } from 'node:fs/promises'
 import os from 'node:os'
 import path from 'node:path'
@@ -20,6 +20,7 @@ const PROMPT_STDIN_HELP =
 const recordSchema = z.record(z.string(), z.unknown())
 
 export interface HeadlessRunOptions {
+  cwd?: string
   effort: string
   gatewayProvider?: string
   harness: string
@@ -36,6 +37,7 @@ interface NormalizerState {
 }
 
 interface ResolvedHeadlessRunOptions {
+  cwd: string | undefined
   effort: EffortLevel
   gatewayProvider: string | undefined
   harness: string
@@ -55,6 +57,7 @@ export async function runHeadless(options: HeadlessRunOptions) {
       )
     }
     const resolved: ResolvedHeadlessRunOptions = {
+      cwd: options.cwd,
       effort,
       gatewayProvider: options.gatewayProvider,
       harness: options.harness,
@@ -66,6 +69,7 @@ export async function runHeadless(options: HeadlessRunOptions) {
       provider: options.provider,
       resumeSessionId: options.resumeSessionId,
     }
+    if (resolved.cwd !== undefined) assertRunnableCwd(resolved.cwd)
     const config = loadConfig()
     const provider = getProvider(config, resolved.provider)
     if (!provider) throw new Error(`unknown provider "${resolved.provider}"`)
@@ -99,6 +103,7 @@ export async function runHeadless(options: HeadlessRunOptions) {
         })
 
         return executeHeadlessPlan({
+          cwd: resolved.cwd,
           harness: resolved.harness,
           plan: prepared.plan,
           stdin: prepared.stdin,
@@ -117,6 +122,18 @@ function asRecord(value: unknown) {
   return parsed.success ? parsed.data : undefined
 }
 
+function assertRunnableCwd(cwd: string) {
+  let stats
+  try {
+    stats = statSync(cwd)
+  } catch {
+    throw new Error(`--cwd "${cwd}" does not exist`)
+  }
+  if (!stats.isDirectory()) {
+    throw new Error(`--cwd "${cwd}" is not a directory`)
+  }
+}
+
 function emit(event: Record<string, unknown>) {
   process.stdout.write(`${JSON.stringify({ ...event, v: PROTOCOL_VERSION })}\n`)
 }
@@ -186,6 +203,7 @@ function errorMessage(error: unknown) {
 }
 
 async function executeHeadlessPlan(options: {
+  cwd?: string
   harness: string
   plan: LaunchPlan
   stdin?: string
@@ -196,11 +214,13 @@ async function executeHeadlessPlan(options: {
 }
 
 async function executePreparedHeadlessPlan(options: {
+  cwd?: string
   harness: string
   plan: LaunchPlan
   stdin?: string
 }) {
   const child = spawn(options.plan.bin, options.plan.args, {
+    cwd: options.cwd,
     env: { ...process.env, ...options.plan.env },
     stdio: ['pipe', 'pipe', 'pipe'],
   })
diff --git a/src/main.ts b/src/main.ts
index 1f77095..fafca20 100644
--- a/src/main.ts
+++ b/src/main.ts
@@ -137,8 +137,10 @@ program
     'pin OpenRouter or Vercel AI Gateway to one upstream provider',
   )
   .option('--resume-session <id>', 'resume an existing native session')
+  .option('--cwd <dir>', 'run the spawned harness in this working directory')
   .action(async (harness, provider, model, opts) => {
     process.exitCode = await runHeadless({
+      cwd: opts.cwd,
       effort: opts.reasoningEffort,
       // The root command exposes the same option for interactive launches.
       // Commander assigns an option after a subcommand to the root when both
```
