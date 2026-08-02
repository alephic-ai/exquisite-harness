import { expect, test } from 'bun:test'

import { buildLaunchPlan } from './harnesses.js'

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
      { effort },
    )

    expect(plan.args).toContain(`model_reasoning_effort="${effort}"`)
    expect(plan.notes).toEqual([])
  })
}
