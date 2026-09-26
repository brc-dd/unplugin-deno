/**
 * One measured Vite run in a fresh process, spawned by bench.ts; prints one line of JSON.
 *
 * - `vite.ts build <root> <npm|deno>`: `{ ms, bytes }` for a production build (bytes of the
 *   JavaScript assets);
 * - `vite.ts dev <root> <npm|deno>`: `{ first, page, modules }`: the time until the dev server
 *   answered the request for `/src/main.ts`, and until that module and everything it imports
 *   (local modules, prebundled dependencies) were fetched, as a browser would.
 *
 * Times are in milliseconds from the start of this script (Vite and the plugin are loaded inside
 * the measured time).
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Static imports in served code (Vite writes them at the start of a line). */
const IMPORT =
  /^\s*(?:import\s*(?:[^'"\n]*?\bfrom\s*)?|export\s[^'"\n]*?\bfrom\s*)["']([^"']+)["']/gm

/**
 * Fetches `entry` and, wave by wave and in parallel like a browser, every module it imports
 * statically; returns the number of modules. `onEntry` runs when the entry has been received.
 */
async function crawl(entry: string, onEntry: () => void): Promise<number> {
  const seen = new Set([entry])
  let wave = [entry]
  while (wave.length > 0) {
    const codes = await Promise.all(
      wave.map(async (url) => {
        const response = await fetch(url)
        if (!response.ok) throw new Error(`${response.status} for ${url}`)
        const code = await response.text()
        if (url === entry) onEntry()
        return { url, code }
      }),
    )
    wave = []
    for (const { url, code } of codes) {
      for (const [, specifier = ''] of code.matchAll(IMPORT)) {
        if (!/^[./]/.test(specifier)) continue
        const next = new URL(specifier, url).href
        if (seen.has(next)) continue
        seen.add(next)
        wave.push(next)
      }
    }
  }
  return seen.size
}

const started = performance.now()
const [mode, root = '', variant] = process.argv.slice(2)
const vite = await import('vite')
const plugins = variant === 'deno' ? [(await import('unplugin-deno/vite')).default()] : []
const config = {
  root,
  configFile: false as const,
  logLevel: 'silent' as const,
  plugins,
  cacheDir: join(root, '.vite'),
}

if (mode === 'build') {
  await vite.build({
    ...config,
    build: { outDir: join(root, 'dist'), emptyOutDir: true, reportCompressedSize: false },
  })
  const ms = performance.now() - started
  const assets = join(root, 'dist', 'assets')
  const bytes = readdirSync(assets)
    .filter((file) => file.endsWith('.js'))
    .reduce((total, file) => total + statSync(join(assets, file)).size, 0)
  process.stdout.write(`${JSON.stringify({ ms, bytes })}\n`)
} else {
  const server = await vite.createServer({ ...config, server: { port: 0 } })
  try {
    await server.listen()
    const base = server.resolvedUrls?.local[0]
    if (base === undefined) throw new Error('the dev server has no URL')
    const entry = new URL('src/main.ts', base).href
    let first = 0
    const modules = await crawl(entry, () => {
      first = performance.now() - started
    })
    const page = performance.now() - started
    process.stdout.write(`${JSON.stringify({ first, page, modules })}\n`)
  } finally {
    await server.close()
  }
}
