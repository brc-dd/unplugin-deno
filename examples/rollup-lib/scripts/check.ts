/**
 * Type-checks the sources with Deno, builds the library with rollup.config.ts and checks the
 * output (CI runs this with `pnpm check`): everything is bundled, and the table is the same in
 * this runtime and under Deno.
 */
import assert from 'node:assert/strict'
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { rollup } from 'rollup'
import { loadConfigFile } from 'rollup/loadConfigFile'

const root = fileURLToPath(new URL('..', import.meta.url))

// In the unplugin-deno repository the plugin is a workspace package: build it once after a fresh
// clone. Installed from npm it is already built, and this does nothing.
const plugin = dirname(fileURLToPath(import.meta.resolve('unplugin-deno/package.json')))
if (!existsSync(join(plugin, 'dist')) && existsSync(join(plugin, 'tsdown.config.ts'))) {
  execSync('pnpm --filter unplugin-deno build', { stdio: 'inherit' })
}

// The sources are Deno code: type-check them with Deno.
execFileSync('deno', ['check', 'src/mod.ts'], { cwd: root, stdio: 'inherit' })

process.chdir(root)
const { options, warnings } = await loadConfigFile(join(root, 'rollup.config.ts'))
warnings.flush()
for (const config of options) {
  const bundle = await rollup(config)
  await Promise.all(config.output.map((output) => bundle.write(output)))
  await bundle.close()
}

const code = readFileSync(join(root, 'dist', 'mod.js'), 'utf8')
assert.doesNotMatch(code, /^import /m, 'the bundle has imports left')

const files = [
  { name: 'vendor.js', bytes: 4_100 },
  { name: 'app.js', bytes: 123_456 },
  { name: '日本語.js', bytes: 900 },
]
const expected = ['app.js     123 kB', 'vendor.js  4.1 kB', '日本語.js   900 B'].join('\n')
const { sizeTable } = await import(pathToFileURL(join(root, 'dist', 'mod.js')).href)
assert.equal(sizeTable(files), expected)
console.log(`${process.versions.deno ? 'deno' : 'node'}:\n${expected}`)

const script = `
  const { sizeTable } = await import('./dist/mod.js')
  console.log(sizeTable(${JSON.stringify(files)}))
`
const output = execFileSync('deno', ['eval', script], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, NO_COLOR: '1' },
})
assert.equal(output.trimEnd(), expected)
console.log('deno: same table')
