export const values = {
  greeting: Deno.env.get('PUBLIC_GREETING'),
  target: process.env.PUBLIC_TARGET,
  bracket: process.env['PUBLIC_GREETING'],
  local: Deno.env.get('PUBLIC_LOCAL'),
  missing: Deno.env.get('PUBLIC_MISSING') ?? 'unset',
}

/** A variable no prefix allows: read at runtime. */
export function secret(): string | undefined {
  return Deno.env.get('SECRET')
}

/** Not a literal-key read: left alone. */
export function all(): Record<string, string> {
  return Deno.env.toObject()
}

/** Reads app.env's variable (a build with `env.files: ['app.env']`). */
export function fromFile(): string | undefined {
  return process.env.PUBLIC_FROM_FILE
}
