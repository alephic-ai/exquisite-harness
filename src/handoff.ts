import {
  chmodSync,
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
const GAP_MARKER_RESERVE = 128
const TURN_TRUNCATION_MARKER = '\n\n*… turn truncated to fit 128 KB …*\n'

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
  const available = HANDOFF_DOC_CAP - headerBytes - GAP_MARKER_RESERVE
  const newest = blocks.at(-1) ?? ''
  const hasLaterTurn = blocks.length - 1 > first
  // When both ends are oversized, each gets half. If either is small, the
  // other can use the space it leaves behind.
  const newestReserve = hasLaterTurn
    ? Math.min(bytes(newest) + 1, Math.floor(available / 2))
    : 0
  const goalBlock = fitBlock(
    blocks[first] ?? '',
    Math.max(0, available - newestReserve),
  )
  const suffix: string[] = []
  let remaining = available - bytes(goalBlock)
  for (let i = blocks.length - 1; i > first && remaining > 1; i--) {
    const size = bytes(blocks[i]) + 1
    if (size <= remaining) {
      suffix.unshift(blocks[i])
      remaining -= size
      continue
    }
    // The newest turn is part of the handoff contract even when it cannot fit
    // whole. Older turns are all-or-nothing so the retained suffix is coherent.
    if (suffix.length === 0) {
      suffix.unshift(fitBlock(blocks[i], remaining - 1))
    }
    break
  }
  // Everything except the goal block and the kept suffix is omitted —
  // including any leading turns before the goal (assistant-first transcripts).
  const omitted = blocks.length - 1 - suffix.length
  const marker = `*… ${String(omitted)} earlier turn${omitted === 1 ? '' : 's'} omitted to fit 128 KB …*`
  const body = [goalBlock, ...(omitted > 0 ? [marker] : []), ...suffix].join(
    '\n',
  )
  return { doc: header + body, omitted }
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

// Extract → build → name, without touching disk, so the flow can fail fast on
// a corrupted or gutted transcript (falling back to a native resume) before
// the wiring pickers run, and defer the write until the launch is confirmed.
// Throws when the source store yields no conversation.
export async function prepareHandoff(args: {
  cwd: string
  session: SessionInfo
  target: string
}) {
  const turns = await extractConversation(args.session)
  if (turns.length === 0) {
    throw new Error(
      `couldn't extract any conversation from ${args.session.harness} — resume it natively instead`,
    )
  }
  const { doc, omitted } = buildHandoffDoc({
    ...args,
    exportedAt: new Date().toISOString(),
    turns,
    version: pkg.version,
  })
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-')
  const docPath = path.join(
    handoffsDir(),
    `${stamp}-${args.session.harness}-to-${args.target}-${args.session.id.slice(0, 8)}.md`,
  )
  return {
    doc,
    docPath,
    omitted,
    prompt: pointerPrompt({ docPath, session: args.session }),
    turns: turns.length,
  }
}

// The effectful half of a handoff: write the prepared doc and prune old ones.
export function commitHandoff(prepared: { doc: string; docPath: string }) {
  const outDir = path.dirname(prepared.docPath)
  mkdirSync(outDir, { recursive: true })
  writeFileSync(prepared.docPath, prepared.doc, { mode: 0o600 })
  // `mode` only applies when a file is created. A same-millisecond rewrite of
  // an existing path must become private too.
  chmodSync(prepared.docPath, 0o600)
  pruneHandoffs(outDir)
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

function fitBlock(block: string, maxBytes: number) {
  if (bytes(block) <= maxBytes) return block
  const markerBytes = bytes(TURN_TRUNCATION_MARKER)
  if (maxBytes <= markerBytes) {
    return truncateUtf8(TURN_TRUNCATION_MARKER, maxBytes)
  }
  return `${truncateUtf8(block, maxBytes - markerBytes)}${TURN_TRUNCATION_MARKER}`
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

function truncateUtf8(text: string, maxBytes: number) {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return text
  let end = Math.max(0, maxBytes)
  // Do not decode a partial multi-byte code point at the cut boundary.
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1
  return buffer.subarray(0, end).toString('utf8')
}

function turnBlock(turn: ConversationTurn) {
  return `## ${turn.role === 'user' ? 'User' : 'Assistant'}\n\n${turn.text}\n`
}
