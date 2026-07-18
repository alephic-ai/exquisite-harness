import { accessSync, constants } from 'node:fs'
import path from 'node:path'

export function findBin(bin: string) {
  // Windows executables carry extensions (.exe, .cmd, …) listed in PATHEXT;
  // X_OK is a no-op there, so existence is the check.
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
      : ['']
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const ext of extensions) {
      const candidate = path.join(dir, `${bin}${ext.toLowerCase()}`)
      try {
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        // not here
      }
    }
  }
  return undefined
}
