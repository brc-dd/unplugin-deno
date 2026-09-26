import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { denoDir } from '../../../test/helpers/deno-dir.js'
import { tempDir } from '../../../test/helpers/temp-dir.js'
import type { TempFiles } from '../../../test/helpers/temp-dir.js'
import type { Options, Platform } from '../../core/options.js'
import { PluginState } from '../../core/state.js'
import { isDenoPluginError } from '../../diagnostics/errors.js'
import type { HostLogTarget } from '../shared.js'
import type { AdapterRule, TransformHook, TransformLoaderUse } from './transforms.js'
import {
  EntryModules,
  SCRIPT_FILE,
  SourceTransforms,
  takesOverWasm,
  transformLoader,
} from './transforms.js'

/** A loaded plugin state for a project of `files`, and source transforms for `platform`. */
async function setup(
  files: TempFiles,
  options: Options = {},
  platform: Platform = 'browser',
): Promise<{
  state: PluginState
  transforms: SourceTransforms
  path: (path: string) => string
  warnings: string[]
}> {
  vi.stubEnv('DENO_DIR', await denoDir())
  const dir = await tempDir({ 'deno.json': {}, ...files })
  onTestFinished(() => dir.dispose())
  const state = new PluginState({ cwd: dir.root, ...options }, 'webpack')
  onTestFinished(() => state.close())
  state.nativeAttributes = true
  state.setHints({ platform })
  await state.prepare()
  const warnings: string[] = []
  const log: HostLogTarget = { warn: (message) => warnings.push(message), info: () => {} }
  const transforms = new SourceTransforms(state, {
    host: 'webpack',
    platform: () => platform,
    log,
  })
  return { state, transforms, path: dir.path, warnings }
}

/** The transform hook of the `pre` rule of `rules`. */
function transformHook(rules: AdapterRule[]): TransformHook {
  const rule = rules.find((item) => item.enforce === 'pre')
  const use = rule?.use[0] as TransformLoaderUse | undefined
  if (use === undefined) throw new Error('no transform rule')
  return use.options.plugin.transform
}

describe('EntryModules', () => {
  it('records the resources of dependencies without an issuer, and of workers', () => {
    const entries = new EntryModules()
    entries.note('', '/root/src/main.ts')
    entries.note('/root/src/main.ts', '/root/src/lib.ts')
    entries.note('/root/src/main.ts', '/root/src/worker.ts?x=1', 'worker')
    entries.note('', undefined)
    entries.note('', '/root/src/a\0#b.ts?query')
    expect(entries.has('/root/src/main.ts')).toBe(true)
    expect(entries.has('/root/src/main.ts?raw')).toBe(true)
    expect(entries.has('/root/src/lib.ts')).toBe(false)
    expect(entries.has('/root/src/worker.ts')).toBe(true)
    expect(entries.has('/root/src/a#b.ts')).toBe(true)
  })
})

describe('SourceTransforms', () => {
  it('replaces import.meta.main outside entries, keeping it in entries', async () => {
    const { transforms, path } = await setup({})
    const entry = path('src/main.ts')
    transforms.entries.note('', entry)
    const code = 'export const main: boolean = import.meta.main\n'
    expect(await transforms.transform(code, entry)).toBeNull()
    const lib = await transforms.transform(code, path('src/lib.ts'))
    expect(lib?.code).toBe('export const main: boolean = false\n')
    expect(lib?.map?.sources).toEqual([path('src/lib.ts')])
  })

  it('inlines environment variables for the browser, watching the .env files', async () => {
    const { transforms, path } = await setup(
      { '.env': 'PUBLIC_NAME=deno\n' },
      { env: { prefix: 'PUBLIC_' } },
    )
    const watched: string[] = []
    const result = await transforms.transform(
      'export const name = Deno.env.get("PUBLIC_NAME")\n',
      path('src/main.ts'),
      (file) => watched.push(file),
    )
    expect(result?.code).toBe('export const name = "deno"\n')
    expect(watched).toEqual([path('.env')])
    // Code that reads no variable depends on no .env file.
    watched.length = 0
    await transforms.transform('export {}\n', path('src/other.ts'), (file) => watched.push(file))
    expect(watched).toEqual([])
  })

  it('leaves the environment of server platforms alone', async () => {
    const { transforms, path } = await setup(
      { '.env': 'PUBLIC_NAME=deno\n' },
      { env: { prefix: 'PUBLIC_' } },
      'deno',
    )
    const watched: string[] = []
    const code = 'export const name = Deno.env.get("PUBLIC_NAME")\n'
    expect(
      await transforms.transform(code, path('src/main.ts'), (file) => watched.push(file)),
    ).toBeNull()
    expect(watched).toEqual([])
  })

  it("reports Deno globals, and fails with the host error for denoGlobals: 'error'", async () => {
    const code = 'export function cwd() {\n  return Deno.cwd()\n}\n'
    const warned = await setup({})
    expect(await warned.transforms.transform(code, warned.path('src/server.ts'))).toBeNull()
    expect(warned.warnings).toEqual([expect.stringContaining('src/server.ts:2:10 uses `Deno.cwd`')])
    const failing = await setup({}, { denoGlobals: 'error' })
    const error: unknown = await failing.transforms
      .transform(code, failing.path('src/server.ts'))
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect(isDenoPluginError(error)).toBe(true)
    expect((error as Error).message).toMatch(
      /^\[unplugin-deno\] src\/server\.ts:2:10 uses `Deno\.cwd`.*\(PLATFORM_INCOMPATIBLE\)$/,
    )
  })

  it('adds the pre transform, mirror and Wasm rules once the project is loaded', async () => {
    const { state, transforms, path } = await setup({})
    const rules = await transforms.rules()
    expect(rules).toHaveLength(3)
    const [pre, mirror, wasm] = rules
    if (pre === undefined || mirror === undefined || wasm === undefined) throw new Error('rules')
    expect(pre).toMatchObject({ enforce: 'pre', test: SCRIPT_FILE, dependency: { not: 'url' } })
    const exclude = pre.exclude ?? []
    const excluded = (file: string): boolean => exclude.some((pattern) => pattern.test(file))
    expect(excluded(path('src/main.ts'))).toBe(false)
    expect(excluded(path('node_modules/pkg/index.js'))).toBe(true)
    expect(excluded(join(state.cacheDir, state.generation, 'https/x/mod.ts.js'))).toBe(true)
    expect(excluded(join(state.denoDirs[0] ?? '', 'npm', 'registry.npmjs.org/x/1.0.0/i.js'))).toBe(
      true,
    )
    expect(pre.resourceQuery?.not.test('?raw')).toBe(true)
    expect(pre.resourceQuery?.not.test('?worker&raw=1')).toBe(true)
    expect(pre.resourceQuery?.not.test('?rawish')).toBe(false)
    const include = pre.include as RegExp
    expect(include.test(path('src/main.ts'))).toBe(true)
    expect(include.test('unplugin-deno:src/data.txt')).toBe(false)
    expect((pre.use[0] as TransformLoaderUse).ident).toMatch(
      /^unplugin-deno-transform-[0-9a-f]{12}$/,
    )
    expect(mirror).toMatchObject({ test: /\.[cm]?js$/ })
    expect((mirror.include as RegExp).test(join(state.cacheDir, 'x', 'mod.ts.js'))).toBe(true)
    expect(wasm).toMatchObject({
      test: /\.wasm$/i,
      type: 'javascript/esm',
      resourceQuery: { not: /./ },
      dependency: { not: 'url' },
    })
    const takes = wasm.include as (file: string) => boolean
    expect(takes(path('src/add.wasm'))).toBe(true)
    expect(takes(path('node_modules/pkg/add.wasm'))).toBe(false)
    // The transform hook filters by code and runs `state.transform`.
    const hook = transformHook(rules)
    expect(hook.filter.code.test('import.meta.main')).toBe(true)
    expect(hook.filter.code.test('with { type: "text" }')).toBe(false)
    const result = await hook.handler.call(
      { addWatchFile: () => {} },
      'export const main = import.meta.main\n',
      path('src/lib.ts'),
    )
    expect(result?.code).toBe('export const main = false\n')
  })

  it('adds no pre rule when every transform is off, and no Wasm rule with wasm: false', async () => {
    const { transforms } = await setup(
      {},
      { importMetaMain: false, denoGlobals: 'off', wasm: false },
    )
    expect(transforms.codeFilter()).toBeNull()
    const rules = await transforms.rules()
    expect(rules).toHaveLength(1)
    expect(rules[0]?.enforce).toBeUndefined()
  })

  it('names the transform settings in the loader idents', async () => {
    const base = await transformIdent({})
    expect(await transformIdent({})).toBe(base)
    expect(await transformIdent({ importMetaMain: false })).not.toBe(base)
    const env = { env: { prefix: 'PUBLIC_' } }
    const first = await transformIdent(env, { PUBLIC_A: '1' })
    expect(first).not.toBe(base)
    expect(await transformIdent(env, { PUBLIC_A: '2' })).not.toBe(first)
  })
})

/** The ident of the transform loader for `options`, with the variables `env` set. */
async function transformIdent(options: Options, env: Record<string, string> = {}): Promise<string> {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  const { transforms } = await setup({}, options)
  const [first] = await transforms.rules()
  return (first?.use[0] as TransformLoaderUse | undefined)?.ident ?? ''
}

describe('takesOverWasm', () => {
  it('takes local and mirror files, not npm packages or synthesised modules', async () => {
    const { state, path } = await setup({})
    expect(takesOverWasm(state, path('src/add.wasm'))).toBe(true)
    expect(takesOverWasm(state, join(state.cacheDir, state.generation, 'https/x/add.wasm'))).toBe(
      true,
    )
    expect(takesOverWasm(state, path('node_modules/pkg/add.wasm'))).toBe(false)
    expect(
      takesOverWasm(state, join(state.denoDirs[0] ?? '', 'npm', 'registry.npmjs.org/x/1/a.wasm')),
    ).toBe(false)
    expect(takesOverWasm(state, 'unplugin-deno:src/add.wasm')).toBe(false)
    const unloaded = new PluginState({}, 'webpack')
    expect(takesOverWasm(unloaded, path('src/add.wasm'))).toBe(false)
  })
})

describe('transformLoader', () => {
  it("points at unplugin's transform loaders, with the ident", () => {
    const hook: TransformHook = { filter: { code: /x/ }, handler: async () => null }
    for (const host of ['webpack', 'rspack'] as const) {
      const use = transformLoader(host, hook, 'unplugin-deno-transform-abc')
      expect(existsSync(use.loader)).toBe(true)
      expect(use.loader.replaceAll('\\', '/')).toMatch(
        new RegExp(`unplugin/dist/${host}/loaders/transform\\.mjs$`),
      )
      expect(use.ident).toBe('unplugin-deno-transform-abc')
      expect(use.options.plugin).toEqual({ name: 'unplugin-deno', transform: hook })
    }
  })
})
