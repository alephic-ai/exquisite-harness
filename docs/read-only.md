# Read-only mapping and `--read-only` design decision (AI-3110)

Spike output for [AI-3110](https://linear.app/alephic/issue/AI-3110), the
specification for the `--read-only` implementation
([AI-3111](https://linear.app/alephic/issue/AI-3111)). Verified 2026-08-18
against the installed harness CLIs on macOS; versions pinned in the table.

## Verification method

Each mechanism was probed live, not read from docs: a scratch directory
containing a `marker.txt` with a nonce; the harness was asked (cheap model) to
**read `marker.txt` and reply with its content, then create `pwned.txt`**. Pass
= the reply contains the nonce (reads survive) and `pwned.txt` does not exist
afterward (writes blocked). Baselines first proved each harness _does_ write the
file when unrestricted, so an absent file means blocked, not incapable. Probes
ran through `eh run` where possible (real combined-arg path); grok's solo-flag
probe used a temporarily neutral `defaultApprovalMode` and codex was probed via
its native CLI because the eh codex harness is currently broken (see
Environmental findings). OpenCode follow-up probes (2026-08-18, native
`opencode run --format json`, model `opencode/deepseek-v4-flash-free`) covered
`--agent plan` with and without `--auto`, plus `OPENCODE_PERMISSION` denying
`edit` and `bash`. One trial per cell — this verifies the mechanism exists and
behaves as labeled, it is not an exhaustive bypass audit.

## Per-harness mapping table

| Harness  | Version | Mechanism        | Exact args                  | Blocks                                                                                                                                                                                                                                                                 | Reads survive | Baseline wrote                | Restricted blocked |
| -------- | ------- | ---------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------- | ------------------ |
| claude   | 2.1.234 | permission mode  | `--permission-mode plan`    | file writes/edits via tool permission layer (not an OS sandbox; network not probed)                                                                                                                                                                                    | yes           | yes                           | yes                |
| codex    | 0.147.0 | OS-level sandbox | `--sandbox read-only`       | model-generated shell commands incl. file writes (OS-enforced; strongest of the five)                                                                                                                                                                                  | yes           | yes (with `--approve-for-me`) | yes                |
| grok     | 1.0.5   | permission mode  | `--permission-mode plan`    | file writes/edits via tool permission layer (its separate `--sandbox <PROFILE>` flag covers "filesystem and network" but documents no enum; unprobed)                                                                                                                  | yes           | yes                           | yes                |
| opencode | 1.18.18 | permission agent | `--agent plan`              | file writes/edits via the plan agent's permission layer (`edit * deny`; plan-file exceptions only). `--auto` still cannot create `pwned.txt`. Not an OS sandbox; `bash` remains listed as a tool but an explicit shell-write request was refused and no file appeared. | yes           | yes (with `--auto`)           | yes                |
| pi       | 0.84.2  | tool allowlist   | `--tools read,grep,find,ls` | all mutating tools (`write`, `edit`, `bash`) by omission; pi's own help labels this "Read-only mode (no file modifications possible)"                                                                                                                                  | yes           | yes                           | yes                |

## The collision findings (why the shape decision matters)

`defaultApprovalMode: auto` already injects per-harness auto-approve args
(`approval-mode.ts`). Read-only args **cannot simply be appended** alongside
them:

- **grok** hard-errors:
  `the argument '--permission-mode <MODE>' cannot be used multiple times`
  (exit 2) when `--permission-mode auto` (approval) and `--permission-mode plan`
  (read-only) are both present.
- **codex** hard-errors:
  `the argument '--approve-for-me' cannot be used with '--sandbox <SANDBOX_MODE>'`
  (exit 2).
- **claude** silently accepts repetition with last-wins semantics (the appended
  `plan` beat the earlier `auto` in the probe) — it works by accident of arg
  order and is not a contract worth relying on.
- **opencode** does **not** collide: `--agent plan` plus `--auto` ran to
  completion and still blocked `pwned.txt`. Approval args stay when read-only is
  set.

## Decision

1. **Shape: `--read-only` is a boolean on `eh run`, orthogonal to
   `ApprovalMode`.** `APPROVAL_MODES` is not extended — auto-approval and
   write-restriction are independent axes (a lane can be unattended _and_
   read-only; that combination is exactly the reviewer-lane use case).
2. **One resolution point owns both axes.** Because the native flags collide on
   two of five harnesses, read-only cannot be a second independent arg-appender
   next to `approvalArgsForHarness`. Implementation replaces the per-axis
   appenders with a single permission-posture resolution — a pure function of
   `(approvalMode, readOnly)` per harness, structured like `approval-mode.ts`
   (switch + `unreachable` exhaustiveness guard). When `readOnly` is set it
   takes precedence and the approval-mode args are suppressed, emitting exactly:
   - claude → `--permission-mode plan` (suppress `--permission-mode auto`; do
     not rely on last-wins)
   - grok → `--permission-mode plan` (suppress `--permission-mode auto`)
   - codex → `--sandbox read-only` (suppress `--approve-for-me`)
   - pi → `--tools read,grep,find,ls` (pi has no approval args to suppress)
   - opencode → `--agent plan` (keep `--auto` when approval is auto — the two
     flags compose; `--auto` does not override plan's `edit * deny`)
3. **No mechanism = refuse to launch.** That default still applies to any future
   harness with no restriction lever. OpenCode is no longer in that set:
   `--agent plan` blocked `pwned.txt` with and without `--auto`, and blocked an
   explicit "use a shell command" write request. Omitting `--auto` alone is
   **not** a mechanism (the original baseline still wrote). A second lever,
   `OPENCODE_PERMISSION='{"edit":"deny","bash":"deny"}'`, also blocked writes
   under `--auto`; implementation should prefer the CLI flag (`--agent plan`) to
   match the other harnesses. Invariant: **a lane started with `--read-only` is
   never silently unrestricted.**
4. **Contract of the flag: best-available write-restriction, per harness.** The
   five mechanisms are heterogeneous — codex is an OS sandbox; claude, grok,
   opencode, and pi are tool-permission-layer restrictions; network access is
   not uniformly restricted. The flag promises "the harness's own strongest
   file-write restriction is engaged", documented per harness in this table — it
   does not promise a uniform full sandbox.

## Environmental findings (not spike-blocking, worth fixing separately)

- **The eh codex harness is currently broken on both gateways**: codex 0.147.0
  rejects the generated provider config with
  ``Error loading config.toml: `wire_api = "chat"` is no longer supported``
  (fix: `wire_api = "responses"`), and the Vercel AI Gateway models listing
  fails codex's parser (`missing field 'models'`). Codex rows above were
  verified via the native CLI (`codex exec`, ChatGPT auth).
- codex refuses to run in untrusted non-git directories without
  `--skip-git-repo-check`; orchestrator lanes run in git worktrees, so this only
  affects ad-hoc scratch-dir runs.
