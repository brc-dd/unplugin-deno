import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { denoDir } from '../../../test/helpers/deno-dir.js'
import { tempProject } from '../../../test/helpers/temp-project.js'
import type { ResolveOutcome } from '../../core/resolve.js'
import { PluginState } from '../../core/state.js'
import type { HostResolve } from '../shared.js'
import type { DepsOptimizer } from './optimizer.js'
import {
  isExcluded,
  isOptimizable,
  isPackageFile,
  optimizedDependency,
  optimizerKey,
  optimizerPlugin,
  packageKind,
  registerScannedUrl,
} from './optimizer.js'

interface FakeInfo {
  id: string
  file: string
  src?: string
  browserHash?: string
}

/** An optimizer that records registrations (the parts of Vite's `DepsOptimizer` used). */
function fakeOptimizer(
  options: { noDiscovery?: boolean; exclude?: string[]; extensions?: string[] } = {},
): {
  optimizer: DepsOptimizer
  registered: [string, string][]
  optimized: Record<string, FakeInfo>
} {
  const registered: [string, string][] = []
  const optimized: Record<string, FakeInfo> = {}
  const discovered: Record<string, FakeInfo> = {}
  const optimizer = {
    options,
    metadata: { optimized, discovered, chunks: {} },
    registerMissingImport(id: string, resolved: string): FakeInfo {
      registered.push([id, resolved])
      const info = {
        id,
        file: `/app/node_modules/.vite/deps/${id}.js`,
        src: resolved,
        browserHash: 'h',
      }
      discovered[id] = info
      return info
    },
    getOptimizedDepId: (info: FakeInfo) => `${info.file}?v=${info.browserHash ?? ''}`,
  }
  return { optimizer: optimizer as unknown as DepsOptimizer, registered, optimized }
}

const noResolve: HostResolve = () => Promise.resolve(null)
const hostResolve: HostResolve = () =>
  Promise.resolve({ id: '/app/node_modules/kleur/colors.mjs?v=abc' })

describe('optimizer keys', () => {
  it('keys imports the way the dependency scanner records them', () => {
    for (const source of [
      'kleur',
      '@std/path',
      '@std/path/join',
      'npm:kleur@^4/colors',
      'jsr:@std/path@^1',
    ]) {
      expect(optimizerKey(source)).toBe(source)
    }
    for (const url of [
      'https://deno.land/x/mod.ts',
      'http://x.test/a.js',
      'data:text/javascript,1',
    ]) {
      expect(optimizerKey(url)).toBe(url)
    }
    for (const source of [
      './a.ts',
      '/a.ts',
      'C:\\a.ts',
      'kleur?raw',
      '#internal',
      '\0x',
      'virtual:x',
    ]) {
      expect(optimizerKey(source)).toBeNull()
    }
  })

  it('honours optimizeDeps.exclude (with subpaths) and extensions', () => {
    expect(isExcluded('kleur/colors', ['kleur'])).toBe(true)
    expect(isExcluded('kleurx', ['kleur'])).toBe(false)
    expect(isExcluded('kleur', undefined)).toBe(false)
    expect(isOptimizable('/a/index.mjs', {})).toBe(true)
    expect(isOptimizable('/a/style.css', {})).toBe(false)
    expect(isOptimizable('/a/comp.vue', { extensions: ['.vue'] })).toBe(true)
  })
})

describe('optimizedDependency', () => {
  const redirect: ResolveOutcome = {
    type: 'npm-redirect',
    request: 'kleur/colors',
    resolveDir: '/app/node_modules/kleur',
    packageJsonPath: '/app/node_modules/kleur/package.json',
    rawSpecifier: 'npm:kleur@^4/colors',
    fallbackPath: '/app/node_modules/kleur/colors.mjs',
    query: '',
  }
  it('registers a missing dependency under the specifier as written', async () => {
    const { optimizer, registered } = fakeOptimizer()
    const result = await optimizedDependency(
      optimizer,
      'npm:kleur@^4/colors',
      'node_modules',
      redirect,
      hostResolve,
      false,
    )
    expect(registered).toEqual([['npm:kleur@^4/colors', '/app/node_modules/kleur/colors.mjs']])
    expect(result).toEqual({ id: '/app/node_modules/.vite/deps/npm:kleur@^4/colors.js?v=h' })
    // The second import finds the discovered entry.
    await optimizedDependency(
      optimizer,
      'npm:kleur@^4/colors',
      'node_modules',
      redirect,
      hostResolve,
      false,
    )
    expect(registered).toHaveLength(1)
  })

  it('uses optimized entries and never registers excluded or unbundleable files', async () => {
    const fake = fakeOptimizer({ exclude: ['kleur'] })
    fake.optimized['@std/path'] = { id: '@std/path', file: '/deps/std.js', browserHash: 'x' }
    const mirror: ResolveOutcome = { type: 'mirror', path: '/m/mod.ts.js', url: 'https://jsr.io/x' }
    expect(
      await optimizedDependency(fake.optimizer, '@std/path', 'mirror', mirror, noResolve, false),
    ).toEqual({
      id: '/deps/std.js?v=x',
    })
    expect(
      await optimizedDependency(
        fake.optimizer,
        'kleur',
        'node_modules',
        redirect,
        hostResolve,
        false,
      ),
    ).toBeNull()
    const css: ResolveOutcome = { type: 'path', path: '/app/node_modules/pkg/a.css' }
    expect(
      await optimizedDependency(fake.optimizer, 'pkg/a.css', 'node_modules', css, noResolve, false),
    ).toBeNull()
    expect(fake.registered).toEqual([])
  })

  it('registers nothing when discovery is off', async () => {
    const { optimizer, registered } = fakeOptimizer({ noDiscovery: true })
    const result = await optimizedDependency(
      optimizer,
      'kleur',
      'node_modules',
      redirect,
      hostResolve,
      false,
    )
    expect(result).toBeNull()
    expect(registered).toEqual([])
  })

  it('registers global-cache packages during the scan and hides them from it', async () => {
    const { optimizer, registered } = fakeOptimizer()
    const global: ResolveOutcome = {
      type: 'path',
      path: '/deno/npm/registry.npmjs.org/ms/2.1.3/index.js',
    }
    expect(
      await optimizedDependency(optimizer, 'ms', 'global-cache', global, noResolve, true),
    ).toEqual({
      id: 'ms',
      external: true,
    })
    expect(registered).toEqual([['ms', '/deno/npm/registry.npmjs.org/ms/2.1.3/index.js']])
    // node_modules files and mirror files are recorded by the scanner itself.
    expect(
      await optimizedDependency(optimizer, 'kleur', 'node_modules', redirect, hostResolve, true),
    ).toBeNull()
    expect(registered).toHaveLength(1)
  })
})

describe('package files and URL registration', () => {
  it('classifies outcomes and importers, and registers scanned remote URLs', async () => {
    vi.stubEnv('DENO_DIR', await denoDir())
    const project = await tempProject('vite-ssr-deno')
    onTestFinished(() => project.dispose())
    const state = new PluginState({ cwd: project.root, platform: 'browser' }, 'vite')
    onTestFinished(() => state.close())
    const importer = project.path('src/server.ts')
    const npm = await state.resolve('npm:kleur@^4', importer)
    expect(packageKind(state, npm)).toBe('global-cache')
    const jsr = await state.resolve('@std/path', importer)
    expect(packageKind(state, jsr)).toBe('mirror')
    expect(packageKind(state, { type: 'path', path: importer })).toBeNull()
    expect(packageKind(state, { type: 'external', id: 'node:fs' })).toBeNull()
    expect(isPackageFile(state, jsr?.type === 'mirror' ? jsr.path : '')).toBe(true)
    expect(isPackageFile(state, npm?.type === 'path' ? npm.path : '')).toBe(true)
    expect(isPackageFile(state, importer)).toBe(false)
    expect(isPackageFile(state, 'virtual:x')).toBe(false)

    const target = { platform: 'browser' as const, conditions: [] }
    const { optimizer, registered } = fakeOptimizer()
    const url = 'https://deno.land/std@0.224.0/text/closest_string.ts'
    expect(await registerScannedUrl(state, target, optimizer, url, importer)).toBe(true)
    expect(registered[0]?.[0]).toBe(url)
    expect(registered[0]?.[1]).toMatch(/closest_string\.ts\.js$/)
    expect(await registerScannedUrl(state, target, optimizer, 'jsr:@std/path@^1', importer)).toBe(
      false,
    )
    expect(await registerScannedUrl(state, target, undefined, url, importer)).toBe(false)
  })

  it('leaves imports of app files to the scanner in the optimizer plugin', async () => {
    vi.stubEnv('DENO_DIR', await denoDir())
    const project = await tempProject('vite-ssr-deno')
    onTestFinished(() => project.dispose())
    const state = new PluginState({ cwd: project.root, platform: 'browser' }, 'vite')
    onTestFinished(() => state.close())
    await state.prepare()
    const plugin = optimizerPlugin(
      state,
      { platform: 'browser' },
      'abcd1234',
      async () => {},
      () => undefined,
    )
    expect(plugin.name).toBe('unplugin-deno:optimizer:abcd1234')
    const hook = plugin.resolveId
    const handler =
      typeof hook === 'object' && hook !== null && 'handler' in hook ? hook.handler : undefined
    const context = { resolve: () => Promise.resolve(null) }
    const call = (source: string, importer: string | undefined): Promise<unknown> =>
      Reflect.apply(handler as (...args: unknown[]) => Promise<unknown>, context, [
        source,
        importer,
        { kind: 'import-statement', isEntry: false },
      ])
    expect(await call('@std/path', project.path('src/server.ts'))).toBeNull()
    expect(await call('https://deno.land/x.ts', project.path('src/server.ts'))).toBeNull()
    const inPackage = await call('npm:kleur@^4', '/somewhere/node_modules/pkg/index.js')
    expect((inPackage as { id?: string } | null)?.id).toMatch(/kleur[\\/]4\.1\.5[\\/]index\.mjs$/)
  })
})
