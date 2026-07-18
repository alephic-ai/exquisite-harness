// Single re-export site for clack's non-interactive output helpers. Modules
// outside src/ui/ import from here, so the UI library stays swappable and
// flag-driven paths never pull in prompt widgets (DESIGN.md "Stack").
export { intro, log, note, outro } from '@clack/prompts'
