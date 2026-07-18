// Single re-export site for clack's non-interactive output helpers. Modules
// outside src/ui/ import from here, so the UI library stays swappable and
// flag-driven paths never pull in prompt widgets (DESIGN.md "Stack"). The
// spinner counts as output, not a prompt: it animates status on a TTY and
// degrades to plain log lines when piped.
export { intro, log, note, outro, spinner } from '@clack/prompts'
