/** The JavaScript runtime executing the tests. */
export type Runtime = 'node' | 'deno' | 'bun'

/** The runtime running this process (`pnpm test`, `pnpm test:deno`, `pnpm test:bun`). */
export const runtime: Runtime = 'Deno' in globalThis ? 'deno' : 'Bun' in globalThis ? 'bun' : 'node'
