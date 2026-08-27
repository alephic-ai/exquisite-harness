import { renameSync, rmSync, writeFileSync } from 'node:fs'

// The staged temp must sit in the destination's directory: renameSync is only
// atomic within one filesystem.
export function atomicWriteFileSync(
  destination: string,
  data: string,
  options?: { mode?: number },
) {
  const staged = `${destination}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(staged, data, { mode: options?.mode })
    renameSync(staged, destination)
  } catch (error) {
    try {
      rmSync(staged, { force: true })
    } catch {
      // Cleanup is best-effort — never let it mask the original error.
    }
    throw error
  }
}
