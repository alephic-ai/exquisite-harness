Repair verification report

- Resolved: Timed-out run reports success when the child traps SIGTERM and exits 0.
  Current `src/headless-run.ts` includes `timeout.fired` in `resultIsError`, and the existing exit-code guard converts an errored zero child exit into process exit code `1`.

Critical regression check: No data-loss, security, or production-crash regression was found in the verified timeout completion path.
