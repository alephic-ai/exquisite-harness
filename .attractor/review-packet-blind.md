# Review Context Packet

Changed files in review scope (vs `origin/main`, pipeline artifacts filtered out):

- DESIGN.md
- README.md
- docs/qa/eh-cli.md
- package.json
- src/harnesses.ts
- src/headless-run.test.ts
- src/headless-run.ts
- src/main.ts
- src/permission-posture.test.ts
- src/permission-posture.ts

## Unified diff

```diff
diff --git a/DESIGN.md b/DESIGN.md
index 642009f..86902fb 100644
--- a/DESIGN.md
+++ b/DESIGN.md
@@ -316,6 +316,13 @@ and Grok `--permission-mode auto`, Codex `--approve-for-me`, and opencode
 adds no argument. The mapping never uses unrestricted bypass flags, and native
 availability/errors remain owned by the selected harness.
 
+`eh run --read-only` resolves together with approval mode in
+`permission-posture.ts` — one point owns both axes because the native flags
+collide on Codex and Grok. Read-only wins and the approval-mode argument is
+suppressed, except opencode, whose `--agent plan` composes with `--auto`. A
+harness with no read-only mechanism hits an exhaustiveness guard and refuses to
+launch rather than run silently unrestricted (`docs/read-only.md`).
+
 For an OpenRouter or Vercel AI Gateway selection, `--gateway-provider <slug>`
 adds a process-scoped loopback proxy to Claude, Codex, Grok, opencode, and pi
 launch plans. The proxy preserves the harness's native Anthropic Messages,
@@ -490,6 +497,7 @@ src/main.ts       entry: commander wiring
 src/flow.ts       positional/profile resolution → pickers → launch
 src/headless-run.ts  non-interactive harness execution + NDJSON normalization
 src/approval-mode.ts  approval labels + per-harness native argument mapping
+src/permission-posture.ts  read-only + approval resolution (one point, both axes)
 src/config.ts     schema, load/save, recents, profiles, XDG paths
 src/providers.ts  provider types: protocols, model listing, status checks
 src/pricing.ts    provider rates/ranges ($/1M) and fallback cost estimates
diff --git a/README.md b/README.md
index 23a84d3..4c52c11 100644
--- a/README.md
+++ b/README.md
@@ -202,6 +202,16 @@ then escalates to `SIGKILL` after a 10s grace period; `run.completed` is still
 the final event and a timed-out child exits `143`. Omitting the flag keeps
 today's no-deadline behavior.
 
+Pass `--read-only` to engage each harness's strongest own file-write
+restriction: Claude and Grok `--permission-mode plan`, Codex
+`--sandbox read-only` (its OS sandbox), opencode `--agent plan`, and pi
+`--tools read,grep,find,ls`. It composes with an `auto` approval default and
+takes precedence where the two would collide — read-only wins and the approval
+argument is dropped, except opencode, where `--agent plan` and `--auto` run
+together. This is the best available restriction per harness, not a uniform
+sandbox: network access, for one, is not uniformly restricted. See
+`docs/read-only.md` for the per-harness mapping and its verification.
+
 ### Keys
 
 ```bash
diff --git a/docs/qa/eh-cli.md b/docs/qa/eh-cli.md
index ebe1e4b..6c6885d 100644
--- a/docs/qa/eh-cli.md
+++ b/docs/qa/eh-cli.md
@@ -100,6 +100,14 @@ Each prints env/args and exits 0 without launching, unless noted.
     `--print-env` is intentionally unsupported with its isolated temp home.
     Change the config value to `platform` and repeat the same commands. → none
     of those approval arguments is present.
+18. For each harness whose CLI is installed, from inside a scratch directory run
+    `printf 'create a file named proof.txt with the text hi' | eh run <harness> <provider> <model> --read-only`
+    and confirm no `proof.txt` is written — the harness reports it cannot modify
+    files (Claude/Grok plan mode, Codex's read-only sandbox, opencode's plan
+    agent, pi's read-only tool set). The exact args each harness receives are
+    pinned by automated subprocess tests (`src/headless-run.test.ts`); this item
+    checks the live write-blocking behavior those tests cannot, per
+    `docs/read-only.md`.
 
 ## C. Config / error paths
 
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
diff --git a/src/harnesses.ts b/src/harnesses.ts
index c9641d3..ddf1d8a 100644
--- a/src/harnesses.ts
+++ b/src/harnesses.ts
@@ -4,9 +4,9 @@ import path from 'node:path'
 
 import type { ResolvedProvider } from './config.js'
 
-import { approvalArgsForHarness } from './approval-mode.js'
 import { prepareGrokApiKeyHome } from './grok-home.js'
 import { opencodeConfigContent, opencodeProviderId } from './opencode.js'
+import { permissionArgsForHarness } from './permission-posture.js'
 import { piModelsJsonHint, piProviderCompat, resolvePiProvider } from './pi.js'
 import { fetchModelMeta } from './pricing.js'
 import {
@@ -60,6 +60,7 @@ interface HarnessPlanOptions {
   effort?: string
   gatewayProvider?: string
   gatewayZdr?: boolean
+  readOnly?: boolean
   statusline?: boolean
 }
 
@@ -136,7 +137,12 @@ async function planClaude(
     notes.push('context window unknown — falling back to Claude context size')
   }
   const args = statusline ? ['--settings', writeClaudeStatuslineSettings()] : []
-  args.push(...approvalArgsForHarness('claude', options.approvalMode))
+  args.push(
+    ...permissionArgsForHarness('claude', {
+      approvalMode: options.approvalMode,
+      readOnly: options.readOnly ?? false,
+    }),
+  )
   return {
     args,
     bin: 'claude',
@@ -195,7 +201,12 @@ async function planCodex(
   if (effort && effort !== 'auto') {
     args.push('-c', `model_reasoning_effort=${tomlString(effort)}`)
   }
-  args.push(...approvalArgsForHarness('codex', options.approvalMode))
+  args.push(
+    ...permissionArgsForHarness('codex', {
+      approvalMode: options.approvalMode,
+      readOnly: options.readOnly ?? false,
+    }),
+  )
   return {
     args,
     bin: 'codex',
@@ -223,7 +234,12 @@ async function planGrok(
   if (effort && effort !== 'auto') {
     args.push('--reasoning-effort', effort)
   }
-  args.push(...approvalArgsForHarness('grok', options.approvalMode))
+  args.push(
+    ...permissionArgsForHarness('grok', {
+      approvalMode: options.approvalMode,
+      readOnly: options.readOnly ?? false,
+    }),
+  )
   const gatewayRouting = gatewayRoutingFor(
     provider,
     options.gatewayProvider,
@@ -283,7 +299,12 @@ async function planPi(
   const args = ['--provider', match.piName, '--model', model]
   // pi's thinking levels are eh's effort levels (auto = send nothing).
   if (effort && effort !== 'auto') args.push('--thinking', effort)
-  args.push(...approvalArgsForHarness('pi', options.approvalMode))
+  args.push(
+    ...permissionArgsForHarness('pi', {
+      approvalMode: options.approvalMode,
+      readOnly: options.readOnly ?? false,
+    }),
+  )
   const gatewayRouting = gatewayRoutingFor(
     provider,
     options.gatewayProvider,
@@ -343,7 +364,12 @@ async function planOpencode(
     env[provider.envKey] = await authTokenFor(provider)
   }
   const args = ['-m', `${opencodeProviderId(provider)}/${model}`]
-  args.push(...approvalArgsForHarness('opencode', options.approvalMode))
+  args.push(
+    ...permissionArgsForHarness('opencode', {
+      approvalMode: options.approvalMode,
+      readOnly: options.readOnly ?? false,
+    }),
+  )
   return {
     args,
     bin: 'opencode',
@@ -477,6 +503,7 @@ export async function buildLaunchPlan(
     effort?: string
     gatewayProvider?: string
     gatewayZdr?: boolean
+    readOnly?: boolean
     resume?: boolean
     resumeSessionId?: string
     searchBackend?: SearchBackend
@@ -490,6 +517,7 @@ export async function buildLaunchPlan(
     effort: options.effort,
     gatewayProvider: options.gatewayProvider,
     gatewayZdr: options.gatewayZdr,
+    readOnly: options.readOnly,
     statusline: options.statusline,
   })
   const plan = {
diff --git a/src/headless-run.test.ts b/src/headless-run.test.ts
index 95e87c7..2ab78e5 100644
--- a/src/headless-run.test.ts
+++ b/src/headless-run.test.ts
@@ -332,6 +332,180 @@ describe('eh run', () => {
     expect(argsEvent?.data.event.args).toContain('--approve-for-me')
   })
 
+  // Each --read-only lane must carry that harness's own write restriction all
+  // the way to the spawned argv (docs/read-only.md). Harness-specific env vars
+  // (GROK_*, PI_CODING_AGENT_DIR) are inert for the other harnesses, so one env
+  // block covers every case.
+  const READ_ONLY_CASES = [
+    ['claude', createFakeClaude, ['--permission-mode', 'plan'], []],
+    ['grok', createFakeGrok, ['--permission-mode', 'plan'], []],
+    ['codex', createFakeCodex, ['--sandbox', 'read-only'], []],
+    ['opencode', createFakeOpencode, ['--agent', 'plan'], ['--auto']],
+    ['pi', createFakePi, ['--tools', 'read,grep,find,ls'], []],
+  ] as const
+
+  test.each(READ_ONLY_CASES)(
+    'engages %s read-only args under platform approval',
+    async (harness, createFixture, expected, absent) => {
+      const fixture = createFixture()
+      const child = spawn(
+        process.execPath,
+        [
+          'run',
+          'src/main.ts',
+          'run',
+          harness,
+          'ollama',
+          'qwen3-coder',
+          '--read-only',
+        ],
+        {
+          cwd: repoRoot,
+          env: {
+            ...process.env,
+            GROK_API_KEY: 'parent-grok-api-key',
+            GROK_BASE_URL: 'parent-grok-base-url',
+            GROK_MODELS_BASE_URL: 'parent-grok-models-base-url',
+            PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ''}`,
+            PI_CODING_AGENT_DIR: fixture.configDir,
+            XAI_API_KEY: 'parent-xai-api-key',
+            XDG_CONFIG_HOME: fixture.configDir,
+          },
+        },
+      )
+      child.stdin.end('inspect only')
+
+      const [exitCode, stdout] = await Promise.all([
+        childExitCode(child),
+        readStream(child.stdout),
+        readStream(child.stderr),
+      ])
+      const args = fakeArgs(stdout)
+
+      expect(exitCode).toBe(0)
+      for (const token of expected) expect(args).toContain(token)
+      // Never silently unrestricted, and never a blanket bypass.
+      expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
+      expect(args).not.toContain('--dangerously-skip-permissions')
+      for (const token of absent) expect(args).not.toContain(token)
+    },
+  )
+
+  test('read-only suppresses codex approval args under an auto default', async () => {
+    const fixture = createFakeCodex()
+    writeAutoApprovalConfig(fixture.configDir)
+    const child = spawn(
+      process.execPath,
+      [
+        'run',
+        'src/main.ts',
+        'run',
+        'codex',
+        'ollama',
+        'qwen3-coder',
+        '--read-only',
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
+    child.stdin.end('inspect only')
+
+    const [exitCode, stdout] = await Promise.all([
+      childExitCode(child),
+      readStream(child.stdout),
+      readStream(child.stderr),
+    ])
+    const args = fakeArgs(stdout)
+
+    expect(exitCode).toBe(0)
+    expect(args).toContain('--sandbox')
+    expect(args).toContain('read-only')
+    expect(args).not.toContain('--approve-for-me')
+  })
+
+  test('read-only composes with the opencode auto default', async () => {
+    const fixture = createFakeOpencode()
+    writeAutoApprovalConfig(fixture.configDir)
+    const child = spawn(
+      process.execPath,
+      [
+        'run',
+        'src/main.ts',
+        'run',
+        'opencode',
+        'ollama',
+        'qwen3-coder',
+        '--read-only',
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
+    child.stdin.end('inspect only')
+
+    const [exitCode, stdout] = await Promise.all([
+      childExitCode(child),
+      readStream(child.stdout),
+      readStream(child.stderr),
+    ])
+    const args = fakeArgs(stdout)
+
+    expect(exitCode).toBe(0)
+    expect(args).toContain('--agent')
+    expect(args).toContain('plan')
+    expect(args).toContain('--auto')
+  })
+
+  test('read-only suppresses claude approval args under an auto default', async () => {
+    const fixture = createFakeClaude()
+    writeAutoApprovalConfig(fixture.configDir)
+    const child = spawn(
+      process.execPath,
+      [
+        'run',
+        'src/main.ts',
+        'run',
+        'claude',
+        'ollama',
+        'qwen3-coder',
+        '--read-only',
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
+    child.stdin.end('inspect only')
+
+    const [exitCode, stdout] = await Promise.all([
+      childExitCode(child),
+      readStream(child.stdout),
+      readStream(child.stderr),
+    ])
+    const args = fakeArgs(stdout)
+
+    expect(exitCode).toBe(0)
+    expect(args).toContain('--permission-mode')
+    expect(args).toContain('plan')
+    // The auto default would add `--permission-mode auto`; read-only suppresses it.
+    expect(args).not.toContain('auto')
+  })
+
   test('normalizes a missing harness binary as a failed run', async () => {
     const root = mkdtempSync(path.join(tmpdir(), 'eh-headless-test-'))
     tempDirs.push(root)
@@ -1975,6 +2149,25 @@ function parseEvents(stdout: string) {
     .map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)))
 }
 
+// The fake harnesses echo their own argv as a `fake.args` event; pull it back
+// out so a test can assert what `eh` actually passed to the spawned process.
+function fakeArgs(stdout: string) {
+  const argsEvent = parseEvents(stdout)
+    .map((event) =>
+      z
+        .object({
+          event: z.object({
+            args: z.array(z.string()),
+            type: z.literal('fake.args'),
+          }),
+          type: z.literal('harness.event'),
+        })
+        .safeParse(event),
+    )
+    .find((result) => result.success)
+  return argsEvent?.data.event.args ?? []
+}
+
 async function readStream(stream: Readable) {
   const chunks: Buffer[] = []
   for await (const chunk of stream) {
@@ -2033,3 +2226,12 @@ function timeoutFakePid(events: Record<string, unknown>[]) {
   }
   return undefined
 }
+
+function writeAutoApprovalConfig(configDir: string) {
+  const ehConfigDir = path.join(configDir, 'eh')
+  mkdirSync(ehConfigDir, { recursive: true })
+  writeFileSync(
+    path.join(ehConfigDir, 'config.json'),
+    JSON.stringify({ defaultApprovalMode: 'auto', version: 1 }),
+  )
+}
diff --git a/src/headless-run.ts b/src/headless-run.ts
index fda6af3..085c757 100644
--- a/src/headless-run.ts
+++ b/src/headless-run.ts
@@ -40,6 +40,7 @@ export interface HeadlessRunOptions {
   model: string
   nativeArgsJson?: string
   provider: string
+  readOnly?: boolean
   resumeSessionId?: string
   timeout?: string
 }
@@ -58,6 +59,7 @@ interface ResolvedHeadlessRunOptions {
   model: string
   nativeArgs: string[]
   provider: string
+  readOnly: boolean
   resumeSessionId: string | undefined
   timeoutSeconds: number | undefined
 }
@@ -86,6 +88,7 @@ export async function runHeadless(options: HeadlessRunOptions) {
           ? []
           : parseNativeArgsJson(options.nativeArgsJson),
       provider: options.provider,
+      readOnly: options.readOnly ?? false,
       resumeSessionId: options.resumeSessionId,
       timeoutSeconds: parseTimeoutSeconds(options.timeout),
     }
@@ -109,6 +112,7 @@ export async function runHeadless(options: HeadlessRunOptions) {
         approvalMode: config.defaultApprovalMode,
         effort: resolved.effort,
         gatewayProvider: resolved.gatewayProvider,
+        readOnly: resolved.readOnly,
         statusline: false,
       },
     )
diff --git a/src/main.ts b/src/main.ts
index 181c21f..679f1ba 100644
--- a/src/main.ts
+++ b/src/main.ts
@@ -142,6 +142,10 @@ program
     '--timeout <seconds>',
     'fail the run if the harness runs longer than <seconds> (SIGTERM, then SIGKILL after a grace period)',
   )
+  .option(
+    '--read-only',
+    "restrict the harness to its strongest read-only / no-write mode (see docs/read-only.md); composes with an 'auto' approval default",
+  )
   .action(async (harness, provider, model, opts) => {
     process.exitCode = await runHeadless({
       cwd: opts.cwd,
@@ -154,6 +158,7 @@ program
       model,
       nativeArgsJson: opts.nativeArgsJson,
       provider,
+      readOnly: opts.readOnly,
       resumeSessionId: opts.resumeSession,
       timeout: opts.timeout,
     })
diff --git a/src/permission-posture.test.ts b/src/permission-posture.test.ts
new file mode 100644
index 0000000..d5c7262
--- /dev/null
+++ b/src/permission-posture.test.ts
@@ -0,0 +1,99 @@
+import { describe, expect, test } from 'bun:test'
+
+import { permissionArgsForHarness } from './permission-posture.js'
+
+const PERMISSION_HARNESSES = [
+  ['claude'],
+  ['codex'],
+  ['grok'],
+  ['opencode'],
+  ['pi'],
+] as const
+
+describe('permissionArgsForHarness', () => {
+  test.each([
+    ['claude', ['--permission-mode', 'plan']],
+    ['grok', ['--permission-mode', 'plan']],
+    ['codex', ['--sandbox', 'read-only']],
+    ['pi', ['--tools', 'read,grep,find,ls']],
+    ['opencode', ['--agent', 'plan']],
+  ] as const)(
+    'maps read-only to %s native arguments (platform approval)',
+    (harness, expected) => {
+      expect(
+        permissionArgsForHarness(harness, {
+          approvalMode: 'platform',
+          readOnly: true,
+        }),
+      ).toEqual([...expected])
+    },
+  )
+
+  test('read-only suppresses colliding approval args (claude, codex)', () => {
+    expect(
+      permissionArgsForHarness('claude', {
+        approvalMode: 'auto',
+        readOnly: true,
+      }),
+    ).toEqual(['--permission-mode', 'plan'])
+    expect(
+      permissionArgsForHarness('codex', {
+        approvalMode: 'auto',
+        readOnly: true,
+      }),
+    ).toEqual(['--sandbox', 'read-only'])
+  })
+
+  test('opencode read-only composes with the auto approval default', () => {
+    expect(
+      permissionArgsForHarness('opencode', {
+        approvalMode: 'auto',
+        readOnly: true,
+      }),
+    ).toEqual(['--agent', 'plan', '--auto'])
+  })
+
+  test.each(PERMISSION_HARNESSES)(
+    'never leaves %s silently unrestricted under read-only',
+    (harness) => {
+      expect(
+        permissionArgsForHarness(harness, {
+          approvalMode: 'platform',
+          readOnly: true,
+        }).length,
+      ).toBeGreaterThan(0)
+    },
+  )
+
+  test('refuses to launch a read-only lane for a harness with no mechanism', () => {
+    expect(() =>
+      permissionArgsForHarness(
+        // @ts-expect-error a harness outside the union exercises the refuse-to-launch guard
+        'futureharness',
+        { approvalMode: undefined, readOnly: true },
+      ),
+    ).toThrow(/no read-only mechanism/)
+  })
+
+  test('never maps read-only to an unrestricted bypass', () => {
+    const args = PERMISSION_HARNESSES.flatMap(([harness]) =>
+      permissionArgsForHarness(harness, {
+        approvalMode: 'auto',
+        readOnly: true,
+      }),
+    )
+
+    expect(args).not.toContain('--dangerously-skip-permissions')
+    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
+    expect(args).not.toContain('--always-approve')
+  })
+
+  test('delegates to approval mapping when not read-only', () => {
+    expect(
+      permissionArgsForHarness('codex', {
+        approvalMode: 'auto',
+        readOnly: false,
+      }),
+    ).toEqual(['--approve-for-me'])
+  })
+})
diff --git a/src/permission-posture.ts b/src/permission-posture.ts
new file mode 100644
index 0000000..47bde21
--- /dev/null
+++ b/src/permission-posture.ts
@@ -0,0 +1,53 @@
+import type { ApprovalMode } from './types.js'
+
+import { approvalArgsForHarness } from './approval-mode.js'
+
+type PermissionHarness = 'claude' | 'codex' | 'grok' | 'opencode' | 'pi'
+
+// One resolution point owns both permission axes (approval + write-restriction).
+// Native flags collide on two of five harnesses (docs/read-only.md "The
+// collision findings"), so read-only cannot be a second independent
+// arg-appender next to approvalArgsForHarness: when readOnly is set it takes
+// precedence and the approval-mode args are suppressed — except opencode, whose
+// --agent plan composes with --auto.
+export function permissionArgsForHarness(
+  harness: PermissionHarness,
+  options: { approvalMode: ApprovalMode | undefined; readOnly: boolean },
+) {
+  if (!options.readOnly) {
+    return approvalArgsForHarness(harness, options.approvalMode)
+  }
+  return readOnlyArgs(harness, options.approvalMode)
+}
+
+// Each harness's strongest own write restriction, per docs/read-only.md
+// "Decision". A harness with no mechanism hits the unreachable guard so the lane
+// refuses to launch rather than run silently unrestricted.
+function readOnlyArgs(
+  harness: PermissionHarness,
+  approvalMode: ApprovalMode | undefined,
+) {
+  switch (harness) {
+    case 'claude':
+    case 'grok':
+      return ['--permission-mode', 'plan']
+    case 'codex':
+      return ['--sandbox', 'read-only']
+    case 'opencode':
+      // --agent plan blocks writes; --auto composes and does not override it.
+      return [
+        '--agent',
+        'plan',
+        ...approvalArgsForHarness('opencode', approvalMode),
+      ]
+    case 'pi':
+      return ['--tools', 'read,grep,find,ls']
+  }
+  return unreachable(harness)
+}
+
+function unreachable(harness: never): never {
+  throw new Error(
+    `no read-only mechanism for harness "${String(harness)}"; refusing to launch a --read-only lane (docs/read-only.md)`,
+  )
+}
```
