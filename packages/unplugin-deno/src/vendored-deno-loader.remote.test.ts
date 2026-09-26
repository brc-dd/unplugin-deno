/**
 * The vendored loader as Deno runs it from JSR: `mod.js` then has an `https:` URL, so it imports
 * `lib/rs_lib.js`, which imports `./rs_lib.wasm` as a module (vendor/deno-loader/NOTICE.md,
 * docs/architecture.md §4.2). The test serves `vendor/deno-loader/` over HTTP with the content
 * types JSR uses and imports it in a child `deno run`, which fetches the JavaScript and the wasm
 * and resolves the wasm's imports (`./rs_lib.internal.js`, `node:tty`) through its module graph.
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it, onTestFinished } from 'vitest'
import { denoDir, freshDenoDir } from '../test/helpers/deno-dir.js'
import { normalize } from '../test/helpers/normalize.js'
import { runtime } from '../test/helpers/runtime.js'
import { tempDir } from '../test/helpers/temp-dir.js'
import { tempProject } from '../test/helpers/temp-project.js'
import type { LoaderLogEvent } from './vendored-deno-loader.js'

const execFileAsync = promisify(execFile)

/** `vendor/deno-loader/`, ending with a separator. */
const vendorDir = fileURLToPath(new URL('../vendor/deno-loader/', import.meta.url))

/** Only JavaScript and Wasm are served (JSR sends `text/javascript` and `application/wasm`). */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.js': 'application/javascript',
  '.wasm': 'application/wasm',
}

/** A static HTTP server for `vendor/deno-loader/`. */
interface VendorServer extends AsyncDisposable {
  /** `http://127.0.0.1:<port>/` */
  readonly url: string
  readonly port: number
  /** The paths requested so far, in order. */
  readonly requests: string[]
  close(): Promise<void>
}

/** Serves `vendor/deno-loader/` on `127.0.0.1` (an ephemeral port). */
async function serveVendorDir(): Promise<VendorServer> {
  const requests: string[] = []
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)
    requests.push(path)
    const type = CONTENT_TYPES[extname(path)]
    const file = join(vendorDir, ...path.split('/'))
    if (type === undefined || !file.startsWith(vendorDir)) {
      response.writeHead(404).end()
      return
    }
    readFile(file).then(
      (body) => response.writeHead(200, { 'content-type': type }).end(body),
      () => response.writeHead(404).end(),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const close = (): Promise<void> =>
    new Promise((resolve) => {
      ;(server as { closeAllConnections?: () => void }).closeAllConnections?.()
      server.close(() => resolve())
    })
  return { url: `http://127.0.0.1:${port}/`, port, requests, close, [Symbol.asyncDispose]: close }
}

/** What the child script receives (embedded as JSON, which spares Windows argv quoting). */
interface ChildInput {
  /** The URL of `vendor/deno-loader/`. */
  base: string
  configPath: string
  main: string
  /** The test `DENO_DIR`, which keeps the fixture's packages between runs. */
  denoDir: string
  /** A URL the injected fetch serves. */
  url: string
}

/** What the child script prints. */
interface ChildOutput {
  wasmLoadingPath: string
  diagnostics: unknown[]
  stdPath: string
  kleur: string
  loaded: { kind: string; specifier: string; typeScript: boolean; code: string }
  remoteDiagnostics: unknown[]
  answer: string
  requests: string[]
  events: LoaderLogEvent[]
  consoleErrors: string[]
}

/**
 * Resolves and loads the `smoke-jsr-npm` fixture like the `loader` engine, then downloads a
 * module through the injected fetch into this process's own (empty) `DENO_DIR`: the patched
 * `helpers.js` and `hooks.js` on this path.
 */
const CHILD_SCRIPT = `
const { base, configPath, main, denoDir, url } = input
const ownDenoDir = Deno.env.get('DENO_DIR')
const consoleErrors = []
console.error = (...args) => consoleErrors.push(args.join(' '))
const mod = await import(new URL('mod.js', base).href)
const hooks = await import(new URL('hooks.js', base).href)
const events = []
hooks.setLogger((event) => events.push(event))
const decoder = new TextDecoder()

Deno.env.set('DENO_DIR', denoDir)
const loader = await new mod.Workspace({ configPath, platform: 'browser' }).createLoader()
const diagnostics = await loader.addEntrypoints([main])
const stdPath = loader.resolveSync('@std/path', main, mod.ResolutionMode.Import)
const kleur = loader.resolveSync('kleur', main, mod.ResolutionMode.Import)
const loaded = await loader.load(stdPath, mod.RequestedModuleType.Default)

Deno.env.set('DENO_DIR', ownDenoDir)
const requests = []
hooks.setFetch(async (specifier) => {
  requests.push(specifier)
  if (requests.length === 1) return new Response('busy', { status: 503 })
  return new Response('export const answer: number = 42\\n', {
    headers: { 'content-type': 'application/typescript' },
  })
})
const remote = await new mod.Workspace({ noConfig: true, noLock: true }).createLoader()
const remoteDiagnostics = await remote.addEntrypoints([url])
const answer = await remote.load(url, mod.RequestedModuleType.Default)

console.log(JSON.stringify({
  wasmLoadingPath: mod.wasmLoadingPath,
  diagnostics,
  stdPath,
  kleur,
  loaded: {
    kind: loaded.kind,
    specifier: loaded.specifier,
    typeScript: loaded.mediaType === mod.MediaType.TypeScript,
    code: decoder.decode(loaded.code),
  },
  remoteDiagnostics,
  answer: decoder.decode(answer.code),
  requests,
  events,
  consoleErrors,
}))
`

describe.runIf(runtime === 'deno')('vendored @deno/loader from an http: URL (Deno only)', () => {
  it(
    'imports the wasm as a module and resolves and loads through the patched glue',
    { timeout: 120_000 },
    async () => {
      const server = await serveVendorDir()
      onTestFinished(() => server.close())
      const project = await tempProject('smoke-jsr-npm')
      onTestFinished(() => project.dispose())
      // The child's own DENO_DIR: its module cache (the served files) and the fetch test's.
      const ownDenoDir = await freshDenoDir()
      onTestFinished(() => ownDenoDir.dispose())
      const url = 'https://example.test/answer.ts'
      const input: ChildInput = {
        base: server.url,
        configPath: project.path('deno.json'),
        main: project.url('src/main.ts'),
        denoDir: await denoDir(),
        url,
      }
      const script = await tempDir({
        'remote.mjs': `const input = ${JSON.stringify(input)}\n${CHILD_SCRIPT}`,
      })
      onTestFinished(() => script.dispose())

      // The permissions a JSR consumer's bundler needs anyway; importing from https://jsr.io
      // needs no flag (it is in Deno's default --allow-import list).
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          'run',
          '--no-config',
          '--no-prompt',
          `--allow-import=127.0.0.1:${server.port}`,
          '--allow-env',
          '--allow-read',
          '--allow-write',
          '--allow-net',
          script.path('remote.mjs'),
        ],
        {
          cwd: script.root,
          env: { ...process.env, DENO_DIR: ownDenoDir.path, NO_COLOR: '1' },
          maxBuffer: 16 * 1024 * 1024,
        },
      )
      const output = JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as ChildOutput

      expect(output.wasmLoadingPath).toBe('esm')
      // Deno fetched the Wasm ESM glue, the wasm and its imports over HTTP. (It prefetches
      // rs_lib_node.js too, a dynamic import of mod.js, but never evaluates it.)
      expect(server.requests).toEqual(
        expect.arrayContaining([
          '/mod.js',
          '/hooks.js',
          '/lib/rs_lib.js',
          '/lib/rs_lib.wasm',
          '/lib/rs_lib.internal.js',
        ]),
      )

      const expected = project.manifest.expect as { resolve: Record<string, string> }
      expect(output.diagnostics).toEqual([])
      expect(output.stdPath).toBe(expected.resolve['@std/path'])
      expect(normalize(output.kleur)).toBe(expected.resolve.kleur)
      expect(output.loaded).toMatchObject({
        kind: 'module',
        specifier: output.stdPath,
        typeScript: true,
      })
      expect(output.loaded.code).toContain('export * from "./join.ts"')

      expect(output.remoteDiagnostics).toEqual([])
      expect(output.answer).toContain('export const answer = 42')
      expect(output.requests).toEqual([url, url])
      expect(output.events).toContainEqual({ kind: 'download', url })
      expect(output.events).toContainEqual(
        expect.objectContaining({ kind: 'retry', url, attempt: 1, reason: 'HTTP 503' }),
      )
      expect(output.consoleErrors).toEqual([])
    },
  )
})
