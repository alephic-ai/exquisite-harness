import { expect, test } from 'bun:test'

import { withCleanup } from './cleanup.js'

test('preserves an operation failure when cleanup also fails', async () => {
  let message = ''
  try {
    await withCleanup(
      async () => {
        await Promise.resolve()
        throw new Error('cleanup failed')
      },
      async () => {
        await Promise.resolve()
        throw new Error('operation failed')
      },
    )
  } catch (error) {
    message = errorMessage(error)
  }
  expect(message).toBe('operation failed')
})

test('surfaces a cleanup failure after a successful operation', async () => {
  let message = ''
  try {
    await withCleanup(
      async () => {
        await Promise.resolve()
        throw new Error('cleanup failed')
      },
      async () => {
        await Promise.resolve()
      },
    )
  } catch (error) {
    message = errorMessage(error)
  }
  expect(message).toBe('cleanup failed')
})

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
