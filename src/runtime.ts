// `IS_BUNDLE` is a build-time constant injected by build.ts via Bun's
// `define`, but only in the compiled `eh` binary. In dev (tsx) it is never
// defined. See https://bun.com/docs/bundler/executables#build-time-constants
declare const IS_BUNDLE: boolean | undefined

// True only inside the compiled standalone binary — gates `eh update`, which
// must never try to overwrite the tsx/node runtime when running from source.
export function isStandaloneBinary() {
  return typeof IS_BUNDLE !== 'undefined' && IS_BUNDLE
}
