import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { denoDir } from '../../test/helpers/deno-dir.js'
import { tempDir } from '../../test/helpers/temp-dir.js'
import type { TempFiles } from '../../test/helpers/temp-dir.js'
import { toFileUrl } from '../utils/path.js'
import type { Options } from './options.js'
import { PluginState, toHostSourceMap } from './state.js'
import { PLUGIN_VERSION } from './version.js'

async function state(
  files: TempFiles,
  options: Options = {},
): Promise<{ state: PluginState; root: string; path: (p: string) => string }> {
  vi.stubEnv('DENO_DIR', await denoDir())
  const dir = await tempDir(files)
  onTestFinished(() => dir.dispose())
  const plugin = new PluginState({ cwd: dir.root, ...options }, 'rolldown')
  onTestFinished(() => plugin.close())
  return { state: plugin, root: dir.root, path: dir.path }
}

describe('PluginState configuration', () => {
  it('loads the project and derives platform, strategy, cacheDir and generation', async () => {
    const { state: plugin, root } = await state({
      'deno.json': { imports: { kleur: 'npm:kleur@^4' } },
    })
    expect(plugin.ready).toBe(false)
    expect(() => plugin.project).toThrow(/not loaded yet/)
    plugin.setHints({ platform: 'browser', conditions: ['development'], version: '1.2.3' })
    expect(plugin.host).toMatchObject({
      framework: 'rolldown',
      command: 'build',
      platformHint: 'browser',
      conditionsHint: ['development'],
      version: '1.2.3',
    })
    await plugin.prepare()
    expect(plugin.ready).toBe(true)
    expect(plugin.project.configPath).toBe(join(root, 'deno.json'))
    expect(plugin.platform).toBe('browser')
    expect(plugin.conditions).toEqual(['development'])
    expect(plugin.npmStrategy).toBe('deno-cache')
    expect(plugin.cacheDir).toBe(join(root, 'node_modules', '.unplugin-deno'))
    expect(plugin.generation).toMatch(/^[0-9a-f]{8}$/)
    expect(plugin.mirror.root).toBe(join(plugin.cacheDir, plugin.generation))
    expect(plugin.denoDirs.length).toBeGreaterThan(0)
    expect(await plugin.prepare()).toBe(await plugin.prepare())
    expect(PLUGIN_VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('derives the Deno platform without a hint when the project has a deno.json', async () => {
    const { state: plugin } = await state({ 'deno.json': {} })
    await plugin.prepare()
    expect(plugin.platform).toBe('deno')
    expect(plugin.conditions).toEqual(['deno'])
  })

  it('uses the host root when the options name no cwd', async () => {
    vi.stubEnv('DENO_DIR', await denoDir())
    const dir = await tempDir({ 'app/deno.json': { nodeModulesDir: 'auto' } })
    onTestFinished(() => dir.dispose())
    const plugin = new PluginState({ cacheDir: 'cache' }, 'rolldown')
    plugin.setHints({ root: dir.path('app') })
    await plugin.prepare()
    expect(plugin.project.configPath).toBe(dir.path('app/deno.json'))
    expect(plugin.cacheDir).toBe(dir.path('app/cache'))
    expect(plugin.npmStrategy).toBe('node_modules')
  })

  it('narrows the filters once the project is loaded', async () => {
    const { state: plugin } = await state({
      'deno.json': { nodeModulesDir: 'manual', imports: { '@std/path': 'jsr:@std/path@^1' } },
    })
    expect(plugin.resolveIdFilter().test('lodash')).toBe(true)
    await plugin.prepare()
    expect(plugin.resolveIdFilter().test('lodash')).toBe(false)
    expect(plugin.resolveIdFilter().test('@std/path/join')).toBe(true)
    expect(plugin.resolveIdFilter(true).test('lodash')).toBe(true)
    const [mirror] = plugin.loadFilter()
    expect(mirror?.test(join(plugin.cacheDir, 'abc', 'x.js'))).toBe(true)
  })

  it('reports config warnings through the host context', async () => {
    const { state: plugin } = await state({
      'deno.json': { lock: { path: 'deno.lock' } },
      'deno.lock': '{"version":"3"}',
    })
    const warn = vi.fn<(message: string) => void>()
    plugin.setLogTarget({ warn })
    await plugin.prepare()
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('deno.lock version 3 is not supported'),
    )
  })

  it('logs a debug summary', async () => {
    const { state: plugin } = await state({ 'deno.json': {} }, { debug: true })
    const info = vi.fn<(message: string) => void>()
    plugin.setLogTarget({ info })
    await plugin.prepare()
    const lines = info.mock.calls.map(([line]) => String(line))
    expect(
      lines.some((line) =>
        /^\[core\] unplugin-deno .+ on rolldown, engine loader \(@deno\/loader \d/.test(line),
      ),
    ).toBe(true)
    expect(lines.some((line) => line.startsWith('[core] platform deno, conditions [deno]'))).toBe(
      true,
    )
    expect(lines.some((line) => line.startsWith('[core] cacheDir '))).toBe(true)
  })
})

describe('PluginState hooks', () => {
  it('loads marker modules, mirror files and the empty module', async () => {
    const { state: plugin, path } = await state({ 'deno.json': {}, 'src/data.txt': 'hello' })
    await plugin.prepare()
    expect(await plugin.load(`${path('src/data.txt')}?deno-type=text`)).toEqual({
      code: 'export default "hello";\n',
      moduleType: 'js',
    })
    expect(await plugin.load('\0deno:empty')).toEqual({
      code: 'export default {};\n',
      moduleType: 'js',
    })
    expect(await plugin.load('\0deno:other')).toBeNull()
    expect(await plugin.load('\0virtual:x')).toBeNull()
    expect(await plugin.load(path('src/data.txt'))).toBeNull()
    await expect(plugin.load(`${path('src/missing.txt')}?deno-type=bytes`)).rejects.toMatchObject({
      code: 'RESOLVE_NOT_FOUND',
      hint: 'Check that the imported file exists.',
    })
    const file = join(plugin.mirror.root, 'https', 'x.test', 'mod.ts.js')
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, 'export const x = 1;\n//# sourceMappingURL=mod.ts.js.map\n')
    await writeFile(
      `${file}.map`,
      JSON.stringify({
        version: 3,
        file: 'mod.ts.js',
        sources: ['https://x.test/mod.ts'],
        sourcesContent: ['export const x: number = 1'],
        names: [],
        mappings: 'AAAA',
      }),
    )
    // Rollup-family hosts get the source next to the mirror file (they resolve URLs as paths).
    expect(await plugin.load(file)).toEqual({
      code: 'export const x = 1;',
      map: {
        version: 3,
        file: 'mod.ts.js',
        sources: ['mod.ts'],
        sourcesContent: ['export const x: number = 1'],
        names: [],
        mappings: 'AAAA',
      },
      moduleType: 'js',
    })
    const asset = join(plugin.mirror.root, 'https', 'x.test', 'data.json')
    await writeFile(asset, '{}')
    expect(await plugin.load(asset)).toBeNull()
  })

  it('loads .wasm modules as instantiating modules, local and mirrored, unless disabled', async () => {
    // (module (func (export "one") (result i32) i32.const 1))
    const wasm = Uint8Array.from([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f,
      0x03, 0x02, 0x01, 0x00, 0x07, 0x07, 0x01, 0x03, 0x6f, 0x6e, 0x65, 0x00, 0x00, 0x0a, 0x06,
      0x01, 0x04, 0x00, 0x41, 0x01, 0x0b,
    ])
    const { state: plugin, path } = await state({ 'deno.json': {} })
    await plugin.prepare()
    expect(plugin.loadFilter().some((filter) => filter.test(path('src/one.wasm')))).toBe(true)
    await mkdir(path('src'), { recursive: true })
    await writeFile(path('src/one.wasm'), wasm)
    const local = await plugin.load(path('src/one.wasm'))
    expect(local?.moduleType).toBe('js')
    expect(local?.code).toContain('export const one = __wasm_instance.exports["one"];')
    const mirrored = join(plugin.mirror.root, 'https', 'x.test', 'one.wasm')
    await mkdir(dirname(mirrored), { recursive: true })
    await writeFile(mirrored, wasm)
    expect((await plugin.load(mirrored))?.code).toContain('new WebAssembly.Instance(')
    // Queries (`?init`, `?url`) and attributes are the host's or the markers'.
    expect(await plugin.load(`${path('src/one.wasm')}?init`)).toBeNull()
    await expect(plugin.load(path('src/missing.wasm'))).rejects.toMatchObject({
      code: 'RESOLVE_NOT_FOUND',
    })
    const off = await state({ 'deno.json': {} }, { wasm: false })
    await off.state.prepare()
    await mkdir(off.path('src'), { recursive: true })
    await writeFile(off.path('src/one.wasm'), wasm)
    expect(await off.state.load(off.path('src/one.wasm'))).toBeNull()
    expect(off.state.loadFilter().some((filter) => filter.test(off.path('src/one.wasm')))).toBe(
      false,
    )
  })

  it('runs the attribute pre-pass on local code only, unless disabled', async () => {
    const code = "import t from './a.txt' with { type: 'text' }\nexport default t\n"
    const { state: plugin, path } = await state({ 'deno.json': {} })
    await plugin.prepare()
    expect((await plugin.transform(code, path('src/main.ts')))?.code).toContain(
      '"./a.txt?deno-type=text"',
    )
    expect(await plugin.transform(code, '\0virtual:x')).toBeNull()
    expect(await plugin.transform(code, join(plugin.mirror.root, 'x.js'))).toBeNull()
    plugin.nativeAttributes = true
    expect(await plugin.transform(code, path('src/main.ts'))).toBeNull()
    const disabled = await state({ 'deno.json': {} }, { importAttributes: false })
    await disabled.state.prepare()
    expect(await disabled.state.transform(code, disabled.path('src/main.ts'))).toBeNull()
  })

  it('replaces import.meta.main outside entries, also in mirror and npm files', async () => {
    const code = 'export const main = import.meta.main\n'
    const { state: plugin, path } = await state({ 'deno.json': {} })
    await plugin.prepare()
    const lib = await plugin.transform(code, path('src/lib.ts'), { isEntry: () => false })
    expect(lib?.code).toBe('export const main = false\n')
    expect(lib?.map?.sources).toEqual([path('src/lib.ts')])
    expect(await plugin.transform(code, path('src/main.ts'), { isEntry: () => true })).toBeNull()
    const mirrored = join(plugin.mirror.root, 'https', 'x.test', 'cli.ts.js')
    expect((await plugin.transform(code, mirrored))?.code).toBe('export const main = false\n')
    const npm = path('node_modules/pkg/index.js')
    expect((await plugin.transform(code, npm))?.code).toBe('export const main = false\n')
    // Vite's dev server serves modules unbundled; only scripts are read.
    expect(await plugin.transform(code, path('src/lib.ts'), { importMetaMain: false })).toBeNull()
    expect(await plugin.transform(code, path('src/style.css'))).toBeNull()
    const off = await state({ 'deno.json': {} }, { importMetaMain: false })
    await off.state.prepare()
    expect(await off.state.transform(code, off.path('src/lib.ts'))).toBeNull()
  })

  it('inlines allowed variables for the browser platform, from .env files and the process', async () => {
    vi.stubEnv('PUBLIC_FROM_PROCESS', 'process value')
    const code =
      'export const a = Deno.env.get("PUBLIC_A")\n' +
      'export const b = process.env.PUBLIC_FROM_PROCESS\n' +
      'export const c = process.env["PUBLIC_MISSING"]\n' +
      'export const secret = () => Deno.env.get("SECRET")\n'
    const { state: plugin, path } = await state(
      { 'deno.json': {}, '.env': 'PUBLIC_A=from .env\nSECRET=hidden\n' },
      { env: { prefix: 'PUBLIC_' }, denoGlobals: 'off' },
    )
    plugin.setHints({ platform: 'browser' })
    await plugin.prepare()
    const result = await plugin.transform(code, path('src/main.ts'))
    expect(result?.code).toBe(
      'export const a = "from .env"\n' +
        'export const b = "process value"\n' +
        'export const c = undefined\n' +
        'export const secret = () => Deno.env.get("SECRET")\n',
    )
    // Server platforms keep their reads unless `env.server` is set; npm packages are left alone.
    expect(await plugin.transform(code, path('src/main.ts'), { platform: 'deno' })).toBeNull()
    expect(await plugin.transform(code, path('node_modules/pkg/index.js'))).toBeNull()
    const server = await state(
      { 'deno.json': {}, 'app.env': 'PUBLIC_A=server\n' },
      { env: { prefix: ['PUBLIC_'], files: ['app.env'], server: true } },
    )
    await server.state.prepare()
    expect(server.state.platform).toBe('deno')
    expect((await server.state.transform(code, server.path('src/main.ts')))?.code).toContain(
      'export const a = "server"',
    )
  })

  it('reports Deno globals of local browser modules once per file, or fails with error', async () => {
    const code = '// Deno.exit()\nexport const cwd = () => Deno.cwd()\nexport const x = Deno.pid\n'
    const warnings: string[] = []
    const { state: plugin, path } = await state({ 'deno.json': {} })
    plugin.setHints({ platform: 'browser' })
    await plugin.prepare()
    plugin.setLogTarget({ warn: (message) => warnings.push(message) })
    expect(await plugin.transform(code, path('src/main.ts'))).toBeNull()
    expect(await plugin.transform(code, path('src/main.ts'))).toBeNull()
    expect(warnings).toEqual([
      expect.stringMatching(/^src\/main\.ts:2:26 uses `Deno\.cwd`, `Deno\.pid`/),
    ])
    // Mirror and npm files, and other platforms, are not checked.
    await plugin.transform(code, join(plugin.mirror.root, 'https', 'x.test', 'a.ts.js'))
    await plugin.transform(code, path('node_modules/pkg/index.js'))
    await plugin.transform(code, path('src/server.ts'), { platform: 'deno' })
    expect(warnings).toHaveLength(1)
    const strict = await state({ 'deno.json': {} }, { denoGlobals: 'error' })
    strict.state.setHints({ platform: 'browser' })
    await strict.state.prepare()
    await expect(strict.state.transform(code, strict.path('src/main.ts'))).rejects.toMatchObject({
      name: 'DenoPluginError',
      code: 'PLATFORM_INCOMPATIBLE',
    })
    // Inlined env reads do not count.
    const inlined = await state({ 'deno.json': {} }, { env: { prefix: 'PUBLIC_' } })
    inlined.state.setHints({ platform: 'browser' })
    await inlined.state.prepare()
    const envWarnings: string[] = []
    inlined.state.setLogTarget({ warn: (message) => envWarnings.push(message) })
    await inlined.state.transform(
      'export const a = Deno.env.get("PUBLIC_A")\n',
      inlined.path('a.ts'),
    )
    expect(envWarnings).toEqual([])
  })

  it('warns once when Deno manages a node_modules another package manager installed', async () => {
    const warnings: string[] = []
    const { state: plugin } = await state({
      'deno.json': { nodeModulesDir: 'auto' },
      'package.json': { dependencies: { kleur: '^4' } },
      'node_modules/.modules.yaml': 'layoutVersion: 5\n',
    })
    plugin.setLogTarget({ warn: (message) => warnings.push(message) })
    await plugin.prepare()
    await plugin.watchChange(plugin.project.configPath ?? '')
    expect(warnings).toEqual([expect.stringContaining('was installed by pnpm')])
  })

  it('reports npm packages bundled in several versions at the end of a build', async () => {
    const warnings: string[] = []
    const { state: plugin } = await state({ 'deno.json': {} })
    plugin.setLogTarget({ warn: (message) => warnings.push(message) })
    plugin.recordNpmPackage('browser', 'kleur', '3.0.3')
    plugin.recordNpmPackage('browser', 'kleur', '4.1.5')
    plugin.reportDuplicates()
    plugin.reportDuplicates()
    expect(warnings).toEqual([expect.stringContaining('kleur is bundled in 2 versions')])
    const off = await state({ 'deno.json': {} }, { checks: { duplicates: false } })
    off.state.recordNpmPackage('browser', 'kleur', '3.0.3')
    off.state.recordNpmPackage('browser', 'kleur', '4.1.5')
    const offWarnings: string[] = []
    off.state.setLogTarget({ warn: (message) => offWarnings.push(message) })
    off.state.reportDuplicates()
    expect(offWarnings).toEqual([])
  })

  it('decides the JSX transform once the project is loaded and warns once for precompile', async () => {
    const warnings: string[] = []
    const { state: plugin } = await state({
      'deno.json': { compilerOptions: { jsx: 'precompile', jsxImportSource: 'preact' } },
    })
    plugin.setLogTarget({ warn: (message) => warnings.push(message) })
    await plugin.prepare()
    expect(plugin.jsxTransform('Rolldown')?.transform).toEqual({
      runtime: 'automatic',
      importSource: 'preact',
      development: false,
    })
    plugin.jsxTransform('Rolldown')
    expect(warnings).toEqual([expect.stringContaining('"precompile"')])
  })

  it('reloads the project when a watched file changes', async () => {
    const { state: plugin, path } = await state({ 'deno.json': { imports: { a: './a.ts' } } })
    await plugin.prepare()
    const generation = plugin.generation
    expect(plugin.watchFiles()).toContain(path('deno.json'))
    expect(await plugin.watchChange(path('src/main.ts'))).toBe(false)
    await writeFile(path('deno.json'), JSON.stringify({ imports: { b: './b.ts' } }))
    expect(await plugin.watchChange(path('deno.json'))).toBe(true)
    expect(plugin.generation).not.toBe(generation)
    expect(plugin.project.importMap.ownedKeys()).toEqual(['b'])
    expect(plugin.resolveIdFilter().test('b')).toBe(true)
  })

  it('resolves owned ids after preparing and never claims foreign ones', async () => {
    const { state: plugin, path } = await state({ 'deno.json': {}, 'src/x.ts': 'export {}' })
    expect(await plugin.resolve('virtual:x', undefined)).toBeNull()
    expect(plugin.ready).toBe(false)
    expect(await plugin.resolve(toFileUrl(path('src/x.ts')), undefined)).toEqual({
      type: 'path',
      path: path('src/x.ts'),
    })
    expect(plugin.ready).toBe(true)
  })

  it('creates one engine per purpose and disposes them', async () => {
    const { state: plugin } = await state({ 'deno.json': {} })
    await plugin.prepare()
    const engine = await plugin.engine()
    expect(await plugin.engine()).toBe(engine)
    const raw = await plugin.engine('raw')
    expect(raw).not.toBe(engine)
    await plugin.disposeEngines()
    expect(await plugin.engine()).not.toBe(engine)
  })
})

describe('toHostSourceMap', () => {
  it('drops null sources, a null file and incomplete sourcesContent', () => {
    expect(toHostSourceMap(null)).toBeNull()
    expect(toHostSourceMap(undefined)).toBeNull()
    expect(
      toHostSourceMap({
        version: 3,
        file: null,
        sources: ['a', null],
        sourcesContent: ['x', null],
        names: [],
        mappings: 'A',
      }),
    ).toEqual({ version: 3, sources: ['a', ''], names: [], mappings: 'A' })
    expect(
      toHostSourceMap({
        version: 3,
        file: 'f.js',
        sources: ['a'],
        sourcesContent: ['x'],
        names: ['n'],
        mappings: 'A',
      }),
    ).toEqual({
      version: 3,
      file: 'f.js',
      sources: ['a'],
      sourcesContent: ['x'],
      names: ['n'],
      mappings: 'A',
    })
  })
})
