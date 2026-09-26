/**
 * Type-checks the sources with Deno, builds the app and checks the output (CI runs this with
 * `pnpm check`): the bundle is evaluated against a tiny DOM stand-in, then the dev server serves
 * the entry with prebundled dependencies.
 */
import assert from 'node:assert/strict'
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build, createServer } from 'vite'

const root = fileURLToPath(new URL('..', import.meta.url))

// In the unplugin-deno repository the plugin is a workspace package: build it once after a fresh
// clone. Installed from npm it is already built, and this does nothing.
const plugin = dirname(fileURLToPath(import.meta.resolve('unplugin-deno/package.json')))
if (!existsSync(join(plugin, 'dist')) && existsSync(join(plugin, 'tsdown.config.ts'))) {
  execSync('pnpm --filter unplugin-deno build', { stdio: 'inherit' })
}

// The sources are Deno code: type-check them with Deno.
execFileSync('deno', ['check', 'src/main.ts', 'src/post.ts'], { cwd: root, stdio: 'inherit' })

await build({ root, logLevel: 'warn' })

const assets = join(root, 'dist', 'assets')
const script = readdirSync(assets).find((file) => file.endsWith('.js'))
assert(script, 'no JavaScript in dist/assets')
assert(
  readdirSync(assets).some((file) => file.endsWith('.css')),
  'style.css was not emitted',
)
const code = readFileSync(join(assets, script), 'utf8')
assert.doesNotMatch(code, /["'`](?:jsr:|npm:|https:\/\/deno\.land)/, 'a Deno specifier was left in')

/** Just enough of an element for `main.ts`. */
class FakeElement {
  innerHTML = ''
  value = ''
  readonly listeners = new Map<string, () => void>()
  readonly #found = new Map<string, FakeElement>()

  querySelector(selector: string): FakeElement {
    const element = this.#found.get(selector) ?? new FakeElement()
    this.#found.set(selector, element)
    return element
  }

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, listener)
  }
}

const app = new FakeElement()
const title = app.querySelector('[name=title]')
const topic = app.querySelector('[name=topic]')
const output = app.querySelector('output')
title.value = 'Hello, Deno & Vite!'
topic.value = 'vitte'
Object.assign(globalThis, {
  document: {
    querySelector: () => app,
    // Vite's modulepreload polyfill asks for this.
    createElement: () => ({ relList: { supports: () => true } }),
  },
})
await import(pathToFileURL(join(assets, script)).href)

assert.match(app.innerHTML, /<svg /, 'the ?raw logo is missing')
assert.match(app.innerHTML, /<option value="import maps">/, 'the topics are missing')
assert.match(
  output.innerHTML,
  /^<code>\/posts\/hello-deno-vite-[0-9a-z]{6}<\/code> filed under <strong>vite<\/strong>$/,
)
topic.value = 'tpyescript'
topic.listeners.get('input')?.()
assert.match(output.innerHTML, /filed under <strong>typescript<\/strong>$/)
console.log(`build: ${output.innerHTML}`)

const server = await createServer({ root, logLevel: 'warn', server: { port: 0 } })
try {
  await server.listen()
  const base = server.resolvedUrls?.local[0]
  assert(base, 'the dev server has no URL')
  const post = await fetch(new URL('src/post.ts', base))
  assert.equal(post.status, 200)
  const imports = [...(await post.text()).matchAll(/from "([^"]+)"/g)].map((match) => match[1]!)
  const prebundled = imports.filter((url) => url.startsWith('/node_modules/.vite/deps/'))
  assert.equal(prebundled.length, 3, `expected three prebundled imports: ${imports.join(', ')}`)
  for (const url of prebundled) {
    assert.equal((await fetch(new URL(url, base))).status, 200, url)
  }
  console.log(`dev: ${prebundled.map((url) => url.replace(/\?.*$/, '')).join(', ')}`)
} finally {
  await server.close()
}
