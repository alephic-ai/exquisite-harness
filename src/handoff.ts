import {
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

import type { ConversationTurn, SessionInfo } from './sessions.js'

import pkg from '../package.json' with { type: 'json' }
import { configDir } from './config.js'
import { extractConversation } from './sessions.js'

// The doc lands in the target model's context via a file read; 128 KB ≈ 30k
// tokens — plenty of room for any realistic conversation without swamping it.
export const HANDOFF_DOC_CAP = 128 * 1024

// Handoff docs are disposable context, not an archive.
const MAX_HANDOFF_DOCS = 20

// Pure builder (clock and version are parameters) so tests can pin output.
export function buildHandoffDoc(args: {
  cwd: string
  exportedAt: string
  session: SessionInfo
  target: string
  turns: ConversationTurn[]
  version: string
}) {
  const header = docHeader(args)
  const blocks = args.turns.map(turnBlock)
  const headerBytes = bytes(header)
  // +1 per block covers the join('\n') separators in the emitted doc.
  const total = blocks.reduce((sum, b) => sum + bytes(b) + 1, headerBytes)
  if (total <= HANDOFF_DOC_CAP) {
    return { doc: header + blocks.join('\n'), omitted: 0 }
  }
  // Over cap: the original goal and the latest state matter most — keep the
  // first user turn and as many trailing turns as fit, mark the gap.
  const first = Math.max(
    0,
    args.turns.findIndex((t) => t.role === 'user'),
  )
  const goalBlock = fitBlock(blocks[first] ?? '', headerBytes)
  // Reserve marker room; the exact count lands after the suffix is known.
  const budget = HANDOFF_DOC_CAP - headerBytes - bytes(goalBlock) - 128
  const suffix: string[] = []
  let used = 0
  for (let i = blocks.length - 1; i > first && used < budget; i--) {
    const size = bytes(blocks[i]) + 1
    if (used + size > budget) break
    suffix.unshift(blocks[i])
    used += size
  }
  // Everything except the goal block and the kept suffix is omitted —
  // including any leading turns before the goal (assistant-first transcripts).
  const omitted = blocks.length - 1 - suffix.length
  const marker = `\n*… ${String(omitted)} earlier turn${omitted === 1 ? '' : 's'} omitted to fit 128 KB …*\n`
  return { doc: header + goalBlock + marker + suffix.join('\n'), omitted }
}

export function handoffsDir() {
  return path.join(configDir(), 'handoffs')
}

// The pointer becomes the new session's first user message — and therefore
// its title in `eh -r`, so the meaningful words lead.
export function pointerPrompt(args: { docPath: string; session: SessionInfo }) {
  const what = args.session.title || `(id ${args.session.id.slice(0, 8)})`
  return `Continuing a ${args.session.harness} session — "${what}". The full conversation is in ${args.docPath} — read it, then pick up where it left off.`
}

// Extract → build → write → prune. Throws when the source store yields no
// conversation (a corrupted or gutted transcript), so the user can fall back
// to a native resume instead of seeding an empty session. `dir` overrides
// the handoffs dir (tests; production uses handoffsDir()).
export async function writeHandoff(args: {
  cwd: string
  dir?: string
  session: SessionInfo
  target: string
}) {
  const turns = await extractConversation(args.session)
  if (turns.length === 0) {
    throw new Error(
      `couldn't extract any conversation from ${args.session.harness} — resume it natively instead`,
    )
  }
  const { dir, ...docArgs } = args
  const { doc, omitted } = buildHandoffDoc({
    ...docArgs,
    exportedAt: new Date().toISOString(),
    turns,
    version: pkg.version,
  })
  const outDir = dir ?? handoffsDir()
  mkdirSync(outDir, { recursive: true })
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-')
  const docPath = path.join(
    outDir,
    `${stamp}-${args.session.harness}-to-${args.target}-${args.session.id.slice(0, 8)}.md`,
  )
  writeFileSync(docPath, doc)
  pruneHandoffs(outDir)
  return {
    docPath,
    omitted,
    prompt: pointerPrompt({ docPath, session: args.session }),
    turns: turns.length,
  }
}

function bytes(s: string) {
  return Buffer.byteLength(s, 'utf8')
}

function docHeader(args: {
  cwd: string
  exportedAt: string
  session: SessionInfo
  target: string
  version: string
}) {
  const model = args.session.model ? ` (model: ${args.session.model})` : ''
  return [
    `# Session handoff — ${args.session.harness} session, continued in ${args.target}`,
    '',
    `- source: ${args.session.harness} session \`${args.session.id}\`${model}`,
    `- source store: ${args.session.source}`,
    `- cwd: ${args.cwd}`,
    `- exported: ${args.exportedAt} by eh ${args.version}`,
    '',
    'Continue this conversation. The transcript so far is below, oldest first;',
    'the most recent messages are at the end. Pick up where it left off.',
    '',
    '---',
    '',
  ].join('\n')
}

// The goal turn alone can blow the cap on a monster first prompt — hard-cut
// its bytes. The reserve covers this block's own ellipsis marker AND the
// omission marker the caller appends, so the final doc stays under the cap.
// A replacement char at the cut point is acceptable here.
function fitBlock(block: string, headerBytes: number) {
  if (headerBytes + bytes(block) <= HANDOFF_DOC_CAP) return block
  const budget = Math.max(0, HANDOFF_DOC_CAP - headerBytes - 192)
  const cut = Buffer.from(block, 'utf8').subarray(0, budget)
  return `${cut.toString('utf8')}\n\n*… turn truncated to fit 128 KB …*\n`
}

function pruneHandoffs(dir: string) {
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md'))
  } catch {
    return
  }
  const timed = files
    .map((f) => {
      try {
        return { f, mtime: statSync(path.join(dir, f)).mtimeMs }
      } catch {
        return { f, mtime: 0 }
      }
    })
    .sort((a, b) => b.mtime - a.mtime)
  for (const { f } of timed.slice(MAX_HANDOFF_DOCS)) {
    try {
      rmSync(path.join(dir, f), { force: true })
    } catch {
      // A vanishing file is not an error.
    }
  }
}

function turnBlock(turn: ConversationTurn) {
  return `## ${turn.role === 'user' ? 'User' : 'Assistant'}\n\n${turn.text}\n`
}
