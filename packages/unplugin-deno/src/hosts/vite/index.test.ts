import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Plugin as VitePlugin, UserConfig } from 'vite'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { denoDir } from '../../../test/helpers/deno-dir.js'
import { tempProject } from '../../../test/helpers/temp-project.js'
import type { TempProject } from '../../../test/helpers/temp-project.js'
import { PluginState } from '../../core/state.js'
import { REMOTE_ALIAS, viteHooks } from './index.js'

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
    expect(marker.id).toBe(
      `\0deno:text:${importer.replace('server.ts', 'answer.ts').replaceAll('\\', '/')}.js`,
    )

    const watched: string[] = []
    const loaded = (await call(
      test.plugin,
      'load',
      { ...vite8, addWatchFile: (file: string) => watched.push(file) },
      marker.id,
    )) as { code: string }
    expect(loaded.code).toContain('export const answer: number = 42')
    expect(watched).toEqual([importer.replace('server.ts', 'answer.ts').replaceAll('\\', '/')])
  })
})
