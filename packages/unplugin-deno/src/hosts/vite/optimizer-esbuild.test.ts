import type { OnLoadArgs, OnLoadResult, OnResolveArgs, OnResolveResult, PluginBuild } from 'esbuild'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { denoDir } from '../../../test/helpers/deno-dir.js'
import { tempProject } from '../../../test/helpers/temp-project.js'
import { PluginState } from '../../core/state.js'
import type { DepsOptimizer } from './optimizer.js'
import { packageInstaller } from './install.js'
import { esbuildOptimizerPlugin } from './optimizer-esbuild.js'

type OnResolve = (args: OnResolveArgs) => Promise<OnResolveResult | undefined>
type OnLoad = (args: OnLoadArgs) => Promise<OnLoadResult | undefined>

/** Runs the plugin's `setup` against a recording build; `resolve` stands for `build.resolve`. */
function setupPlugin(
  plugin: ReturnType<typeof esbuildOptimizerPlugin>,
  resolved: { path: string; external?: boolean },
): { onResolve: OnResolve; onLoad: OnLoad; resolveCalls: unknown[] } {
  let onResolve: OnResolve | undefined
  let onLoad: OnLoad | undefined
  const resolveCalls: unknown[] = []
  const build = {
    onResolve: (_options: unknown, callback: OnResolve) => {
      onResolve = callback
    },
    onLoad: (_options: unknown, callback: OnLoad) => {
      onLoad = callback
    },
    resolve: (path: string, options: unknown) => {
      resolveCalls.push([path, options])
      return Promise.resolve({
        errors: [],
        warnings: [],
        path: resolved.path,
        external: resolved.external ?? false,
        sideEffects: true,
        namespace: 'file',
        suffix: '',
        pluginData: undefined,
      })
    },
  }
  void plugin.setup(build as unknown as PluginBuild)
  if (onResolve === undefined || onLoad === undefined) throw new Error('setup registered no hooks')
  return { onResolve, onLoad, resolveCalls }
}

function args(path: string, importer: string, extra: Partial<OnResolveArgs> = {}): OnResolveArgs {
  return {
    path,
    importer,
    namespace: 'file',
    resolveDir: '',
    kind: 'import-statement',
    pluginData: undefined,
    with: {},
    ...extra,
  }
}

describe('esbuildOptimizerPlugin (Vite 7)', () => {
  it('maps core outcomes to esbuild results for package files only', async () => {
    vi.stubEnv('DENO_DIR', await denoDir())
    const project = await tempProject('vite-ssr-deno')
    onTestFinished(() => project.dispose())
    const state = new PluginState({ cwd: project.root, platform: 'browser' }, 'vite')
    onTestFinished(() => state.close())
    await state.prepare()
    const registered: string[] = []
    const optimizer = {
      options: {},
      registerMissingImport: (id: string) => {
        registered.push(id)
        return { id, file: `/deps/${id}.js` }
      },
    } as unknown as DepsOptimizer
    const target = { platform: 'browser' as const, conditions: [] }
    const plugin = esbuildOptimizerPlugin(
      state,
      target,
      'abcd1234',
      async () => {},
      () => optimizer,
    )
    expect(plugin.name).toBe('unplugin-deno:optimizer:abcd1234')
    const { onResolve, onLoad, resolveCalls } = setupPlugin(plugin, { path: '/pkg/index.js' })
    const app = project.path('src/server.ts')
    const pkg = project.path('node_modules/pkg/index.js')

    // The scan: app files are the scanner's, except remote URLs, which are registered.
    expect(await onResolve(args('@std/path', app))).toBeUndefined()
    const url = 'https://deno.land/std@0.224.0/text/closest_string.ts'
    expect(await onResolve(args(url, app))).toEqual({ path: url, external: true })
    expect(registered).toEqual([url])
    expect(await onResolve(args('./local.ts', pkg))).toBeUndefined()

    // Imports of package files: files, externals and markers.
    const npm = await onResolve(args('npm:kleur@^4', pkg))
    expect(npm?.path).toMatch(/kleur[\\/]4\.1\.5[\\/]index\.mjs$/)
    expect(await onResolve(args('node:fs', pkg))).toBeUndefined()
    const marker = await onResolve(args('./data.txt?deno-type=text', pkg))
    expect(marker?.namespace).toBe('unplugin-deno')
    expect(resolveCalls).toEqual([])
    // The plugin's own redirects are not handled again.
    const redirect = args('kleur', pkg, {
      pluginData: { [Symbol.for('unplugin-deno:vite-optimizer-redirect')]: true },
    })
    expect(await onResolve(redirect)).toBeUndefined()

    const empty = await onLoad({
      path: '\0deno:empty',
      namespace: 'unplugin-deno',
      suffix: '',
      pluginData: undefined,
      with: {},
    })
    expect(empty).toEqual({ contents: 'export default {};\n', loader: 'js' })
  })

  it('resolves npm redirects through esbuild from the package', async () => {
    vi.stubEnv('DENO_DIR', await denoDir())
    const project = await tempProject('core-npm-node-modules')
    onTestFinished(() => project.dispose())
    const state = new PluginState({ cwd: project.root, platform: 'browser' }, 'vite')
    onTestFinished(() => state.close())
    await state.prepare()
    const plugin = esbuildOptimizerPlugin(
      state,
      { platform: 'browser' },
      'abcd1234',
      packageInstaller(state),
      () => undefined,
    )
    const resolvedPath = project.path(
      'node_modules/.deno/kleur@4.1.5/node_modules/kleur/colors.mjs',
    )
    const { onResolve, resolveCalls } = setupPlugin(plugin, { path: resolvedPath })
    // A mirror file (a data: module) importing an npm package, as prebundled JSR modules do.
    const mirrored = await state.resolve(
      'data:text/javascript,export default 1',
      project.path('src/main.ts'),
    )
    const importer = mirrored?.type === 'mirror' ? mirrored.path : ''
    const result = await onResolve(args('npm:kleur@^4/colors', importer))
    expect(result).toMatchObject({ path: resolvedPath, namespace: 'file', external: false })
    expect(resolveCalls).toHaveLength(1)
    const [request, options] = resolveCalls[0] as [string, { importer: string; pluginData: object }]
    expect(request).toBe('kleur/colors')
    expect(options.importer).toMatch(/kleur[\\/]package\.json$/)
    expect(Symbol.for('unplugin-deno:vite-optimizer-redirect') in options.pluginData).toBe(true)
  })
})
