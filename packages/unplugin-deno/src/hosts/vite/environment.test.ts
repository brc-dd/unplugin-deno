import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { denoDir } from '../../../test/helpers/deno-dir.js'
import { tempDir } from '../../../test/helpers/temp-dir.js'
import type { TempFiles } from '../../../test/helpers/temp-dir.js'
import { tempProject } from '../../../test/helpers/temp-project.js'
import type { Options } from '../../core/options.js'
import { PluginState } from '../../core/state.js'
import {
  conditionsToAdd,
  consumerOf,
  DEV_SERVER_BUNDLE,
  environmentPlatform,
  environmentTarget,
  targetOf,
} from './environment.js'

async function prepared(files: TempFiles, options: Options = {}): Promise<PluginState> {
  vi.stubEnv('DENO_DIR', await denoDir())
  const dir = await tempDir(files)
  onTestFinished(() => dir.dispose())
  const state = new PluginState({ cwd: dir.root, ...options }, 'vite')
  state.setHints({ platform: 'browser' })
  onTestFinished(() => state.close())
  await state.prepare()
  return state
}

describe('environment platforms', () => {
  it('builds client environments for the browser and server ones for Deno', async () => {
    const state = await prepared({ 'deno.json': {} })
    expect(consumerOf('client', undefined)).toBe('client')
    expect(consumerOf('ssr', undefined)).toBe('server')
    expect(consumerOf('worker', 'client')).toBe('client')
    expect(environmentPlatform(state, 'client', 'client')).toBe('browser')
    expect(environmentPlatform(state, 'ssr', 'server')).toBe('deno')
    expect(environmentPlatform(state, 'edge', 'server')).toBe('deno')
  })

  it('builds server environments for node without a deno.json', async () => {
    const state = await prepared({ 'package.json': { name: 'app' } })
    expect(environmentPlatform(state, 'ssr', 'server')).toBe('node')
  })

  it('applies a platform string to server environments only, and a record to any', async () => {
    const string = await prepared({ 'deno.json': {} }, { platform: 'node' })
    expect(environmentPlatform(string, 'client', 'client')).toBe('browser')
    expect(environmentPlatform(string, 'ssr', 'server')).toBe('node')
    const record = await prepared({ 'deno.json': {} }, { platform: { ssr: 'node', app: 'deno' } })
    expect(environmentPlatform(record, 'ssr', 'server')).toBe('node')
    expect(environmentPlatform(record, 'app', 'client')).toBe('deno')
    expect(environmentPlatform(record, 'edge', 'server')).toBe('deno')
    expect(environmentPlatform(record, 'client', 'client')).toBe('browser')
  })

  it('bundles npm: and jsr: for Deno server environments in the dev server only', async () => {
    const state = await prepared({ 'deno.json': {} })
    expect(environmentTarget(state, 'ssr', 'server', true)).toEqual({
      platform: 'deno',
      conditions: [],
      bundle: DEV_SERVER_BUNDLE,
    })
    expect(environmentTarget(state, 'ssr', 'server', false)).toEqual({
      platform: 'deno',
      conditions: [],
    })
    expect(environmentTarget(state, 'client', 'client', true)).toEqual({
      platform: 'browser',
      conditions: [],
    })
    const scan = { name: 'client', mode: 'scan', config: { consumer: 'client' as const } }
    expect(targetOf(state, scan).platform).toBe('browser')
    const build = { name: 'ssr', mode: 'build', config: { consumer: 'server' as const } }
    expect(targetOf(state, build).bundle).toBeUndefined()
  })

  it('adds a condition with the defaults a configured list replaces', () => {
    expect(conditionsToAdd(undefined, ['module', 'node'], 'deno')).toEqual([
      'module',
      'node',
      'deno',
    ])
    expect(conditionsToAdd(['custom'], ['module'], 'deno')).toEqual(['deno'])
    expect(conditionsToAdd(['deno'], ['module'], 'deno')).toBeUndefined()
  })
})

describe('PluginState targets', () => {
  it('resolves with the platform, externals and mirror generation of a target', async () => {
    vi.stubEnv('DENO_DIR', await denoDir())
    const project = await tempProject('vite-ssr-deno')
    onTestFinished(() => project.dispose())
    const state = new PluginState({ cwd: project.root }, 'vite')
    state.setHints({ platform: 'browser' })
    onTestFinished(() => state.close())
    const importer = project.path('src/server.ts')
    const deno = { platform: 'deno' as const, conditions: [] }
    const bundled = { ...deno, bundle: DEV_SERVER_BUNDLE }

    // The build's own platform (browser here): npm packages load from Deno's global cache.
    const browser = await state.resolve('npm:kleur@^4', importer)
    expect(browser?.type).toBe('path')
    expect(await state.resolve('npm:kleur@^4', importer, { target: deno })).toEqual({
      type: 'external',
      id: 'npm:kleur@4.1.5',
    })
    expect((await state.resolve('npm:kleur@^4', importer, { target: bundled }))?.type).toBe('path')

    // The mirror generation depends on the platform, not on the bundle patterns.
    const jsrBrowser = await state.resolve('@std/path', importer)
    const jsrDeno = await state.resolve('@std/path', importer, { target: bundled })
    expect(jsrBrowser?.type).toBe('mirror')
    expect(jsrDeno?.type).toBe('mirror')
    const generationOf = (outcome: typeof jsrBrowser): string =>
      outcome?.type === 'mirror'
        ? (outcome.path.slice(state.cacheDir.length + 1).split(/[\\/]/)[0] ?? '')
        : ''
    expect(generationOf(jsrBrowser)).toBe(state.generation)
    expect(generationOf(jsrDeno)).not.toBe(state.generation)
    expect(await state.resolve('@std/path', importer, { target: deno })).toEqual({
      type: 'external',
      id: 'jsr:@std/path@1.1.6',
    })

    // Every generation's manifest is flushed.
    await state.flush()
    for (const outcome of [jsrBrowser, jsrDeno]) {
      const generation = join(state.cacheDir, generationOf(outcome))
      expect(existsSync(join(generation, 'manifest.json'))).toBe(true)
    }
  })

  it('seeds the engine of a target with an explicit input', async () => {
    const state = await prepared(
      {
        'deno.json': { imports: { kleur: 'npm:kleur@^4' } },
        'main.ts': 'import kleur from "kleur"\nconsole.log(kleur)\n',
      },
      { debug: true },
    )
    const messages: string[] = []
    state.setLogTarget({ info: (message) => messages.push(message) })
    await state.addEntrypoints({ platform: 'deno' }, ['main.ts'])
    expect(messages.some((message) => message.includes('added 1 entrypoint(s)'))).toBe(true)
  })
})
