import { afterAll, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { listSessionsForCwd } from './sessions.js'

const tempDirs: string[] = []

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true })
})

// One temp HOME per test: roots.claude/codex/grok stand in for
// ~/.claude/projects, ~/.codex/sessions, ~/.grok/sessions.
function fakeHome() {
  const home = mkdtempSync(path.join(tmpdir(), 'eh-sessions-test-'))
  tempDirs.push(home)
  return {
    claude: path.join(home, '.claude', 'projects'),
    codex: path.join(home, '.codex', 'sessions'),
    grok: path.join(home, '.grok', 'sessions'),
  }
}

// Lines are JSON-stringified unless already a string (for malformed lines).
function jsonl(lines: unknown[]) {
  return `${lines
    .map((l) => (typeof l === 'string' ? l : JSON.stringify(l)))
    .join('\n')}\n`
}

function writeFile(file: string, content: string, mtime: Date) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
  utimesSync(file, mtime, mtime)
}

// The three store layouts, mirrored from the harness formats.
function writeClaude(
  root: string,
  cwd: string,
  id: string,
  lines: unknown[],
  mtime: Date,
) {
  writeFile(
    path.join(root, cwd.replaceAll(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`),
    jsonl(lines),
    mtime,
  )
}

function writeCodex(
  root: string,
  day: string,
  id: string,
  lines: unknown[],
  mtime: Date,
) {
  const [year, month, date] = day.split('-')
  writeFile(
    path.join(root, year, month, date, `rollout-${day}T10-00-00-${id}.jsonl`),
    jsonl(lines),
    mtime,
  )
}

function writeGrok(
  root: string,
  cwd: string,
  id: string,
  summary: unknown,
  mtime: Date,
) {
  writeFile(
    path.join(root, encodeURIComponent(cwd), id, 'summary.json'),
    typeof summary === 'string' ? summary : JSON.stringify(summary),
    mtime,
  )
}

const CWD = '/work/my-project'
const T1 = new Date('2026-07-20T10:00:00Z')
const T2 = new Date('2026-07-21T10:00:00Z')
const T3 = new Date('2026-07-22T10:00:00Z')

describe('claude sessions', () => {
  test('parses title and model from the first real records', async () => {
    const roots = fakeHome()
    writeClaude(
      roots.claude,
      CWD,
      'session-1',
      [
        { sessionId: 'session-1', type: 'mode' },
        'not json at all',
        {
          isSidechain: true,
          message: { content: 'sidechain prompt', role: 'user' },
          type: 'user',
        },
        {
          message: {
            content: [{ content: 'tool output', type: 'tool_result' }],
            role: 'user',
          },
          type: 'user',
        },
        {
          message: { content: 'fix the auth bug', role: 'user' },
          type: 'user',
        },
        { message: { model: 'moonshotai/kimi-k3' }, type: 'assistant' },
      ],
      T2,
    )

    const sessions = await listSessionsForCwd(CWD, { roots })
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toEqual({
      harness: 'claude',
      id: 'session-1',
      model: 'moonshotai/kimi-k3',
      title: 'fix the auth bug',
      updatedAt: T2.toISOString(),
    })
  })

  test('reads the title from a text part in array content', async () => {
    const roots = fakeHome()
    writeClaude(
      roots.claude,
      CWD,
      'session-2',
      [
        {
          message: {
            content: [{ text: 'array prompt here', type: 'text' }],
            role: 'user',
          },
          type: 'user',
        },
      ],
      T1,
    )

    const sessions = await listSessionsForCwd(CWD, { roots })
    expect(sessions.at(0)?.title).toBe('array prompt here')
    expect(sessions.at(0)?.model).toBeUndefined()
  })

  test('prefers a compacted summary line for the title', async () => {
    const roots = fakeHome()
    writeClaude(
      roots.claude,
      CWD,
      'session-3',
      [
        { leafUuid: 'x', summary: 'Compacted session title', type: 'summary' },
        { message: { content: 'first prompt', role: 'user' }, type: 'user' },
      ],
      T1,
    )

    const sessions = await listSessionsForCwd(CWD, { roots })
    expect(sessions.at(0)?.title).toBe('Compacted session title')
  })

  test('collapses whitespace and truncates long titles', async () => {
    const roots = fakeHome()
    writeClaude(
      roots.claude,
      CWD,
      'session-4',
      [
        {
          message: { content: 'line one\nline two   spaced', role: 'user' },
          type: 'user',
        },
      ],
      T1,
    )
    writeClaude(
      roots.claude,
      CWD,
      'session-5',
      [{ message: { content: 'x'.repeat(100), role: 'user' }, type: 'user' }],
      T2,
    )

    const sessions = await listSessionsForCwd(CWD, { roots })
    expect(sessions.at(1)?.title).toBe('line one line two spaced')
    expect(sessions.at(0)?.title).toBe(`${'x'.repeat(79)}…`)
  })

  test('ignores non-jsonl entries and other project dirs', async () => {
    const roots = fakeHome()
    writeClaude(
      roots.claude,
      CWD,
      'session-6',
      [{ message: { content: 'mine', role: 'user' }, type: 'user' }],
      T1,
    )
    writeClaude(
      roots.claude,
      '/other/project',
      'session-7',
      [{ message: { content: 'not mine', role: 'user' }, type: 'user' }],
      T2,
    )
    writeFile(
      path.join(
        roots.claude,
        CWD.replaceAll(/[^a-zA-Z0-9]/g, '-'),
        'notes.txt',
      ),
      'hello',
      T3,
    )

    const sessions = await listSessionsForCwd(CWD, { roots })
    expect(sessions.map((s) => s.id)).toEqual(['session-6'])
  })

  // Regression: claude flattens EVERY non-alphanumeric char to `-` (verified
  // in the binary), not just `/`, `_`, `.` — a cwd with a space or `+` must
  // still resolve to its project dir.
  test('finds sessions for cwds with special characters', async () => {
    const roots = fakeHome()
    const cwd = '/work/my proj+x'
    writeClaude(
      roots.claude,
      cwd,
      'session-8',
      [{ message: { content: 'special path', role: 'user' }, type: 'user' }],
      T1,
    )

    const sessions = await listSessionsForCwd(cwd, { roots })
    expect(sessions.map((s) => s.id)).toEqual(['session-8'])
  })
})

describe('codex sessions', () => {
  function rollout(cwd: string, subagent = false) {
    return [
      {
        payload: {
          cwd,
          id: 'codex-id-1',
          ...(subagent ? { thread_source: 'subagent' } : {}),
        },
        type: 'session_meta',
      },
      {
        payload: { content: [{ text: '# AGENTS.md blob' }], role: 'user' },
        type: 'response_item',
      },
      {
        payload: { message: 'checkout main and pull', type: 'user_message' },
        type: 'event_msg',
      },
      { payload: { model: 'gpt-5.1' }, type: 'turn_context' },
    ]
  }

  test('matches by session_meta cwd and parses title and model', async () => {
    const roots = fakeHome()
    writeCodex(roots.codex, '2026-07-20', 'uuid-1', rollout(CWD), T2)

    const sessions = await listSessionsForCwd(CWD, { roots })
    expect(sessions).toEqual([
      {
        harness: 'codex',
        id: 'codex-id-1',
        model: 'gpt-5.1',
        title: 'checkout main and pull',
        updatedAt: T2.toISOString(),
      },
    ])
  })

  test('skips other cwds, subagent rollouts, and bad meta lines', async () => {
    const roots = fakeHome()
    writeCodex(roots.codex, '2026-07-20', 'uuid-1', rollout('/elsewhere'), T1)
    writeCodex(roots.codex, '2026-07-20', 'uuid-2', rollout(CWD, true), T2)
    writeCodex(roots.codex, '2026-07-20', 'uuid-3', ['garbage line'], T3)
    writeCodex(
      roots.codex,
      '2026-07-20',
      'uuid-4',
      [
        {
          payload: { message: 'no meta', type: 'user_message' },
          type: 'event_msg',
        },
      ],
      T3,
    )

    const sessions = await listSessionsForCwd(CWD, { roots })
    expect(sessions).toEqual([])
  })

  test('honors the file-scan cap', async () => {
    const roots = fakeHome()
    writeCodex(roots.codex, '2026-07-20', 'uuid-1', rollout(CWD), T1)
    writeCodex(roots.codex, '2026-07-21', 'uuid-2', rollout(CWD), T2)
    writeCodex(roots.codex, '2026-07-22', 'uuid-3', rollout(CWD), T3)

    const sessions = await listSessionsForCwd(CWD, {
      codexMaxFiles: 2,
      roots,
    })
    // Newest paths scan first; the third never gets opened.
    expect(sessions).toHaveLength(2)
  })
})

describe('grok sessions', () => {
  test('parses generated title, model, and nanosecond timestamps', async () => {
    const roots = fakeHome()
    writeGrok(
      roots.grok,
      CWD,
      'uuid-1',
      {
        current_model_id: 'grok-4.5',
        generated_title: 'Guillaumeify Batch 1',
        info: { id: 'real-id-1' },
        session_summary: 'fallback title',
        updated_at: '2026-07-19T00:00:59.123456789Z',
      },
      T1,
    )

    const sessions = await listSessionsForCwd(CWD, { roots })
    expect(sessions).toEqual([
      {
        harness: 'grok',
        id: 'real-id-1',
        model: 'grok-4.5',
        title: 'Guillaumeify Batch 1',
        // Nanoseconds normalize to canonical ms ISO.
        updatedAt: '2026-07-19T00:00:59.123Z',
      },
    ])
  })

  test('falls back to summary, dir-name id, last_active_at, then mtime', async () => {
    const roots = fakeHome()
    writeGrok(
      roots.grok,
      CWD,
      'uuid-2',
      {
        last_active_at: '2026-07-18T00:00:00Z',
        session_summary: 'summary only',
      },
      T2,
    )
    writeGrok(
      roots.grok,
      CWD,
      'uuid-3',
      { session_summary: 'no timestamps' },
      T3,
    )

    const sessions = await listSessionsForCwd(CWD, { roots })
    expect(sessions.at(1)).toMatchObject({
      id: 'uuid-2',
      title: 'summary only',
      updatedAt: '2026-07-18T00:00:00.000Z',
    })
    expect(sessions.at(0)).toMatchObject({
      id: 'uuid-3',
      updatedAt: T3.toISOString(),
    })
  })

  test('skips subagent sessions and unreadable summaries', async () => {
    const roots = fakeHome()
    writeGrok(
      roots.grok,
      CWD,
      'uuid-4',
      {
        generated_title: 'subagent run',
        session_kind: 'subagent',
      },
      T1,
    )
    writeGrok(roots.grok, CWD, 'uuid-5', 'not json', T2)
    mkdirSync(path.join(roots.grok, encodeURIComponent(CWD), 'uuid-6'), {
      recursive: true,
    })

    const sessions = await listSessionsForCwd(CWD, { roots })
    expect(sessions).toEqual([])
  })
})

describe('listSessionsForCwd', () => {
  test('merges stores newest-first and filters by harness', async () => {
    const roots = fakeHome()
    writeClaude(
      roots.claude,
      CWD,
      'claude-1',
      [{ message: { content: 'claude one', role: 'user' }, type: 'user' }],
      T1,
    )
    writeGrok(
      roots.grok,
      CWD,
      'grok-1',
      {
        generated_title: 'grok one',
        updated_at: T3.toISOString(),
      },
      T3,
    )
    writeCodex(
      roots.codex,
      '2026-07-21',
      'codex-1',
      [{ payload: { cwd: CWD, id: 'codex-1' }, type: 'session_meta' }],
      T2,
    )

    const all = await listSessionsForCwd(CWD, { roots })
    expect(all.map((s) => s.harness)).toEqual(['grok', 'codex', 'claude'])

    const codexOnly = await listSessionsForCwd(CWD, {
      harness: 'codex',
      roots,
    })
    expect(codexOnly.map((s) => s.harness)).toEqual(['codex'])
  })

  test('returns nothing when the stores are empty or missing', async () => {
    const roots = fakeHome()
    expect(await listSessionsForCwd(CWD, { roots })).toEqual([])
  })

  test('caps the merged list', async () => {
    const roots = fakeHome()
    for (let i = 0; i < 30; i++) {
      writeClaude(
        roots.claude,
        CWD,
        `claude-${String(i)}`,
        [
          {
            message: { content: `prompt ${String(i)}`, role: 'user' },
            type: 'user',
          },
        ],
        new Date(T1.getTime() + i * 1000),
      )
      writeCodex(
        roots.codex,
        '2026-07-20',
        `codex-${String(i)}`,
        [
          {
            payload: { cwd: CWD, id: `codex-${String(i)}` },
            type: 'session_meta',
          },
        ],
        new Date(T1.getTime() + i * 1000),
      )
    }

    const sessions = await listSessionsForCwd(CWD, {
      codexMaxMatches: 30,
      roots,
    })
    expect(sessions).toHaveLength(50)
  })
})
