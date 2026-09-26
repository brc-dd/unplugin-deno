import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Plugin as VitePlugin, UserConfig } from 'vite'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { denoDir } from '../../../test/helpers/deno-dir.js'
import { tempDir } from '../../../test/helpers/temp-dir.js'
import type { TempFiles } from '../../../test/helpers/temp-dir.js'
import { tempProject } from '../../../test/helpers/temp-project.js'
import type { TempProject } from '../../../test/helpers/temp-project.js'
import type { Options } from '../../core/options.js'
import { PluginState } from '../../core/state.js'
import { importMapAliases, jsxConfig, REMOTE_ALIAS, viteHooks } from './index.js'

interface Setup {
  project: TempProject
  state: PluginState
  plugin: Partial<VitePlugin>
}

async function setup(fixtureName = 'vite-ssr-deno'): Promise<Setup> {
  vi.stubEnv('DENO_DIR', await denoDir())
  const project = await tempProject(fixtureName)
  onTestFinished(() => project.dispose())
  const state = new PluginState({}, 'vite')
  onTestFinished(() => state.close())
  return { project, state, plugin: viteHooks(state) }
}

/** Calls a hook of `plugin` (function or object form) with `context` as `this`. */
function call(
  plugin: Partial<VitePlugin>,
  name: keyof VitePlugin,
  context: object,
  ...args: unknown[]
): unknown {
  const hook: unknown = plugin[name]
  const handler =
    typeof hook === 'function'
      ? hook
      : typeof hook === 'object' && hook !== null && 'handler' in hook
        ? (hook as { handler: unknown }).handler
        : undefined
  if (typeof handler !== 'function') throw new Error(`no ${String(name)} hook`)
  return Reflect.apply(handler, context, args)
}

const vite8 = { meta: { viteVersion: '8.3.1', rolldownVersion: '1.2.11' }, warn() {}, info() {} }
const vite7 = { meta: { viteVersion: '7.3.6' }, warn() {}, info() {} }

async function configure(
  { project, plugin }: Setup,
  command: 'serve' | 'build',
  config: UserConfig = {},
  context: object = vite8,
): Promise<{ config: UserConfig; result: unknown }> {
  const userConfig: UserConfig = { root: project.root, ...config }
  const result = await call(plugin, 'config', context, userConfig, { command, mode: 'development' })
  return { config: userConfig, result }
}

describe('config', () => {
  it('adds the remote alias after the configured ones, once, in the dev server', async () => {
    const test = await setup()
    const { config, result } = await configure(test, 'serve', {
      resolve: { alias: { '@': '/src' } },
    })
    expect(config.resolve?.alias).toEqual([{ find: '@', replacement: '/src' }, REMOTE_ALIAS])
    await call(test.plugin, 'config', vite8, config, { command: 'serve', mode: 'development' })
    expect(config.resolve?.alias).toHaveLength(2)
    // A Deno project without package.json: Vite's cache stays under the root.
    expect(result).toEqual({ cacheDir: join(test.project.root, 'node_modules', '.vite') })
  })

  it('adds no alias to builds and keeps a configured or package.json cacheDir', async () => {
    const test = await setup()
    const build = await configure(test, 'build')
    expect(build.config.resolve?.alias).toBeUndefined()
    const configured = await configure(test, 'serve', { cacheDir: '.cache' })
    expect(configured.result).toBeNull()
    const withPackageJson = await setup()
    await writeFile(withPackageJson.project.path('package.json'), '{ "name": "app" }\n')
    expect((await configure(withPackageJson, 'serve')).result).toBeNull()
  })
})

describe('configEnvironment', () => {
  it('adds the deno condition to Deno server environments and the optimizer plugin', async () => {
    const test = await setup()
    await configure(test, 'serve')
    const env = { command: 'serve', mode: 'development' }
    const ssr = call(test.plugin, 'configEnvironment', vite8, 'ssr', {}, env) as {
      resolve?: { conditions?: string[]; externalConditions?: string[] }
      optimizeDeps?: { rolldownOptions?: { plugins?: { name: string }[] } }
    }
    expect(ssr.resolve?.conditions).toEqual(['module', 'node', 'development|production', 'deno'])
    expect(ssr.resolve?.externalConditions).toEqual(['node', 'module-sync', 'deno'])
    expect(ssr.optimizeDeps?.rolldownOptions?.plugins?.[0]?.name).toBe(
      `unplugin-deno:optimizer:${test.state.generation}`,
    )
    const client = call(test.plugin, 'configEnvironment', vite8, 'client', {}, env) as {
      resolve?: unknown
    }
    expect(client.resolve).toBeUndefined()
    const configured = call(
      test.plugin,
      'configEnvironment',
      vite8,
      'ssr',
      {
        resolve: { conditions: ['deno'] },
      },
      env,
    ) as { resolve?: { conditions?: string[] } }
    expect(configured.resolve?.conditions).toBeUndefined()
    const build = call(
      test.plugin,
      'configEnvironment',
      vite8,
      'ssr',
      {},
      { command: 'build' },
    ) as {
      optimizeDeps?: unknown
    }
    expect(build.optimizeDeps).toBeUndefined()
  })

  it('gives Vite 7 an esbuild optimizer plugin', async () => {
    const test = await setup()
    await configure(test, 'serve', {}, vite7)
    const client = call(
      test.plugin,
      'configEnvironment',
      vite7,
      'client',
      {},
      {
        command: 'serve',
      },
    ) as { optimizeDeps?: { esbuildOptions?: { plugins?: { name: string }[] } } }
    expect(client.optimizeDeps?.esbuildOptions?.plugins?.[0]?.name).toMatch(
      /^unplugin-deno:optimizer:/,
    )
  })
})

describe('configResolved', () => {
  it('lets the dev server serve the mirror and the workspace root', async () => {
    const test = await setup()
    await configure(test, 'serve')
    const allow = ['/elsewhere']
    call(test.plugin, 'configResolved', vite8, { command: 'serve', server: { fs: { allow } } })
    expect(allow).toContain(test.state.cacheDir.replaceAll('\\', '/'))
    expect(allow).toContain(test.project.root.replaceAll('\\', '/'))
    const buildAllow: string[] = []
    call(test.plugin, 'configResolved', vite8, {
      command: 'build',
      server: { fs: { allow: buildAllow } },
    })
    expect(buildAllow).toEqual([])
  })
})

describe('watching', () => {
  it('leaves config files to the watcher and reloads in build watch mode only', async () => {
    const test = await setup()
    await configure(test, 'serve')
    const configPath = test.project.path('deno.json')
    expect(call(test.plugin, 'hotUpdate', {}, { file: configPath })).toEqual([])
    expect(
      call(test.plugin, 'hotUpdate', {}, { file: test.project.path('src/a.ts') }),
    ).toBeUndefined()
    const watchChange = vi.spyOn(test.state, 'watchChange')
    await call(test.plugin, 'watchChange', { environment: { mode: 'dev' } }, configPath)
    expect(watchChange).not.toHaveBeenCalled()
    await call(test.plugin, 'watchChange', { environment: { mode: 'build' } }, configPath)
    expect(watchChange).toHaveBeenCalledWith(configPath)
  })
})

describe('resolveId and load', () => {
  const ssrBuild = { name: 'ssr', mode: 'build', config: { consumer: 'server' } }
  const clientDev = { name: 'client', mode: 'dev', config: { consumer: 'client' } }

  it('keeps pinned externals, leaves builtins to Vite and turns markers into virtual ids', async () => {
    const test = await setup()
    await configure(test, 'build')
    const importer = test.project.path('src/server.ts')
    const resolved: string[] = []
    const context = (environment: object): object => ({
      ...vite8,
      environment,
      resolve: (source: string) => {
        resolved.push(source)
        return Promise.resolve({ id: test.project.path('src', source.replace('./', '')) })
      },
    })
    const resolveId = (environment: object, source: string): unknown =>
      call(test.plugin, 'resolveId', context(environment), source, importer, { isEntry: false })
    expect(await resolveId(ssrBuild, 'npm:kleur@^4')).toEqual({
      id: 'npm:kleur@4.1.5',
      external: true,
    })
    expect(await resolveId(ssrBuild, 'node:fs')).toBeNull()
    const marker = (await resolveId(clientDev, './answer.ts?deno-type=text')) as { id: string }
    expect(resolved).toEqual(['./answer.ts'])
    // Relative to the Vite root: no machine path in ids or output.
    expect(marker.id).toBe('\0deno:text:src/answer.ts.js')

    const watched: string[] = []
    const loaded = (await call(
      test.plugin,
      'load',
      { ...vite8, addWatchFile: (file: string) => watched.push(file) },
      marker.id,
    )) as { code: string }
    expect(loaded.code).toContain('export const answer: number = 42')
    expect(watched).toEqual([importer.replace('server.ts', 'answer.ts')])
  })
})

/** A path with `/` separators. */
function slash(value: string): string {
  return value.replaceAll('\\', '/')
}

/** A prepared state for a temporary project (`files`), with its root. */
async function prepared(
  files: TempFiles,
  options: Options = {},
): Promise<{ state: PluginState; root: string; path: (p: string) => string }> {
  vi.stubEnv('DENO_DIR', await denoDir())
  const dir = await tempDir(files)
  onTestFinished(() => dir.dispose())
  const state = new PluginState({ cwd: dir.root, ...options }, 'vite')
  onTestFinished(() => state.close())
  await state.prepare()
  return { state, root: dir.root, path: dir.path }
}

describe('JSX settings (§5.11)', () => {
  const preact = {
    'deno.json': { compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'preact' } },
  }

  it('sets oxc.jsx on Vite 8 and esbuild.jsx* on Vite 7', async () => {
    const { state } = await prepared(preact)
    expect(jsxConfig(state, {}, true)).toEqual({
      oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
    })
    expect(jsxConfig(state, {}, false)).toEqual({
      esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
    })
    // Vite 8 converts esbuild options, and would ignore them next to oxc options.
    expect(jsxConfig(state, { esbuild: { drop: ['console'] } }, true)).toEqual({
      esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
    })
  })

  it('leaves JSX the config sets, a disabled transform and jsx: host alone', async () => {
    const { state } = await prepared(preact)
    expect(jsxConfig(state, { oxc: { jsx: 'preserve' } }, true)).toEqual({})
    expect(jsxConfig(state, { oxc: false }, true)).toEqual({})
    expect(jsxConfig(state, { esbuild: { jsxFactory: 'h' } }, false)).toEqual({})
    expect(jsxConfig(state, { esbuild: false }, false)).toEqual({})
    const host = await prepared(preact, { jsx: 'host' })
    expect(jsxConfig(host.state, {}, true)).toEqual({})
    const none = await prepared({ 'deno.json': {} })
    expect(jsxConfig(none.state, {}, true)).toEqual({})
  })

  it('returns the JSX settings from the config hook', async () => {
    vi.stubEnv('DENO_DIR', await denoDir())
    const dir = await tempDir({
      'deno.json': { compilerOptions: { jsx: 'react', jsxFactory: 'h', jsxFragmentFactory: 'F' } },
      'package.json': '{}',
    })
    onTestFinished(() => dir.dispose())
    const state = new PluginState({}, 'vite')
    onTestFinished(() => state.close())
    const result = await call(
      viteHooks(state),
      'config',
      vite8,
      { root: dir.root },
      {
        command: 'build',
        mode: 'production',
      },
    )
    expect(result).toEqual({
      oxc: { jsx: { runtime: 'classic', pragma: 'h', pragmaFrag: 'F', development: false } },
    })
  })
})

describe('import-map aliases (D4)', () => {
  it('mirrors path-like entries into resolve.alias, never jsr:, npm: or URLs', async () => {
    const { state, root, path } = await prepared({
      'deno.json': {
        imports: {
          '@styles/': './src/styles/',
          '@styles/deep/': './src/deep/',
          '@app/theme': './src/theme.css',
          $dollar: './src/$money.css',
          '@std/path': 'jsr:@std/path@^1',
          kleur: 'npm:kleur@^4',
          remote: 'https://x.test/mod.ts',
          excluded: './src/excluded.css',
        },
      },
    })
    const aliases = importMapAliases(state, root)
    expect(aliases.map((alias) => [String(alias.find), alias.replacement])).toEqual([
      [String(/^excluded(?=[?#]|$)/), slash(path('src/excluded.css'))],
      [String(/^@styles\/deep\//), `${slash(path('src/deep'))}/`],
      [String(/^@styles\//), `${slash(path('src/styles'))}/`],
      [String(/^@app\/theme(?=[?#]|$)/), slash(path('src/theme.css'))],
      [String(/^\$dollar(?=[?#]|$)/), slash(path('src/$$money.css'))],
    ])
    // The replacement is used as a String.prototype.replace replacement, where `$$` is `$`.
    const dollar = aliases.at(-1)
    expect('$dollar?inline'.replace(dollar?.find as RegExp, dollar?.replacement ?? '')).toBe(
      `${slash(path('src/$money.css'))}?inline`,
    )
    const excluded = await prepared(
      { 'deno.json': { imports: { excluded: './src/excluded.css' } } },
      { exclude: ['excluded'] },
    )
    expect(importMapAliases(excluded.state, excluded.root)).toEqual([])
  })

  it('uses the scope of the member the Vite root is in, and skips keys other scopes redefine', async () => {
    const { state, path } = await prepared({
      'deno.json': {
        workspace: ['./app', './lib'],
        imports: { '@/': './shared/', '@root/': './root/', '@lib/': './shared-lib/' },
      },
      'app/deno.json': { imports: { '@/': './src/' } },
      'lib/deno.json': { imports: { '@lib/': './src/' } },
    })
    const aliases = importMapAliases(state, path('app'))
    expect(aliases.map((alias) => [String(alias.find), alias.replacement])).toEqual([
      [String(/^@\//), `${slash(path('app/src'))}/`],
      [String(/^@root\//), `${slash(path('root'))}/`],
    ])
  })

  it('adds the aliases after the configured ones in the config hook, once', async () => {
    vi.stubEnv('DENO_DIR', await denoDir())
    const dir = await tempDir({ 'deno.json': { imports: { '@styles/': './src/styles/' } } })
    onTestFinished(() => dir.dispose())
    const state = new PluginState({}, 'vite')
    onTestFinished(() => state.close())
    const plugin = viteHooks(state)
    const config: UserConfig = { root: dir.root, resolve: { alias: { '@': '/src' } } }
    await call(plugin, 'config', vite8, config, { command: 'build', mode: 'production' })
    await call(plugin, 'config', vite8, config, { command: 'build', mode: 'production' })
    const aliases = config.resolve?.alias as unknown as Array<{ find: unknown }>
    expect(aliases.map((alias) => String(alias.find))).toEqual(['@', String(/^@styles\//)])
  })
})

describe('worker plugins (D7)', () => {
  it('registers a plugin instance for worker bundles when given one', async () => {
    vi.stubEnv('DENO_DIR', await denoDir())
    const project = await tempProject('vite-ssr-deno')
    onTestFinished(() => project.dispose())
    const state = new PluginState({}, 'vite')
    onTestFinished(() => state.close())
    const worker = { name: 'worker-instance' }
    const plugin = viteHooks(state, { workerPlugins: () => worker })
    const result = (await call(
      plugin,
      'config',
      vite8,
      { root: project.root },
      {
        command: 'build',
        mode: 'production',
      },
    )) as UserConfig
    const plugins = result.worker?.plugins
    expect(typeof plugins).toBe('function')
    expect(typeof plugins === 'function' ? plugins() : undefined).toEqual([worker])
    const withoutWorkers = await setup()
    const { result: plain } = await configure(withoutWorkers, 'build')
    expect((plain as UserConfig | null)?.worker).toBeUndefined()
  })
})

describe('transform', () => {
  it('uses the platform of the environment and replaces import.meta.main only in builds', async () => {
    const { state, root, path } = await prepared({ 'deno.json': {} })
    const plugin = viteHooks(state)
    await call(plugin, 'config', vite8, { root }, { command: 'build', mode: 'production' })
    const code = 'export const main = import.meta.main\nexport const cwd = () => Deno.cwd()\n'
    const warnings: string[] = []
    const context = (environment: object): object => ({
      ...vite8,
      warn: (message: string) => warnings.push(message),
      environment,
      getModuleInfo: () => ({ isEntry: false }),
    })
    const client = { name: 'client', mode: 'build', config: { consumer: 'client' } }
    const built = (await call(plugin, 'transform', context(client), code, path('src/a.ts'))) as {
      code: string
    }
    expect(built.code).toContain('export const main = false')
    expect(warnings).toEqual([expect.stringContaining('src/a.ts:2:26 uses `Deno.cwd`')])
    const dev = { name: 'client', mode: 'dev', config: { consumer: 'client' } }
    expect(await call(plugin, 'transform', context(dev), code, path('src/b.ts'))).toBeNull()
    expect(warnings).toHaveLength(2)
    // A server environment on the Deno platform has Deno globals.
    const ssr = { name: 'ssr', mode: 'build', config: { consumer: 'server' } }
    await call(plugin, 'transform', context(ssr), code, path('src/c.ts'))
    expect(warnings).toHaveLength(2)
  })
})
