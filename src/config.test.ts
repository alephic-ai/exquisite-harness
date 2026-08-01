import { expect, test } from 'bun:test'

import { reservedProfileNameMessage } from './config.js'

test('run is a reserved profile name', () => {
  expect(reservedProfileNameMessage('run')).toBe(
    '"run" is a subcommand — pick another profile name',
  )
})
