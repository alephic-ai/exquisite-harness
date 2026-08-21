import { describe, expect, test } from 'bun:test'

import { permissionArgsForHarness } from './permission-posture.js'

const PERMISSION_HARNESSES = [
  ['claude'],
  ['codex'],
  ['grok'],
  ['opencode'],
  ['pi'],
] as const

describe('permissionArgsForHarness', () => {
  test.each([
    ['claude', ['--permission-mode', 'plan']],
    ['grok', ['--permission-mode', 'plan']],
    ['codex', ['--sandbox', 'read-only']],
    ['pi', ['--tools', 'read,grep,find,ls']],
    ['opencode', ['--agent', 'plan']],
  ] as const)(
    'maps read-only to %s native arguments (platform approval)',
    (harness, expected) => {
      expect(
        permissionArgsForHarness(harness, {
          approvalMode: 'platform',
          readOnly: true,
        }),
      ).toEqual([...expected])
    },
  )

  test('read-only suppresses colliding approval args (claude, codex)', () => {
    expect(
      permissionArgsForHarness('claude', {
        approvalMode: 'auto',
        readOnly: true,
      }),
    ).toEqual(['--permission-mode', 'plan'])
    expect(
      permissionArgsForHarness('codex', {
        approvalMode: 'auto',
        readOnly: true,
      }),
    ).toEqual(['--sandbox', 'read-only'])
  })

  test('opencode read-only composes with the auto approval default', () => {
    expect(
      permissionArgsForHarness('opencode', {
        approvalMode: 'auto',
        readOnly: true,
      }),
    ).toEqual(['--agent', 'plan', '--auto'])
  })

  test.each(PERMISSION_HARNESSES)(
    'never leaves %s silently unrestricted under read-only',
    (harness) => {
      expect(
        permissionArgsForHarness(harness, {
          approvalMode: 'platform',
          readOnly: true,
        }).length,
      ).toBeGreaterThan(0)
    },
  )

  test('refuses to launch a read-only lane for a harness with no mechanism', () => {
    expect(() =>
      permissionArgsForHarness(
        // @ts-expect-error a harness outside the union exercises the refuse-to-launch guard
        'futureharness',
        { approvalMode: undefined, readOnly: true },
      ),
    ).toThrow(/no read-only mechanism/)
  })

  test('never maps read-only to an unrestricted bypass', () => {
    const args = PERMISSION_HARNESSES.flatMap(([harness]) =>
      permissionArgsForHarness(harness, {
        approvalMode: 'auto',
        readOnly: true,
      }),
    )

    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(args).not.toContain('--always-approve')
  })

  test('delegates to approval mapping when not read-only', () => {
    expect(
      permissionArgsForHarness('codex', {
        approvalMode: 'auto',
        readOnly: false,
      }),
    ).toEqual(['--approve-for-me'])
  })
})
