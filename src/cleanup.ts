export async function withCleanup<T>(
  cleanup: (() => Promise<void>) | undefined,
  run: () => Promise<T>,
) {
  let runFailed = false
  try {
    return await run()
  } catch (error) {
    runFailed = true
    throw error
  } finally {
    if (runFailed) {
      try {
        await cleanup?.()
      } catch {
        // Preserve the operation failure.
      }
    } else {
      await cleanup?.()
    }
  }
}
