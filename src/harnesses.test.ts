import { expect, test } from 'bun:test'

import {
  assertEffortAllowed,
  availableEfforts,
  buildLaunchPlan,
  getHarness,
} from './harnesses.js'

for (const effort of ['xhigh', 'max'] as const) {
  test(`passes Codex effort ${effort} through without downgrading it`, async () => {
    const plan = await buildLaunchPlan(
      'codex',
      {
        baseURL: 'http://localhost:11434',
        name: 'ollama',
        type: 'ollama',
      },
      'openai/gpt-5.6',
      { effort, statusline: false },
    )

    expect(plan.args).toContain(`model_reasoning_effort="${effort}"`)
    expect(plan.notes).toEqual([])
  })
}

test('intersects Claude efforts with the model list and keeps unknown models on the harness list', () => {
  const claude = getHarness('claude')
  const opencode = getHarness('opencode')
  expect(claude).toBeDefined()
  expect(opencode).toBeDefined()
  if (!claude || !opencode) return
  expect(availableEfforts(claude, ['low', 'medium', 'high', 'none'])).toEqual([
    'low',
    'medium',
    'high',
  ])
  expect(availableEfforts(claude, undefined)).toEqual([
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ])
  expect(availableEfforts(opencode, ['high'])).toEqual([])
  expect(availableEfforts(claude, [])).toEqual([])
})

test('rejects an explicit effort the model does not support', () => {
  expect(() => assertEffortAllowed('high', ['low', 'medium'])).toThrow(
    'effort "high" is not available for this model (available: auto, low, medium)',
  )
  expect(() => assertEffortAllowed('high', [])).toThrow(
    'effort is not available for this model',
  )
  expect(() => assertEffortAllowed('medium', ['low', 'medium'])).not.toThrow()
  expect(() => assertEffortAllowed('auto', ['low'])).not.toThrow()
})
