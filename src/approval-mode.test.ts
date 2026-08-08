import { describe, expect, test } from 'bun:test'

import { approvalArgsForHarness } from './approval-mode.js'

const APPROVAL_HARNESSES = [
  ['claude'],
  ['codex'],
  ['grok'],
  ['opencode'],
  ['pi'],
] as const

describe('approvalArgsForHarness', () => {
  test.each([
    ['claude', ['--permission-mode', 'auto']],
    ['codex', ['--approve-for-me']],
    ['grok', ['--permission-mode', 'auto']],
    ['opencode', ['--auto']],
    ['pi', []],
  ] as const)('maps auto to %s native arguments', (harness, expected) => {
    expect(approvalArgsForHarness(harness, 'auto')).toEqual([...expected])
  })

  test.each(APPROVAL_HARNESSES)(
    'adds no approval arguments for %s in platform mode',
    (harness) => {
      expect(approvalArgsForHarness(harness, 'platform')).toEqual([])
      expect(approvalArgsForHarness(harness, undefined)).toEqual([])
    },
  )

  test('never maps auto to an unrestricted bypass', () => {
    const args = APPROVAL_HARNESSES.flatMap(([harness]) =>
      approvalArgsForHarness(harness, 'auto'),
    )

    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(args).not.toContain('--always-approve')
  })
})
