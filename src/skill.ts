import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const skillPath = path.resolve(
  import.meta.dirname,
  '../skills/eh-delegate/SKILL.md',
)

export function delegationSkill() {
  try {
    return readFileSync(skillPath, 'utf8')
  } catch {
    return EMBEDDED_SKILL
  }
}

export function installSkill(directory: string, force = false) {
  const destination = path.join(directory, 'SKILL.md')
  assertNoSymlinkPath(destination)
  const stat = lstatSync(destination, { throwIfNoEntry: false })
  if (stat) {
    const existing = readFileSync(destination, 'utf8')
    if (existing === delegationSkill()) return
    if (!force) {
      throw new Error(
        `refusing to overwrite differing skill at ${destination}; use --force`,
      )
    }
  }
  mkdirSync(directory, { recursive: true })
  writeFileSync(destination, delegationSkill(), 'utf8')
}

export function printSkill() {
  process.stdout.write(delegationSkill())
}

const EMBEDDED_SKILL = `---
name: eh-delegate
description: Delegate a focused task to another configured agent through eh.
---

# Delegate with eh

Use \`eh ask\` when a task is well-scoped and another configured harness should
handle it. Keep the delegated prompt self-contained: include the goal, relevant
context, constraints, and the expected output. Do not include API keys or other
secrets.

\`\`\`bash
printf '%s' "$TASK" | eh ask <harness> <provider> <model>
\`\`\`

\`eh ask\` is a one-shot, non-interactive command. It reads the prompt from stdin
and emits versioned NDJSON on stdout; stderr belongs to the harness. Read
\`assistant.text\` events for the response, and treat \`run.error\` or a non-zero
\`run.completed.exitCode\` as failure. Preserve the complete event stream when
debugging rather than assuming every harness produces the same native events.

Use explicit target arguments so delegation is reproducible. Set a reasonable
external timeout, and avoid asking the delegated agent to delegate again unless
your orchestration policy explicitly permits recursion. Summarize the result for
the caller and distinguish the delegated agent's claims from your own
verification.

Useful options include \`--reasoning-effort\`, \`--gateway-provider\`,
\`--native-args-json\`, and \`--resume-session\`.
`

function assertNoSymlinkPath(target: string) {
  const absolute = path.resolve(target)
  const { root } = path.parse(absolute)
  let current = root
  for (const part of absolute.slice(root.length).split(path.sep)) {
    if (!part) continue
    current = path.join(current, part)
    const stat = lstatSync(current, { throwIfNoEntry: false })
    if (stat?.isSymbolicLink()) {
      throw new Error(`refusing to install through symlink at ${current}`)
    }
    if (!stat) break
  }
}
