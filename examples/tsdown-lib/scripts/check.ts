/**
 * Type-checks the sources with Deno, builds the library and checks both outputs (CI runs this
 * with `pnpm check`): dist/deno keeps
 * `npm:ms` as an import pinned to the version in deno.lock and bundles jsr:@std/fmt; dist/browser
 * bundles both. The browser build is imported in this runtime, both builds under Deno.
 */
import assert from 'node:assert/strict'
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'tsdown'

const root = fileURLToPath(new URL('..', import.meta.url))

// In the unplugin-deno repository the plugin is a workspace package: build it once after a fresh
// clone. Installed from npm it is already built, and this does nothing.
const plugin = dirname(fileURLToPath(import.meta.resolve('unplugin-deno/package.json')))
if (!existsSync(join(plugin, 'dist')) && existsSync(join(plugin, 'tsdown.config.ts'))) {
  execSync('pnpm --filter unplugin-deno build', { stdio: 'inherit' })
}

// The sources are Deno code: type-check them with Deno.
execFileSync('deno', ['check', 'src/mod.ts'], { cwd: root, stdio: 'inherit' })

await build({ cwd: root, config: join(root, 'tsdown.config.ts'), logLevel: 'warn' })

const lock = JSON.parse(readFileSync(join(root, 'deno.lock'), 'utf8'))
const imports = (file: string): string[] =>
  [...readFileSync(join(root, file), 'utf8').matchAll(/^import .* from "([^"]+)";$/gm)].map(
    (match) => match[1]!,
  )
assert.deepEqual(imports('dist/deno/mod.js'), [`npm:ms@${lock.specifiers['npm:ms@2']}`])
assert.deepEqual(imports('dist/browser/mod.js'), [])

const expected = ['1h 30m', '1d 12h', '250ms']
const { humanize } = await import(pathToFileURL(join(root, 'dist/browser/mod.js')).href)
assert.deepEqual(['90m', '1.5 days', '250ms'].map(humanize), expected)
console.log(`${process.versions.deno ? 'deno' : 'node'} (dist/browser): ${expected.join(', ')}`)

const script = `
  for (const build of ['deno', 'browser']) {
    const { humanize } = await import(\`./dist/\${build}/mod.js\`)
    console.log(JSON.stringify(['90m', '1.5 days', '250ms'].map(humanize)))
  }
`
const output = execFileSync('deno', ['eval', '--cached-only', script], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, NO_COLOR: '1' },
})
for (const line of output.trim().split('\n')) assert.deepEqual(JSON.parse(line), expected)
console.log(`deno (dist/deno, dist/browser): ${expected.join(', ')}`)
