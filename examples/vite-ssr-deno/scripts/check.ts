/**
 * Type-checks the sources with Deno, builds the server and checks the output (CI runs this with
 * `pnpm check`): npm: and jsr: imports stay external, pinned to the versions in deno.lock;
 * dist/server.js runs under `deno run --cached-only` and answers a request; the dev server loads
 * the app too.
 */
import assert from 'node:assert/strict'
import { execFileSync, execSync, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, createServer } from 'vite'

const root = fileURLToPath(new URL('..', import.meta.url))

// In the unplugin-deno repository the plugin is a workspace package: build it once after a fresh
// clone. Installed from npm it is already built, and this does nothing.
const plugin = dirname(fileURLToPath(import.meta.resolve('unplugin-deno/package.json')))
if (!existsSync(join(plugin, 'dist')) && existsSync(join(plugin, 'tsdown.config.ts'))) {
  execSync('pnpm --filter unplugin-deno build', { stdio: 'inherit' })
}

// The sources are Deno code: type-check them with Deno.
execFileSync('deno', ['check', 'src/server.ts'], { cwd: root, stdio: 'inherit' })

await build({ root, logLevel: 'warn' })

const lock = JSON.parse(readFileSync(join(root, 'deno.lock'), 'utf8'))
const hono = lock.specifiers['npm:hono@4']
const fmt = lock.specifiers['jsr:@std/fmt@1']
const server = readFileSync(join(root, 'dist', 'server.js'), 'utf8')
const imports = [...server.matchAll(/^import .* from "([^"]+)";$/gm)].map((match) => match[1])
assert.deepEqual(imports.toSorted(), [
  `jsr:@std/fmt@${fmt}/duration`,
  'node:os',
  `npm:hono@${hono}`,
  `npm:hono@${hono}/html`,
])
console.log(`externals: ${imports.join(', ')}`)

/** A free TCP port on localhost. */
async function freePort(): Promise<number> {
  const probe = createNetServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as { port: number }
  await new Promise((resolve) => probe.close(resolve))
  return port
}

const port = await freePort()
const deno = spawn('deno', ['run', '-A', '--cached-only', 'dist/server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(port), NO_COLOR: '1' },
  stdio: ['ignore', 'inherit', 'inherit'],
})
const exited = new Promise((_, reject) => {
  deno.on('error', reject)
  deno.on('exit', (code) => reject(new Error(`deno exited with code ${code}`)))
})
try {
  const status = await Promise.race([waitForJson(`http://127.0.0.1:${port}/api/status`), exited])
  assert.equal(status.greeting, 'Hello from a Vite build running on Deno!')
  const page = await (await fetch(`http://127.0.0.1:${port}/`)).text()
  assert.match(page, /<h1>Hello from a Vite build running on Deno!<\/h1>/)
  console.log(`deno run: ${JSON.stringify(status)}`)
} finally {
  deno.kill()
}

/** Fetches `url` until the server answers (at most 30 s). */
async function waitForJson(url: string): Promise<{ greeting: string; uptime: string }> {
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      const response = await fetch(url)
      assert.equal(response.status, 200)
      return await response.json()
    } catch (error) {
      if (Date.now() > deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}

// The same app through Vite's dev server (SSR in Node: npm: and jsr: are bundled there).
const dev = await createServer({
  root,
  logLevel: 'warn',
  appType: 'custom',
  server: { middlewareMode: true, ws: false },
})
try {
  const { app } = await dev.ssrLoadModule('/src/app.ts')
  const response = await app.request('/api/status')
  assert.equal(response.status, 200)
  const { greeting } = await response.json()
  assert.equal(greeting, 'Hello from a Vite build running on Deno!')
  console.log('dev ssrLoadModule: ok')
} finally {
  await dev.close()
}
