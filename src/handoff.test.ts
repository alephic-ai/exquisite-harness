import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { SessionInfo } from './sessions.js'

import * as config from './config.js'
import {
  buildHandoffDoc,
  HANDOFF_DOC_CAP,
  pointerPrompt,
  writeHandoff,
} from './handoff.js'
import { buildLaunchPlan, HARNESSES } from './harnesses.js'
import { extractConversation } from './sessions.js'

const tempDirs: string[] = []

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true })
})

function fakeHome() {
  const home = tempDir()
  return {
    claude: path.join(home, '.claude', 'projects'),
    codex: path.join(home, '.codex', 'sessions'),
    grok: path.join(home, '.grok', 'sessions'),
  }
}

function jsonl(lines: unknown[]) {
  return `${lines
    .map((l) => (typeof l === 'string' ? l : JSON.stringify(l)))
    .join('\n')}\n`
}

function session(overrides: Partial<SessionInfo>): SessionInfo {
  return {
    harness: 'claude',
    id: 'sess-id-1234',
    source: '',
    title: 'fix the auth bug',
    updatedAt: T1.toISOString(),
    ...overrides,
  }
}

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'eh-handoff-test-'))
  tempDirs.push(dir)
  return dir
}

function writeClaude(root: string, cwd: string, id: string, lines: unknown[]) {
  return writeFile(
    path.join(root, cwd.replaceAll(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`),
    jsonl(lines),
  )
}

function writeCodex(root: string, day: string, id: string, lines: unknown[]) {
  const [year, month, date] = day.split('-')
  return writeFile(
    path.join(root, year, month, date, `rollout-${day}T10-00-00-${id}.jsonl`),
    jsonl(lines),
  )
}

function writeFile(file: string, content: string) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
  utimesSync(file, T1, T1)
  return file
}

function writeGrokHistory(
  root: string,
  cwd: string,
  id: string,
  lines: unknown[],
) {
  writeFile(
    path.join(root, encodeURIComponent(cwd), id, 'chat_history.jsonl'),
    jsonl(lines),
  )
  return path.join(root, encodeURIComponent(cwd), id)
}

const CWD = '/work/my-project'
const T1 = new Date('2026-07-20T10:00:00Z')

describe('extractConversation', () => {
  test('claude: extracts real turns in order, skipping harness noise', async () => {
    const roots = fakeHome()
    const file = writeClaude(roots.claude, CWD, 'sess-1', [
      { type: 'mode' },
      'not json',
      {
        isMeta: true,
        message: { content: 'injected skill blob', role: 'user' },
        type: 'user',
      },
      {
        isSidechain: true,
        message: { content: 'subagent prompt', role: 'user' },
        type: 'user',
      },
      {
        message: {
          content: [{ content: 'out', type: 'tool_result' }],
          role: 'user',
        },
        type: 'user',
      },
      {
        message: {
          content: 'first real prompt\n\n<system-reminder>x</system-reminder>',
          role: 'user',
        },
        type: 'user',
      },
      {
        message: {
          content: [
            { thinking: 'hmm', type: 'thinking' },
            { text: 'first answer', type: 'text' },
            { input: {}, name: 'Bash', type: 'tool_use' },
          ],
        },
        type: 'assistant',
      },
      {
        message: {
          content: [
            { text: 'array prompt', type: 'text' },
            { text: 'second part', type: 'text' },
          ],
          role: 'user',
        },
        type: 'user',
      },
      {
        message: { content: [{ text: 'second answer', type: 'text' }] },
        type: 'assistant',
      },
    ])

    const turns = await extractConversation(
      session({ harness: 'claude', source: file }),
    )
    expect(turns).toEqual([
      { role: 'user', text: 'first real prompt' },
      { role: 'assistant', text: 'first answer' },
      { role: 'user', text: 'array prompt\nsecond part' },
      { role: 'assistant', text: 'second answer' },
    ])
  })

  test.each([
    '<bash-input>ls</bash-input>',
    '<bash-stdout>files</bash-stdout>',
    '<command-message>review</command-message>',
    '<command-name>/review</command-name>',
    '<local-command-stdout>done</local-command-stdout>',
    '<task-notification><task-id>42</task-id><result>subagent output</result><usage>1000 tokens</usage></task-notification>',
  ])('claude: skips wrapper-only user record %s', async (wrapper) => {
    const roots = fakeHome()
    const file = writeClaude(roots.claude, CWD, 'sess-2', [
      { message: { content: wrapper, role: 'user' }, type: 'user' },
      { message: { content: 'real', role: 'user' }, type: 'user' },
    ])

    const turns = await extractConversation(
      session({ harness: 'claude', source: file }),
    )
    expect(turns).toEqual([{ role: 'user', text: 'real' }])
  })

  // Stock claude inlines Task-subagent records in the main transcript.
  test('claude: skips inline sidechain assistant rows', async () => {
    const roots = fakeHome()
    const file = writeClaude(roots.claude, CWD, 'sess-3', [
      { message: { content: 'main prompt', role: 'user' }, type: 'user' },
      {
        isSidechain: true,
        message: { content: [{ text: 'subagent prose', type: 'text' }] },
        type: 'assistant',
      },
      {
        message: { content: [{ text: 'main answer', type: 'text' }] },
        type: 'assistant',
      },
    ])

    const turns = await extractConversation(
      session({ harness: 'claude', source: file }),
    )
    expect(turns).toEqual([
      { role: 'user', text: 'main prompt' },
      { role: 'assistant', text: 'main answer' },
    ])
  })

  test('codex: extracts only the event_msg stream', async () => {
    const roots = fakeHome()
    const file = writeCodex(roots.codex, '2026-07-20', 'uuid-1', [
      { payload: { cwd: CWD, id: 'uuid-1' }, type: 'session_meta' },
      {
        payload: { content: [{ text: '# AGENTS blob' }], role: 'user' },
        type: 'response_item',
      },
      {
        payload: { message: 'real prompt', type: 'user_message' },
        type: 'event_msg',
      },
      {
        payload: { encrypted_content: 'x', type: 'reasoning' },
        type: 'response_item',
      },
      {
        payload: { message: 'agent reply', type: 'agent_message' },
        type: 'event_msg',
      },
      { payload: { type: 'token_count' }, type: 'event_msg' },
    ])

    const turns = await extractConversation(
      session({ harness: 'codex', source: file }),
    )
    expect(turns).toEqual([
      { role: 'user', text: 'real prompt' },
      { role: 'assistant', text: 'agent reply' },
    ])
  })

  test('grok: skips synthetic and empty turns, strips user_query', async () => {
    const roots = fakeHome()
    const dir = writeGrokHistory(roots.grok, CWD, 'uuid-1', [
      { content: 'system prompt', type: 'system' },
      {
        content: [{ text: 'injected', type: 'text' }],
        synthetic_reason: 'project_instructions',
        type: 'user',
      },
      {
        content: [
          {
            text: '<user_info> OS Version: linux Shell: zsh </user_info>',
            type: 'text',
          },
        ],
        synthetic_reason: null,
        type: 'user',
      },
      {
        content: [
          {
            text: '<user_query>\nreal grok prompt\n</user_query>',
            type: 'text',
          },
        ],
        prompt_index: 0,
        synthetic_reason: null,
        type: 'user',
      },
      { encrypted_content: 'x', type: 'reasoning' },
      { content: '', type: 'assistant' },
      { content: 'grok answer', type: 'assistant' },
      { content: 'result', type: 'tool_result' },
    ])

    const turns = await extractConversation(
      session({ harness: 'grok', source: dir }),
    )
    expect(turns).toEqual([
      { role: 'user', text: 'real grok prompt' },
      { role: 'assistant', text: 'grok answer' },
    ])
  })

  test('grok: extracts image prompts without attachment metadata or reminders', async () => {
    const roots = fakeHome()
    const dir = writeGrokHistory(roots.grok, CWD, 'uuid-image', [
      {
        content: [
          {
            text: [
              '<image_files>/tmp/screenshot.png</image_files>',
              '<user_query>review this image</user_query>',
              '<system-reminder><image_compression_notice>compressed</image_compression_notice></system-reminder>',
            ].join('\n'),
            type: 'text',
          },
        ],
        type: 'user',
      },
    ])

    const turns = await extractConversation(
      session({ harness: 'grok', source: dir }),
    )
    expect(turns).toEqual([{ role: 'user', text: 'review this image' }])
  })

  test('missing transcript yields no turns', async () => {
    const turns = await extractConversation(
      session({ harness: 'claude', source: '/nonexistent/nope.jsonl' }),
    )
    expect(turns).toEqual([])
  })
})

describe('buildHandoffDoc', () => {
  const base = {
    cwd: CWD,
    exportedAt: '2026-07-23T17:00:00.000Z',
    target: 'codex',
    version: '0.6.0',
  }

  test('renders header and ordered turns under the cap', () => {
    const { doc, omitted } = buildHandoffDoc({
      ...base,
      session: session({ model: 'kimi-k3', source: '/store/f.jsonl' }),
      turns: [
        { role: 'user', text: 'goal here' },
        { role: 'assistant', text: 'did the thing' },
      ],
    })
    expect(omitted).toBe(0)
    expect(doc).toContain(
      '# Session handoff — claude session, continued in codex',
    )
    expect(doc).toContain('(model: kimi-k3)')
    expect(doc).toContain('- source store: /store/f.jsonl')
    expect(doc).toContain('by eh 0.6.0')
    expect(doc.indexOf('## User')).toBeLessThan(doc.indexOf('## Assistant'))
    expect(doc).toContain('goal here')
    expect(doc).toContain('did the thing')
  })

  test('over cap: keeps the goal and the newest turns, marks the gap', () => {
    const filler = Array.from({ length: 30 }, (_, i) => ({
      role: 'assistant' as const,
      text: `turn ${String(i)} ${'x'.repeat(6000)}`,
    }))
    const turns = [
      { role: 'user' as const, text: 'the original goal' },
      ...filler,
    ]

    const { doc, omitted } = buildHandoffDoc({
      ...base,
      session: session({}),
      turns,
    })
    expect(Buffer.byteLength(doc, 'utf8')).toBeLessThanOrEqual(HANDOFF_DOC_CAP)
    expect(doc).toContain('the original goal')
    expect(doc).toContain('turn 29')
    expect(omitted).toBeGreaterThan(0)
    expect(doc).toContain(`${String(omitted)} earlier turns omitted`)
    expect(doc).not.toContain('turn 0 ')
  })

  test('multibyte text stays within the byte cap', () => {
    const filler = Array.from({ length: 30 }, () => ({
      role: 'assistant' as const,
      text: '🥖'.repeat(2000),
    }))
    const { doc } = buildHandoffDoc({
      ...base,
      session: session({}),
      turns: [{ role: 'user', text: 'goal' }, ...filler],
    })
    expect(Buffer.byteLength(doc, 'utf8')).toBeLessThanOrEqual(HANDOFF_DOC_CAP)
  })

  test('a goal turn bigger than the cap keeps the newest turn', () => {
    const { doc, omitted } = buildHandoffDoc({
      ...base,
      session: session({}),
      turns: [
        { role: 'user', text: 'y'.repeat(HANDOFF_DOC_CAP * 2) },
        { role: 'assistant', text: 'answer' },
      ],
    })
    expect(Buffer.byteLength(doc, 'utf8')).toBeLessThanOrEqual(HANDOFF_DOC_CAP)
    expect(doc).toContain('turn truncated to fit 128 KB')
    expect(doc).toContain('answer')
    expect(omitted).toBe(0)
  })

  test('a near-cap goal leaves room for the omission marker', () => {
    const { doc } = buildHandoffDoc({
      ...base,
      session: session({}),
      turns: [
        { role: 'user', text: 'y'.repeat(130_700) },
        { role: 'assistant', text: 'z'.repeat(500) },
      ],
    })
    expect(Buffer.byteLength(doc, 'utf8')).toBeLessThanOrEqual(HANDOFF_DOC_CAP)
  })

  test('an oversized newest turn is truncated instead of discarded', () => {
    const { doc, omitted } = buildHandoffDoc({
      ...base,
      session: session({}),
      turns: [
        { role: 'user', text: 'goal' },
        {
          role: 'assistant',
          text: `NEWEST_SENTINEL ${'z'.repeat(HANDOFF_DOC_CAP * 2)}`,
        },
      ],
    })
    expect(Buffer.byteLength(doc, 'utf8')).toBeLessThanOrEqual(HANDOFF_DOC_CAP)
    expect(doc).toContain('NEWEST_SENTINEL')
    expect(doc).toContain('turn truncated to fit 128 KB')
    expect(omitted).toBe(0)
  })

  test('omitted counts leading turns when the goal is not first', () => {
    const filler = Array.from({ length: 30 }, () => ({
      role: 'assistant' as const,
      text: 'x'.repeat(6000),
    }))
    // Assistant-first transcript: the leading turn can't be kept (only the
    // first USER turn is), and the marker must count it.
    const turns = [
      { role: 'assistant' as const, text: 'stray leading turn' },
      { role: 'user' as const, text: 'the goal' },
      ...filler,
    ]
    const { doc, omitted } = buildHandoffDoc({
      ...base,
      session: session({}),
      turns,
    })
    expect(doc).not.toContain('stray leading turn')
    const kept = (doc.match(/## Assistant/g) ?? []).length
    expect(omitted).toBe(turns.length - 1 - kept)
  })
})

describe('pointerPrompt', () => {
  test('leads with the source and title', () => {
    const prompt = pointerPrompt({
      docPath: '/x/handoffs/doc.md',
      session: session({ harness: 'claude', title: 'fix the auth bug' }),
    })
    expect(prompt).toBe(
      'Continuing a claude session — "fix the auth bug". The full conversation is in /x/handoffs/doc.md — read it, then pick up where it left off.',
    )
  })

  test('falls back to the session id when untitled', () => {
    const prompt = pointerPrompt({
      docPath: '/x/doc.md',
      session: session({ id: 'abcdef12-0000', title: '' }),
    })
    expect(prompt).toContain('(id abcdef12)')
  })
})

describe('writeHandoff', () => {
  let out: string
  let restoreConfigDir: () => void

  beforeEach(() => {
    out = path.join(tempDir(), 'eh')
    const configDirSpy = spyOn(config, 'configDir').mockReturnValue(out)
    restoreConfigDir = () => configDirSpy.mockRestore()
  })

  afterEach(() => restoreConfigDir())

  test('extracts, writes, and returns the pointer', async () => {
    const roots = fakeHome()
    const source = writeGrokHistory(roots.grok, CWD, 'uuid-9', [
      {
        content: [
          { text: '<user_query>hello grok</user_query>', type: 'text' },
        ],
        synthetic_reason: null,
        type: 'user',
      },
      { content: 'hi there', type: 'assistant' },
    ])
    const result = await writeHandoff({
      cwd: CWD,
      session: session({ harness: 'grok', source }),
      target: 'claude',
    })
    expect(result.turns).toBe(2)
    expect(result.omitted).toBe(0)
    const doc = readFileSync(result.docPath, 'utf8')
    expect(doc).toContain('hello grok')
    expect(doc).toContain('hi there')
    expect(result.prompt).toContain(result.docPath)
    expect(path.dirname(result.docPath)).toBe(path.join(out, 'handoffs'))
    expect(statSync(result.docPath).mode & 0o777).toBe(0o600)
  })

  test('throws when the transcript yields no turns', async () => {
    const roots = fakeHome()
    const source = writeGrokHistory(roots.grok, CWD, 'uuid-8', [])
    const error: unknown = await writeHandoff({
      cwd: CWD,
      session: session({ harness: 'grok', source }),
      target: 'claude',
    }).catch((e: unknown) => e)
    if (!(error instanceof Error)) {
      throw new Error('expected writeHandoff to throw')
    }
    expect(error.message).toContain("couldn't extract any conversation")
  })

  test('prunes the oldest docs beyond the cap', async () => {
    const roots = fakeHome()
    const source = writeGrokHistory(roots.grok, CWD, 'uuid-7', [
      {
        content: [{ text: '<user_query>hi</user_query>', type: 'text' }],
        synthetic_reason: null,
        type: 'user',
      },
    ])
    const handoffs = path.join(out, 'handoffs')
    mkdirSync(handoffs, { recursive: true })
    for (let i = 0; i < 20; i++) {
      const file = path.join(handoffs, `old-${String(i).padStart(2, '0')}.md`)
      writeFileSync(file, 'old')
      const mtime = new Date(T1.getTime() + i * 1000)
      utimesSync(file, mtime, mtime)
    }
    const result = await writeHandoff({
      cwd: CWD,
      session: session({ harness: 'grok', source }),
      target: 'claude',
    })
    const retained = readdirSync(handoffs).filter((f) => f.endsWith('.md'))
    expect(retained).toHaveLength(20)
    expect(retained).not.toContain('old-00.md')
    expect(retained).toContain(path.basename(result.docPath))
  })
})

describe('seedArgs', () => {
  test('grok sends the prompt verbatim; claude/codex positional', () => {
    expect(HARNESSES.grok.seedArgs('p')).toEqual(['--verbatim', 'p'])
    expect(HARNESSES.claude.seedArgs('p')).toEqual(['p'])
    expect(HARNESSES.codex.seedArgs('p')).toEqual(['p'])
  })

  test('buildLaunchPlan rejects resume + seedPrompt together', async () => {
    const provider = {
      baseURL: 'http://localhost:11434',
      name: 'ollama',
      type: 'ollama' as const,
    }
    const error: unknown = await buildLaunchPlan('grok', provider, 'm', {
      resume: true,
      seedPrompt: 'x',
    }).catch((e: unknown) => e)
    if (!(error instanceof Error)) {
      throw new Error('expected buildLaunchPlan to throw')
    }
    expect(error.message).toContain('mutually exclusive')
  })
})
