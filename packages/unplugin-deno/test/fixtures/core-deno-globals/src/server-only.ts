/** Server code that reached a browser bundle. */
export function cwd(): string {
  return Deno.cwd()
}

export const kv: Deno.Kv | null = null
