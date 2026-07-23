import { createReadStream, readdirSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'

export interface ListSessionsOptions {
  codexMaxFiles?: number
  codexMaxMatches?: number
  harness?: string
  roots?: SessionRoots
}

export interface SessionInfo {
  // Plain string, not a union — this module never imports the harness
  // registry; flow.ts maps the value back to a HarnessDef.
  harness: string
  // The value the harness's resume arg takes (claude/grok `--resume <id>`,
  // codex `resume <id>`).
  id: string
  model?: string
  // One line, whitespace-collapsed; '' when nothing usable parsed.
  title: string
  updatedAt: string
}

export interface SessionRoots {
  claude?: string
  codex?: string
  grok?: string
}

// Per-store caps bound the metadata scans; the merged cap keeps the picker
// focused on what anyone would actually resume.
const MAX_PER_STORE = 50
const MAX_SESSIONS = 50
// Codex sessions are date-organized, not cwd-organized — every candidate's
// first line must be read to learn its cwd, so the scan is bounded.
const CODEX_MAX_FILES = 300
const CODEX_MAX_MATCHES = 25
// Lines scanned per file while hunting for a title/model — the interesting
// records sit at the top of a transcript.
const META_SCAN_LINES = 200

// Read-only enumeration of the harness session stores (the formats are
// undocumented and shift between harness releases, so every parse is
// best-effort: a store that stops matching just yields fewer rows, never an
// error). Covers every session on disk, not just eh-launched ones.
export async function listSessionsForCwd(
  cwd: string,
  options: ListSessionsOptions = {},
) {
  const home = os.homedir()
  // claude/codex move their whole config dir via env (CLAUDE_CONFIG_DIR /
  // CODEX_HOME, both verified against the installed binaries); grok has no
  // such knob.
  const roots = {
    claude:
      options.roots?.claude ??
      path.join(
        process.env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'),
        'projects',
      ),
    codex:
      options.roots?.codex ??
      path.join(
        process.env.CODEX_HOME ?? path.join(home, '.codex'),
        'sessions',
      ),
    grok: options.roots?.grok ?? path.join(home, '.grok', 'sessions'),
  }
  const wanted = options.harness
  const jobs: Promise<SessionInfo[]>[] = []
  if (wanted === undefined || wanted === 'claude') {
    jobs.push(claudeSessions(cwd, roots.claude))
  }
  if (wanted === undefined || wanted === 'codex') {
    jobs.push(
      codexSessions(cwd, roots.codex, {
        maxFiles: options.codexMaxFiles ?? CODEX_MAX_FILES,
        maxMatches: options.codexMaxMatches ?? CODEX_MAX_MATCHES,
      }),
    )
  }
  if (wanted === undefined || wanted === 'grok') {
    jobs.push(Promise.resolve(grokSessions(cwd, roots.grok)))
  }
  const groups = await Promise.all(jobs)
  return groups
    .flat()
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, MAX_SESSIONS)
}

// --- claude ---

async function claudeMeta(file: string) {
  let title = ''
  let model: string | undefined
  let scanned = 0
  try {
    for await (const line of readLines(file)) {
      if ((title && model) || ++scanned > META_SCAN_LINES) break
      const row = parseRow(line)
      if (!row) continue
      // Compacted transcripts open with a ready-made summary line.
      if (!title && row.type === 'summary') {
        title = oneLine(str(row.summary) ?? '')
        continue
      }
      if (!title && row.type === 'user') {
        const text = claudeUserText(row)
        if (text !== undefined) title = oneLine(text)
        continue
      }
      if (!model && row.type === 'assistant') {
        model = str(obj(row.message)?.model)
      }
    }
  } catch {
    // Unreadable mid-scan — keep whatever parsed.
  }
  return { model, title }
}

// Claude stores one transcript per session under a project dir named by the
// cwd with every non-alphanumeric char flattened to `-` (verified against the
// claude binary: `e.replace(/[^a-zA-Z0-9]/g,"-")` — lossy, so colliding cwds
// share a dir; nothing to do about it). Claude additionally truncates +
// hash-suffixes names over 200 chars — not replicated here, so sessions in
// very deep paths just don't list.
async function claudeSessions(cwd: string, root: string) {
  const dir = path.join(root, cwd.replaceAll(/[^a-zA-Z0-9]/g, '-'))
  const files: { file: string; mtime: Date }[] = []
  for (const entry of readdirOrEmpty(dir)) {
    if (!entry.endsWith('.jsonl')) continue
    const file = path.join(dir, entry)
    const stat = statFile(file)
    if (stat) files.push({ file, mtime: stat.mtime })
  }
  files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
  const sessions: SessionInfo[] = []
  for (const { file, mtime } of files.slice(0, MAX_PER_STORE)) {
    const { model, title } = await claudeMeta(file)
    sessions.push({
      harness: 'claude',
      id: path.basename(file, '.jsonl'),
      model,
      title,
      updatedAt: mtime.toISOString(),
    })
  }
  return sessions
}

// The first typed prompt: a string content, or the first text part of a
// content array (tool_result-only user records carry no title).
function claudeUserText(row: Record<string, unknown>) {
  if (row.isSidechain === true) return undefined
  const content = obj(row.message)?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    for (const part of content) {
      const p = obj(part)
      if (p?.type === 'text' && typeof p.text === 'string' && p.text.trim()) {
        return p.text
      }
    }
  }
  return undefined
}

// --- codex ---

// Codex rollouts live under YYYY/MM/DD — nothing about the path says which
// cwd a session ran in, so line 1 (session_meta) of each candidate is read
// until enough matches turn up. Full paths sort chronologically, so reversed
// they scan newest-first.
async function codexMeta(file: string) {
  let title = ''
  let model: string | undefined
  let scanned = 0
  try {
    for await (const line of readLines(file)) {
      if ((title && model) || ++scanned > META_SCAN_LINES) break
      const row = parseRow(line)
      const payload = obj(row?.payload)
      if (!payload) continue
      // The injected instructions blob is a response_item; the first
      // user_message event is the actual typed prompt.
      if (
        !title &&
        row?.type === 'event_msg' &&
        payload.type === 'user_message'
      ) {
        title = oneLine(str(payload.message) ?? '')
      } else if (!model && row?.type === 'turn_context') {
        model = str(payload.model)
      }
    }
  } catch {
    // Unreadable mid-scan — keep whatever parsed.
  }
  return { model, title }
}

function codexRolloutPaths(root: string) {
  const paths: string[] = []
  for (const year of readdirOrEmpty(root)) {
    const yearDir = path.join(root, year)
    for (const month of readdirOrEmpty(yearDir)) {
      const monthDir = path.join(yearDir, month)
      for (const day of readdirOrEmpty(monthDir)) {
        const dayDir = path.join(monthDir, day)
        for (const file of readdirOrEmpty(dayDir)) {
          if (file.endsWith('.jsonl')) paths.push(path.join(dayDir, file))
        }
      }
    }
  }
  return paths.sort().reverse()
}

async function codexSessionMeta(file: string) {
  try {
    for await (const line of readLines(file)) {
      if (!line.trim()) continue
      const row = parseRow(line)
      const payload = obj(row?.payload)
      if (row?.type !== 'session_meta' || !payload) return undefined
      const id = str(payload.id)
      const cwd = str(payload.cwd)
      if (!id || !cwd) return undefined
      // Subagent rollouts (guardian etc.) are resume noise.
      return { cwd, id, subagent: payload.thread_source === 'subagent' }
    }
  } catch {
    // Unreadable — treated as no meta.
  }
  return undefined
}

async function codexSessions(
  cwd: string,
  root: string,
  bounds: { maxFiles: number; maxMatches: number },
) {
  const sessions: SessionInfo[] = []
  let opened = 0
  for (const file of codexRolloutPaths(root)) {
    if (opened >= bounds.maxFiles || sessions.length >= bounds.maxMatches) {
      break
    }
    opened += 1
    const meta = await codexSessionMeta(file)
    if (!meta) continue
    if (meta.cwd !== cwd || meta.subagent) continue
    const stat = statFile(file)
    if (!stat) continue
    const { model, title } = await codexMeta(file)
    sessions.push({
      harness: 'codex',
      id: meta.id,
      model,
      title,
      updatedAt: stat.mtime.toISOString(),
    })
  }
  return sessions
}

// --- grok ---

// Grok sessions are directories named by uuid under the encodeURIComponent'd
// cwd, each holding a pre-generated summary.json — the cheapest metadata of
// the three stores.
function grokSessions(cwd: string, root: string) {
  const dir = path.join(root, encodeURIComponent(cwd))
  const candidates: { file: string; id: string; mtime: Date }[] = []
  for (const entry of readdirOrEmpty(dir)) {
    const file = path.join(dir, entry, 'summary.json')
    const stat = statFile(file)
    if (stat) candidates.push({ file, id: entry, mtime: stat.mtime })
  }
  candidates.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
  const sessions: SessionInfo[] = []
  for (const { file, id, mtime } of candidates.slice(0, MAX_PER_STORE)) {
    const session = grokSummary(file, id, mtime)
    if (session) sessions.push(session)
  }
  return sessions
}

function grokSummary(file: string, dirId: string, mtime: Date) {
  const data = parseFile(file)
  if (!data || data.session_kind === 'subagent') return undefined
  const title = str(data.generated_title)?.trim()
    ? str(data.generated_title)
    : str(data.session_summary)
  const infoId = str(obj(data.info)?.id)
  return {
    harness: 'grok',
    id: infoId ?? dirId,
    model: str(data.current_model_id),
    title: oneLine(title ?? ''),
    updatedAt: isoOrFallback(
      str(data.updated_at) ?? str(data.last_active_at),
      mtime,
    ),
  }
}

// --- shared helpers ---

function oneLine(text: string) {
  const flat = text.replaceAll(/\s+/g, ' ').trim()
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat
}

function parseFile(file: string) {
  try {
    return obj(JSON.parse(readFileSync(file, 'utf8')) as unknown)
  } catch {
    return undefined
  }
}

function parseRow(line: string) {
  try {
    return obj(JSON.parse(line) as unknown)
  } catch {
    return undefined
  }
}

// Line-streaming that can be abandoned early (break/return) without reading
// the whole file — codex's session_meta line alone can be tens of KB, and
// transcripts run to megabytes. Same shape as sumTranscriptUsage in
// statusline.ts, as a generator so callers can stop.
async function* readLines(file: string) {
  const input = createReadStream(file, { encoding: 'utf8' })
  const rl = createInterface({ crlfDelay: Infinity, input })
  try {
    for await (const line of rl) {
      yield line
    }
  } finally {
    rl.close()
    input.destroy()
  }
}

// grok stamps nanoseconds and its summaries are hand-editable; normalize to
// canonical ms ISO so Date.parse/timeAgo downstream always get clean input.
function isoOrFallback(raw: string | undefined, fallback: Date) {
  const t = raw === undefined ? Number.NaN : Date.parse(raw)
  return Number.isNaN(t) ? fallback.toISOString() : new Date(t).toISOString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function obj(value: unknown) {
  return isRecord(value) ? value : undefined
}

function readdirOrEmpty(dir: string) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function statFile(file: string) {
  try {
    const stat = statSync(file)
    return stat.isFile() ? stat : undefined
  } catch {
    return undefined
  }
}

function str(value: unknown) {
  return typeof value === 'string' ? value : undefined
}
