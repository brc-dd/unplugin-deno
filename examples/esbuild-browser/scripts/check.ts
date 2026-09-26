/**
 * Type-checks the sources with Deno, builds the bundle and checks it (CI runs this with
 * `pnpm check`): no Deno specifier is left, and the bundle renders Markdown when imported in this
 * runtime and under Deno.
 */
import assert from 'node:assert/strict'
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

// In the unplugin-deno repository the plugin is a workspace package: build it once after a fresh
// clone. Installed from npm it is already built, and this does nothing.
const plugin = dirname(fileURLToPath(import.meta.resolve('unplugin-deno/package.json')))
if (!existsSync(join(plugin, 'dist')) && existsSync(join(plugin, 'tsdown.config.ts'))) {
  execSync('pnpm --filter unplugin-deno build', { stdio: 'inherit' })
}

// The sources are Deno code: type-check them with Deno, each with its own deno.json.
execFileSync('deno', ['check', 'main.ts'], { cwd: join(root, 'browser'), stdio: 'inherit' })
execFileSync('deno', ['check', 'serve.ts'], { cwd: root, stdio: 'inherit' })

// Runs the build (build.ts bundles when it is not asked to serve).
await import('../build.ts')

const bundle = join(root, 'www', 'js', 'main.js')
const code = readFileSync(bundle, 'utf8')
assert.doesNotMatch(code, /["'`](?:jsr:|npm:|https:\/\/deno\.land)/, 'a Deno specifier was left in')

const markdown = '# Hello, Deno!\n\nSome *emphasis* and a [link](https://deno.com).'
const expected = {
  html:
    '<h1 id="hello-deno">Hello, Deno!</h1>\n' +
    '<p>Some <em>emphasis</em> and a <a href="https://deno.com">link</a>.</p>\n',
  readingTime: '3s',
}
const { preview } = await import(pathToFileURL(bundle).href)
assert.deepEqual(preview(markdown), expected)
console.log(`${process.versions.deno ? 'deno' : 'node'}: ${JSON.stringify(expected)}`)

const script = `
  const { preview } = await import('./www/js/main.js')
  console.log(JSON.stringify(preview(${JSON.stringify(markdown)})))
`
const output = execFileSync('deno', ['eval', script], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, NO_COLOR: '1' },
})
assert.deepEqual(JSON.parse(output), expected)
console.log(`deno: ${output.trim()}`)
