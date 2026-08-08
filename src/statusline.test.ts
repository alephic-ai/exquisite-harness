import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { formatStatuslineCost, sessionCostUsd } from './pricing.js'
import { statuslineEnv, sumTranscriptUsage } from './statusline.js'

const tempDirs: string[] = []

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true })
})

function assistantLine(id: string | undefined, usage: Record<string, number>) {
  return JSON.stringify({
    message: { ...(id ? { id } : {}), usage },
    type: 'assistant',
  })
}

function writeTranscript(lines: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), 'eh-test-'))
  tempDirs.push(dir)
  const file = path.join(dir, 'transcript.jsonl')
  writeFileSync(file, `${lines.join('\n')}\n`)
  return file
}

describe('sumTranscriptUsage', () => {
  // Regression: Claude Code writes one line per content block
  // (thinking/text/tool_use), each stamped with the full usage object — an
  // undeduped sum multiplies session cost by ~3-5x.
  test('counts each assistant message once across content-block lines', async () => {
    const usage = {
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 5000,
      input_tokens: 1000,
      output_tokens: 100,
    }
    const file = writeTranscript([
      assistantLine('msg_1', usage),
      assistantLine('msg_1', usage),
      assistantLine('msg_1', usage),
      assistantLine('msg_2', { input_tokens: 500, output_tokens: 50 }),
    ])
    expect(await sumTranscriptUsage(file)).toEqual({
      cacheRead: 5000,
      cacheWrite: 200,
      input: 1500,
      output: 150,
    })
  })

  test('keeps the final cumulative usage for repeated message rows', async () => {
    const file = writeTranscript([
      assistantLine('msg_1', {
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 5000,
        input_tokens: 1000,
        output_tokens: 3,
      }),
      assistantLine('msg_1', {
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 5000,
        input_tokens: 1000,
        output_tokens: 100,
      }),
    ])
    expect(await sumTranscriptUsage(file)).toEqual({
      cacheRead: 5000,
      cacheWrite: 200,
      input: 1000,
      output: 100,
    })
  })

  // Dedup keys on message id — id-less lines must not collapse into each other.
  test('counts usage lines without a message id', async () => {
    const file = writeTranscript([
      assistantLine(undefined, { input_tokens: 10, output_tokens: 1 }),
      assistantLine(undefined, { input_tokens: 5, output_tokens: 2 }),
    ])
    expect(await sumTranscriptUsage(file)).toEqual({
      cacheRead: 0,
      cacheWrite: 0,
      input: 15,
      output: 3,
    })
  })

  // The transcript can be deleted or rotated mid-session — the bar must not
  // crash, just show zero usage.
  test('missing transcript yields zeros', async () => {
    expect(await sumTranscriptUsage('/nonexistent/nope.jsonl')).toEqual({
      cacheRead: 0,
      cacheWrite: 0,
      input: 0,
      output: 0,
    })
  })
})

describe('sessionCostUsd', () => {
  // Fixed arithmetic fixture; these are not asserted as current provider rates.
  const rates = {
    cacheReadPerMillion: 0.3,
    inputPerMillion: 3,
    outputPerMillion: 15,
  }

  test('applies per-million rates including cache pricing', () => {
    expect(
      sessionCostUsd(rates, {
        cacheRead: 86272,
        cacheWrite: 0,
        input: 34288,
        output: 2434,
      }),
    ).toBe('$0.17')
  })

  test('does not invent cache prices when the provider omits them', () => {
    const noCacheRates = { inputPerMillion: 10, outputPerMillion: 30 }
    expect(
      sessionCostUsd(noCacheRates, {
        cacheRead: 1_000_000,
        cacheWrite: 1_000_000,
        input: 1_000_000,
        output: 1_000_000,
      }),
    ).toBeUndefined()
  })
})

describe('formatStatuslineCost', () => {
  test('distinguishes exact, partial, estimated, free, and unavailable costs', () => {
    expect(
      formatStatuslineCost({
        capturedCost: { exact: true, total: '0.0012300' },
        captureExpected: true,
        estimatedCost: '$9.99',
        rates: { inputPerMillion: 1, outputPerMillion: 2 },
      }),
    ).toBe('$0.0012300')
    expect(
      formatStatuslineCost({
        capturedCost: { exact: false, total: '0.0012300' },
        captureExpected: true,
        estimatedCost: '$9.99',
        rates: { inputPerMillion: 1, outputPerMillion: 2 },
      }),
    ).toBe('~$0.0012300')
    expect(
      formatStatuslineCost({
        capturedCost: undefined,
        captureExpected: false,
        estimatedCost: '$0',
        rates: { inputPerMillion: 1, outputPerMillion: 2 },
      }),
    ).toBe('~$0')
    expect(
      formatStatuslineCost({
        capturedCost: undefined,
        captureExpected: false,
        estimatedCost: '$0',
        rates: { inputPerMillion: 0, outputPerMillion: 0 },
      }),
    ).toBe('$0')
    expect(
      formatStatuslineCost({
        capturedCost: undefined,
        captureExpected: true,
        estimatedCost: '$0.01',
        rates: { inputPerMillion: 1, outputPerMillion: 2 },
      }),
    ).toBe('—')
  })
})

describe('statuslineEnv', () => {
  test('gives Claude Code the provider context window', () => {
    expect(
      statuslineEnv({
        contextWindow: 256_000,
        model: 'alibaba/qwen-3-235b',
        provider: 'vercel-ai-gateway',
        rateLabel: undefined,
        rates: undefined,
      }),
    ).toMatchObject({
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '256000',
      EH_CONTEXT_WINDOW: '256000',
    })
  })
})
