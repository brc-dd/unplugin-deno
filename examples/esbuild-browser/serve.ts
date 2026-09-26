import { serveDir } from '@std/http/file-server'

// Serves the page and the bundle that build.ts writes to www/js (run `pnpm build` first).
Deno.serve({ port: Number(Deno.env.get('PORT') ?? 8000) }, (request) =>
  serveDir(request, { fsRoot: `${import.meta.dirname}/www`, quiet: true }),
)
