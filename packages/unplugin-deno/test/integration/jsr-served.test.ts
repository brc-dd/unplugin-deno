/**
 * The built package as Deno runs it from JSR: `dist/` and `vendor/` are served over HTTP with the
 * content types JSR uses, and a child `deno run` imports a host entry by URL, bundles the
 * `smoke-jsr-npm` fixture with Rolldown and reports the chunk. This covers what `deno publish
 * --dry-run` cannot: the vendored loader's remote wasm path (`vendor/deno-loader/NOTICE.md`) and
 * the absence of module-load-time `file:`-only APIs in the shared chunks. The package's own
 * `deno.json` supplies the import map for the bare npm dependencies (JSR rewrites those imports
 * when publishing).
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it, onTestFinished } from 'vitest'
import { denoDir } from '../helpers/deno-dir.js'
import { runtime } from '../helpers/runtime.js'
import { tempDir } from '../helpers/temp-dir.js'
import { tempProject } from '../helpers/temp-project.js'

const execFileAsync = promisify(execFile)

/** The package root (`packages/unplugin-deno/`), ending with a separator. */
const packageDir = fileURLToPath(new URL('../../', import.meta.url))

/** JSR serves JavaScript as `text/javascript` and wasm as `application/wasm`. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
}

interface PackageServer extends AsyncDisposable {
  readonly url: string
  readonly requests: string[]
}

/** Serves `dist/` and `vendor/` of the package on an ephemeral `127.0.0.1` port. */
async function servePackage(): Promise<PackageServer> {
  const requests: string[] = []
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)
    requests.push(path)
    const type = CONTENT_TYPES[extname(path)]
    const file = join(packageDir, ...path.split('/'))
    const served = path.startsWith('/dist/') || path.startsWith('/vendor/')
    if (type === undefined || !served || !file.startsWith(packageDir)) {
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
  if (address === null || typeof address === 'string') throw new Error('no server address')
  const close = (): Promise<void> =>
    new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return { url: `http://127.0.0.1:${address.port}/`, requests, [Symbol.asyncDispose]: close }
}

const built = existsSync(join(packageDir, 'dist', 'rolldown.js'))

describe.skipIf(runtime !== 'deno' || !built)(
  `the package served like JSR (${runtime !== 'deno' ? 'Deno only' : built ? 'Deno' : 'needs pnpm build'})`,
  () => {
    it(
      'bundles a project with Rolldown from a host entry imported by URL',
      { timeout: 300_000 },
      async () => {
        const server = await servePackage()
        onTestFinished(() => server[Symbol.asyncDispose]())
        const project = await tempProject('smoke-jsr-npm')
        onTestFinished(() => project.dispose())
        const scripts = await tempDir({})
        onTestFinished(() => scripts[Symbol.asyncDispose]())
        const script = scripts.path('build.ts')
        await writeFile(
          script,
          [
            `import deno from ${JSON.stringify(`${server.url}dist/rolldown.js`)}`,
            "import { rolldown } from 'npm:rolldown@^1.2'",
            `const cwd = ${JSON.stringify(project.root)}`,
            'const bundle = await rolldown({',
            "  cwd, input: 'src/main.ts', platform: 'node', logLevel: 'silent',",
            "  plugins: [deno({ platform: 'node' })],",
            '})',
            "const { output } = await bundle.generate({ format: 'esm' })",
            'const chunk = output[0]',
            'console.log(JSON.stringify({ length: chunk.code.length, imports: chunk.imports, moduleIds: chunk.moduleIds }))',
            '',
          ].join('\n'),
        )
        const { stdout } = await execFileAsync(
          'deno',
          ['run', '-A', '--no-prompt', '--config', join(packageDir, 'deno.json'), script],
          {
            cwd: project.root,
            env: {
              ...process.env,
              DENO_DIR: await denoDir(),
              NO_COLOR: '1',
              DENO_NO_UPDATE_CHECK: '1',
            },
            maxBuffer: 64 * 1024 * 1024,
          },
        )
        const result = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as {
          length: number
          imports: string[]
          moduleIds: string[]
        }
        expect(result.length).toBeGreaterThan(500)
        expect(result.imports.filter((id) => /^(?:jsr|npm|https?):/.test(id))).toEqual([])
        // Module ids are OS paths (mirror files under node_modules/.unplugin-deno); `\` on Windows.
        const moduleIds = result.moduleIds.map((id) => id.replaceAll('\\', '/'))
        expect(moduleIds.some((id) => id.includes('jsr.io/@std/path'))).toBe(true)
        expect(moduleIds.some((id) => /kleur/.test(id))).toBe(true)
        // The host entry, its shared chunks and the vendored loader (with the wasm) came over HTTP.
        expect(server.requests).toContain('/dist/rolldown.js')
        expect(server.requests.some((path) => /^\/dist\/plugin-.*\.js$/.test(path))).toBe(true)
        expect(server.requests).toContain('/vendor/deno-loader/mod.js')
        expect(server.requests).toContain('/vendor/deno-loader/lib/rs_lib.wasm')
      },
    )
  },
)
