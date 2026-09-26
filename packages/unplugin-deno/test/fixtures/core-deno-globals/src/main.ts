import { cwd } from './server-only.ts'

// Deno.exit() in a comment is not a use.
const note = 'Deno.exit() in a string is not a use'

export const values = {
  note,
  hasDeno: typeof Deno !== 'undefined',
  cwd: typeof cwd,
}
