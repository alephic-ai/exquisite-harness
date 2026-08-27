import { describe, expect, test } from 'bun:test'

import {
  CLACK_ALIAS_KEYS,
  HOTKEY_MAX_ROWS,
  hotkeyLetters,
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

  test('caps letters at HOTKEY_MAX_ROWS', () => {
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

  test('never hands out a letter clack already binds', () => {
    // Hotkey letters must not collide with clack's global key aliases
    // (j/k/h/l cursor movement, y/n confirm) — a keypress can't do two
    // things. a–e is clear today; this guardrail bites if the cap grows.
    for (let count = 1; count <= 26; count++) {
      const rows = Array.from({ length: count }, () => ({}))
      for (const letter of hotkeyLetters(rows)) {
        if (letter !== undefined) {
          expect(CLACK_ALIAS_KEYS.has(letter)).toBe(false)
        }
      }
    }
    expect(HOTKEY_MAX_ROWS).toBeLessThanOrEqual(5)
  })
})
