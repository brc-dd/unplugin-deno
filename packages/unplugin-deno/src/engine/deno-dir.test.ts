import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { freshDenoDir } from '../../test/helpers/deno-dir.js'
import { loadVendoredDenoLoader, setLoaderFetch } from '../vendored-deno-loader.js'
import type { DenoDirContext } from './deno-dir.js'
import { resolveDenoDir } from './deno-dir.js'

describe('resolveDenoDir', () => {
  it.each<[string, DenoDirContext, string | undefined]>([
    [
      'DENO_DIR wins',
      {
        env: { DENO_DIR: '/cache/deno', XDG_CACHE_HOME: '/xdg', HOME: '/home/u' },
        platform: 'linux',
      },
      '/cache/deno',
    ],
    [
      'DENO_DIR is normalized',
      { env: { DENO_DIR: '/cache//deno/' }, platform: 'linux' },
      '/cache/deno',
    ],
    [
      'relative DENO_DIR (posix)',
      { env: { DENO_DIR: 'cache/deno' }, platform: 'darwin', cwd: '/work' },
      '/work/cache/deno',
    ],
    [
      'relative DENO_DIR (win32)',
      { env: { DENO_DIR: 'cache\\deno' }, platform: 'win32', cwd: 'C:\\work' },
      'C:\\work\\cache\\deno',
    ],
    [
      'absolute DENO_DIR (win32)',
      { env: { DENO_DIR: 'D:\\deno-cache' }, platform: 'win32', cwd: 'C:\\work' },
      'D:\\deno-cache',
    ],
    [
      'empty DENO_DIR is ignored',
      { env: { DENO_DIR: '', HOME: '/home/u' }, platform: 'linux' },
      '/home/u/.cache/deno',
    ],
    [
      'XDG_CACHE_HOME on Linux',
      { env: { XDG_CACHE_HOME: '/xdg', HOME: '/home/u' }, platform: 'linux' },
      '/xdg/deno',
    ],
    [
      'XDG_CACHE_HOME on macOS',
      { env: { XDG_CACHE_HOME: '/xdg', HOME: '/Users/u' }, platform: 'darwin' },
      '/xdg/deno',
    ],
    [
      'XDG_CACHE_HOME on Windows',
      { env: { XDG_CACHE_HOME: 'C:\\xdg', USERPROFILE: 'C:\\Users\\u' }, platform: 'win32' },
      'C:\\xdg\\deno',
    ],
    [
      'macOS cache directory',
      { env: { HOME: '/Users/u' }, platform: 'darwin' },
      '/Users/u/Library/Caches/deno',
    ],
    [
      'Linux cache directory',
      { env: { HOME: '/home/u' }, platform: 'linux' },
      '/home/u/.cache/deno',
    ],
    [
      'Windows cache directory (USERPROFILE, like the wasm build)',
      { env: { USERPROFILE: 'C:\\Users\\u', LOCALAPPDATA: 'D:\\Local' }, platform: 'win32' },
      'C:\\Users\\u\\AppData\\Local\\deno',
    ],
    ['HOME is not used on Windows', { env: { HOME: '/home/u' }, platform: 'win32' }, undefined],
    ['no home directory', { env: {}, platform: 'linux' }, undefined],
  ])('%s', (_name, context, expected) => {
    expect(resolveDenoDir(context)).toBe(expected)
  })

  it('reads the current process by default', () => {
    vi.stubEnv('DENO_DIR', join(process.cwd(), 'some-deno-dir'))
    expect(resolveDenoDir()).toBe(join(process.cwd(), 'some-deno-dir'))
  })

  it('agrees with the vendored loader when only XDG_CACHE_HOME is set', async () => {
    const xdg = await freshDenoDir()
    onTestFinished(() => xdg.dispose())
    vi.stubEnv('DENO_DIR', '')
    vi.stubEnv('XDG_CACHE_HOME', xdg.path)
    const url = 'https://example.test/xdg.ts'
    setLoaderFetch(async () => new Response('export const where = "xdg"\n'))
    onTestFinished(() => setLoaderFetch(null))
    const { RequestedModuleType, Workspace } = await loadVendoredDenoLoader()
    const workspace = new Workspace({ noConfig: true, noLock: true })
    onTestFinished(() => (workspace as unknown as Disposable)[Symbol.dispose]())
    const loader = await workspace.createLoader()
    onTestFinished(() => (loader as unknown as Disposable)[Symbol.dispose]())
    const loaded = await loader.load(url, RequestedModuleType.Default)
    expect(loaded.kind).toBe('module')
    const expected = resolveDenoDir()
    expect(expected).toBe(join(xdg.path, 'deno'))
    expect(existsSync(join(expected ?? '', 'remote', 'https', 'example.test'))).toBe(true)
  })
})
