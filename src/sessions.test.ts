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

import type { ListSessionsOptions } from './sessions.js'

import { listSessionsForCwd } from './sessions.js'

// Stub opencode's runner everywhere but its own describe block, so tests
// don't spawn the real binary (≈0.5s each on machines that have it).
async function listSessions(cwd: string, options: ListSessionsOptions = {}) {
  return listSessionsForCwd(cwd, {
    opencodeRunner: async () => Promise.resolve([]),
    ...options,
  })
}

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
    pi: path.join(home, '.pi', 'agent', 'sessions'),
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

// pi's `--<cwd, leading slash stripped, / \\ : → ->--` flattening, mirrored.
function writePi(
  root: string,
  cwd: string,
  id: string,
  lines: unknown[],
  mtime: Date,
) {
  writeFile(
    path.join(
      root,
      `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`,
      `2026-07-20T10-00-00-000Z_${id}.jsonl`,
    ),
    jsonl(lines),
    mtime,
  )
}

function writePiSessionDir(
  root: string,
  id: string,
  lines: unknown[],
  mtime: Date,
) {
  writeFile(
    path.join(root, `2026-07-20T10-00-00-000Z_${id}.jsonl`),
    jsonl(lines),
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

    const sessions = await listSessions(CWD, { roots })
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

    const sessions = await listSessions(CWD, { roots })
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

    const sessions = await listSessions(CWD, { roots })
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

    const sessions = await listSessions(CWD, { roots })
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

    const sessions = await listSessions(CWD, { roots })
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

    const sessions = await listSessions(cwd, { roots })
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

    const sessions = await listSessions(CWD, { roots })
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

    const sessions = await listSessions(CWD, { roots })
    expect(sessions).toEqual([])
  })

  test('honors the file-scan cap', async () => {
    const roots = fakeHome()
    writeCodex(roots.codex, '2026-07-20', 'uuid-1', rollout(CWD), T1)
    writeCodex(roots.codex, '2026-07-21', 'uuid-2', rollout(CWD), T2)
    writeCodex(roots.codex, '2026-07-22', 'uuid-3', rollout(CWD), T3)

    const sessions = await listSessions(CWD, {
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

    const sessions = await listSessions(CWD, { roots })
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

    const sessions = await listSessions(CWD, { roots })
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

    const sessions = await listSessions(CWD, { roots })
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

    const all = await listSessions(CWD, { roots })
    expect(all.map((s) => s.harness)).toEqual(['grok', 'codex', 'claude'])

    const codexOnly = await listSessions(CWD, {
      harness: 'codex',
      roots,
    })
    expect(codexOnly.map((s) => s.harness)).toEqual(['codex'])
  })

  test('returns nothing when the stores are empty or missing', async () => {
    const roots = fakeHome()
    expect(await listSessions(CWD, { roots })).toEqual([])
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

    const sessions = await listSessions(CWD, {
      codexMaxMatches: 30,
      roots,
    })
    expect(sessions).toHaveLength(50)
  })
})

describe('pi sessions', () => {
  test('parses id, model, and title from the header and first records', async () => {
    const roots = fakeHome()
    writePi(
      roots.pi,
      CWD,
      'uuid-1',
      [
        { cwd: CWD, id: 'uuid-1', type: 'session', version: 3 },
        {
          modelId: 'zai/glm-5.2',
          provider: 'vercel-ai-gateway',
          type: 'model_change',
        },
        {
          message: {
            content: [{ text: 'where are the forms?', type: 'text' }],
            role: 'user',
          },
          type: 'message',
        },
      ],
      T2,
    )

    const sessions = await listSessions(CWD, { roots })
    expect(sessions).toEqual([
      {
        harness: 'pi',
        id: 'uuid-1',
        model: 'zai/glm-5.2',
        title: 'where are the forms?',
        updatedAt: T2.toISOString(),
      },
    ])
  })

  test('falls back to the filename when the header is missing', async () => {
    const roots = fakeHome()
    writePi(
      roots.pi,
      CWD,
      'uuid-2',
      [
        {
          message: { content: 'string prompt', role: 'user' },
          type: 'message',
        },
      ],
      T1,
    )

    const sessions = await listSessions(CWD, { roots })
    expect(sessions.at(0)).toMatchObject({
      // The resume arg is the uuid segment, not the <ts>_<uuid> basename.
      id: 'uuid-2',
      title: 'string prompt',
    })
    expect(sessions.at(0)?.model).toBeUndefined()
  })

  test('skips assistant messages and other project dirs', async () => {
    const roots = fakeHome()
    writePi(
      roots.pi,
      CWD,
      'uuid-3',
      [
        { id: 'uuid-3', type: 'session' },
        {
          message: {
            content: [{ text: 'assistant reply', type: 'text' }],
            role: 'assistant',
          },
          type: 'message',
        },
        {
          message: {
            content: [{ text: 'real prompt', type: 'text' }],
            role: 'user',
          },
          type: 'message',
        },
      ],
      T1,
    )
    writePi(
      roots.pi,
      '/other/project',
      'uuid-4',
      [{ id: 'uuid-4', type: 'session' }],
      T2,
    )

    const sessions = await listSessions(CWD, { roots })
    expect(sessions.map((s) => s.id)).toEqual(['uuid-3'])
    expect(sessions.at(0)?.title).toBe('real prompt')
  })

  // Regression: pi keeps underscores/dots and only maps / \ : to dashes,
  // wrapped in `--` — a cwd with those chars must resolve exactly.
  test('finds sessions for cwds with underscores and dots', async () => {
    const roots = fakeHome()
    const cwd = '/work/01_Projects/my.app'
    writePi(roots.pi, cwd, 'uuid-5', [{ id: 'uuid-5', type: 'session' }], T1)

    const sessions = await listSessions(cwd, { roots })
    expect(sessions.map((s) => s.id)).toEqual(['uuid-5'])
  })

  test('honors a flat custom session directory and filters by header cwd', async () => {
    const roots = fakeHome()
    const piSessionDir = path.join(path.dirname(roots.pi), 'custom-sessions')
    writePiSessionDir(
      piSessionDir,
      'uuid-6',
      [
        { cwd: CWD, id: 'uuid-6', type: 'session', version: 3 },
        {
          message: { content: 'custom directory prompt', role: 'user' },
          type: 'message',
        },
      ],
      T2,
    )
    writePiSessionDir(
      piSessionDir,
      'uuid-7',
      [{ cwd: '/other/project', id: 'uuid-7', type: 'session', version: 3 }],
      T3,
    )

    const sessions = await listSessions(CWD, {
      roots: { ...roots, piSessionDir },
    })

    expect(sessions).toEqual([
      {
        harness: 'pi',
        id: 'uuid-6',
        title: 'custom directory prompt',
        updatedAt: T2.toISOString(),
      },
    ])
  })
})

describe('opencode sessions', () => {
  // Rows in `session list --format json` shape (global scope, epoch ms).
  function opencodeRunner(rows: unknown[]) {
    return async () => Promise.resolve(rows)
  }

  test('filters rows to this directory and maps epoch-ms timestamps', async () => {
    const roots = fakeHome()
    const sessions = await listSessions(CWD, {
      opencodeRunner: opencodeRunner([
        {
          directory: CWD,
          id: 'ses_1',
          title: 'fix the login bug',
          updated: T2.getTime(),
        },
        {
          directory: '/other/project',
          id: 'ses_2',
          title: 'not mine',
          updated: T3.getTime(),
        },
        {
          directory: CWD,
          id: 'ses_3',
          title: 'older one',
          updated: T1.getTime(),
        },
      ]),
      roots,
    })

    expect(sessions).toEqual([
      {
        harness: 'opencode',
        id: 'ses_1',
        title: 'fix the login bug',
        updatedAt: T2.toISOString(),
      },
      {
        harness: 'opencode',
        id: 'ses_3',
        title: 'older one',
        updatedAt: T1.toISOString(),
      },
    ])
  })

  test('treats runner failures as no rows', async () => {
    const roots = fakeHome()
    expect(
      await listSessions(CWD, {
        opencodeRunner: async () => Promise.reject(new Error('spawn failed')),
        roots,
      }),
    ).toEqual([])
  })

  test('drops malformed rows but keeps the good ones', async () => {
    const roots = fakeHome()
    const sessions = await listSessions(CWD, {
      opencodeRunner: async () =>
        Promise.resolve([
          { directory: CWD, id: 'ses_1', title: 'good', updated: T2.getTime() },
          { noId: true },
          // Past the Date ceiling — must not throw through the whole store.
          { directory: CWD, id: 'ses_2', title: 'bad clock', updated: 9e18 },
          // Before the Date floor — the negative boundary must be isolated too.
          { directory: CWD, id: 'ses_4', title: 'bad clock', updated: -9e18 },
          {
            directory: CWD,
            id: 'ses_3',
            title: 'also good',
            updated: T1.getTime(),
          },
        ]),
      roots,
    })
    expect(sessions.map((s) => s.id)).toEqual(['ses_1', 'ses_3'])
  })
})
