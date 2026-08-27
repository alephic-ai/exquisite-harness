import { describe, expect, test } from 'bun:test'

import {
  CLACK_RESERVED_KEYS,
  HOTKEY_MAX_ROWS,
  hotkeyLetters,
  summarizeHotkeys,
} from './letter-select.js'

describe('hotkeyLetters', () => {
  test('assigns sequential letters', () => {
    expect(hotkeyLetters([{}, {}, {}])).toEqual(['a', 'b', 'c'])
  })

  test('skips disabled rows without consuming a letter', () => {
    expect(hotkeyLetters([{}, { disabled: true }, {}])).toEqual([
      'a',
      undefined,
      'b',
    ])
  })

  test('caps auto letters at HOTKEY_MAX_ROWS', () => {
    const rows = Array.from({ length: 7 }, () => ({}))
    expect(hotkeyLetters(rows)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      undefined,
      undefined,
    ])
  })

  test('honors an explicit hotkey without consuming an auto letter', () => {
    expect(hotkeyLetters([{}, { hotkey: 'n' }, {}])).toEqual(['a', 'n', 'b'])
  })

  test('auto letters skip letters an explicit hotkey claimed', () => {
    expect(hotkeyLetters([{ hotkey: 'b' }, {}, {}])).toEqual(['b', 'a', 'c'])
  })

  test('normalizes an uppercase hotkey', () => {
    expect(hotkeyLetters([{ hotkey: 'N' }])).toEqual(['n'])
  })

  test('gives a disabled explicit-hotkey row no letter but still claims it', () => {
    expect(
      hotkeyLetters([{ disabled: true, hotkey: 'a' }, { hotkey: 'n' }, {}]),
    ).toEqual([undefined, 'n', 'b'])
  })

  test('an explicit hotkey past the auto rows still gets its letter', () => {
    const rows = [...Array.from({ length: 5 }, () => ({})), { hotkey: 'n' }]
    expect(hotkeyLetters(rows)).toEqual(['a', 'b', 'c', 'd', 'e', 'n'])
  })

  test('rejects a reserved key, a duplicate, and a non-letter', () => {
    for (const hotkey of ['j', 'y', 'a)']) {
      expect(() => hotkeyLetters([{ hotkey }])).toThrow()
    }
    expect(() => hotkeyLetters([{ hotkey: 'n' }, { hotkey: 'n' }])).toThrow()
  })

  test('never hands out a letter clack already binds', () => {
    // Auto hotkey letters must not collide with clack's global key bindings
    // (j/k/h/l cursor movement, y confirm) — a keypress can't do two things.
    // a–e is clear today; this guardrail bites if the cap grows.
    for (let count = 1; count <= 26; count++) {
      const rows = Array.from({ length: count }, () => ({}))
      for (const letter of hotkeyLetters(rows)) {
        if (letter !== undefined) {
          expect(CLACK_RESERVED_KEYS.has(letter)).toBe(false)
        }
      }
    }
    expect(HOTKEY_MAX_ROWS).toBeLessThanOrEqual(5)
  })
})

describe('summarizeHotkeys', () => {
  test('compresses contiguous runs into ranges', () => {
    expect(
      summarizeHotkeys(['a', 'b', 'c', 'd', 'e', 'n', 'p', 'd', 'o']),
    ).toBe('a–e, n, p, d, o')
  })

  test('lists isolated letters individually', () => {
    expect(summarizeHotkeys(['a', 'c', 'e'])).toBe('a, c, e')
  })

  test('handles a single letter and a two-letter run', () => {
    expect(summarizeHotkeys(['n'])).toBe('n')
    expect(summarizeHotkeys(['a', 'b', 'n'])).toBe('a–b, n')
  })
})
