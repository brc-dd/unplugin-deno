import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DenoPluginError } from '../diagnostics/errors.js'
import type { Options, ResolvedOptions } from './options.js'
import {
  DEFAULT_ALLOW_IMPORT,
  defaultCacheDir,
  denoGlobalsFor,
  pinExternalsFor,
  resolveOptions,
} from './options.js'

const root = resolve('/project')
const context = { root, env: {} }
const hook = (): null => null

function resolveWith(
  options: Options | undefined,
  env: Record<string, string> = {},
): ResolvedOptions {
  return resolveOptions(options, { root, env })
}

describe('resolveOptions', () => {
  it('applies the documented defaults', () => {
    expect(resolveOptions(undefined, context)).toEqual({
      cwd: root,
      config: { mode: 'discover' },
      cacheDir: null,
      engine: 'auto',
      denoBinary: 'deno',
      platform: 'auto',
      conditions: [],
      npm: 'auto',
      lockfile: 'auto',
      cachedOnly: false,
      allowImport: [...DEFAULT_ALLOW_IMPORT],
      exclude: [],
      importers: { include: [], exclude: [] },
      external: [],
      bundle: [],
      pinExternals: null,
      emitDenoConfig: false,
      importAttributes: true,
      wasm: true,
      importMetaMain: true,
      env: false,
      denoGlobals: null,
      jsx: 'auto',
      checks: { browserSafety: true, duplicates: true, lockfile: true },
      debug: false,
      resolve: undefined,
    } satisfies ResolvedOptions)
    expect(resolveWith({})).toEqual(resolveWith(undefined))
  })

  it("uses Deno's --allow-import defaults", () => {
    expect(DEFAULT_ALLOW_IMPORT).toEqual([
      'deno.land',
      'jsr.io',
      'esm.sh',
      'cdn.jsdelivr.net',
      'raw.githubusercontent.com',
      'gist.githubusercontent.com',
    ])
    expect(Object.isFrozen(DEFAULT_ALLOW_IMPORT)).toBe(true)
  })

  it('resolves paths against the host root and cwd', () => {
    const resolved = resolveWith({
      cwd: 'app',
      config: 'config/deno.jsonc',
      cacheDir: '.cache/deno',
    })
    expect(resolved.cwd).toBe(resolve(root, 'app'))
    expect(resolved.config).toEqual({
      mode: 'file',
      path: resolve(root, 'app', 'config/deno.jsonc'),
    })
    expect(resolved.cacheDir).toBe(resolve(root, 'app', '.cache/deno'))
  })

  it('keeps absolute paths', () => {
    const elsewhere = resolve('/elsewhere/deno.json')
    expect(resolveWith({ config: elsewhere }).config).toEqual({ mode: 'file', path: elsewhere })
  })

  it('disables config discovery with config: false', () => {
    expect(resolveWith({ config: false }).config).toEqual({ mode: 'none' })
  })

  it('passes explicit values through', () => {
    const resolved = resolveWith({
      engine: 'loader',
      denoBinary: '/opt/deno/bin/deno',
      platform: 'deno',
      conditions: ['worker'],
      npm: 'deno-cache',
      lockfile: 'frozen',
      cachedOnly: true,
      allowImport: ['example.com'],
      exclude: /^react$/,
      importers: { include: ['src/**'], exclude: [/node_modules/] },
      external: ['npm:*'],
      bundle: ['npm:preact'],
      pinExternals: false,
      emitDenoConfig: 'server.deno.json',
      importAttributes: false,
      importMetaMain: false,
      env: { prefix: 'PUBLIC_', allow: ['MODE'], files: ['.env'] },
      denoGlobals: 'error',
      jsx: 'deno',
      checks: { duplicates: false },
      debug: true,
      resolve: hook,
    })
    expect(resolved).toMatchObject({
      engine: 'loader',
      denoBinary: '/opt/deno/bin/deno',
      platform: 'deno',
      conditions: ['worker'],
      npm: 'deno-cache',
      lockfile: 'frozen',
      cachedOnly: true,
      allowImport: ['example.com'],
      exclude: [/^react$/],
      importers: { include: ['src/**'], exclude: [/node_modules/] },
      external: ['npm:*'],
      bundle: ['npm:preact'],
      pinExternals: false,
      emitDenoConfig: 'server.deno.json',
      importAttributes: false,
      importMetaMain: false,
      env: { prefix: ['PUBLIC_'], allow: ['MODE'], files: ['.env'] },
      denoGlobals: 'error',
      jsx: 'deno',
      checks: { browserSafety: true, duplicates: false, lockfile: true },
      debug: true,
    })
    expect(resolved.resolve).toBe(hook)
  })

  it('accepts per-environment platforms', () => {
    const platform = resolveWith({ platform: { client: 'browser', ssr: 'deno' } }).platform
    expect(platform).toEqual({ client: 'browser', ssr: 'deno' })
    expect(Object.isFrozen(platform)).toBe(true)
  })

  it('normalises checks and env shorthands', () => {
    expect(resolveWith({ checks: false }).checks).toEqual({
      browserSafety: false,
      duplicates: false,
      lockfile: false,
    })
    expect(resolveWith({ checks: true }).checks).toEqual(resolveWith({}).checks)
    // `files: null` stands for the default files (`.env`, `.env.local`).
    expect(resolveWith({ env: {} }).env).toEqual({
      prefix: [],
      allow: [],
      files: null,
      server: false,
    })
    expect(resolveWith({ env: { prefix: ['A_', 'B_'] } }).env).toMatchObject({
      prefix: ['A_', 'B_'],
    })
    expect(
      resolveWith({ env: { prefix: 'PUBLIC_', allow: ['MODE'], files: [], server: true } }).env,
    ).toEqual({ prefix: ['PUBLIC_'], allow: ['MODE'], files: [], server: true })
  })

  it('rejects env settings that would inline every variable', () => {
    expect(() => resolveWith({ env: { prefix: '' } })).toThrow(
      expect.objectContaining({
        code: 'OPTIONS_INVALID',
        message: expect.stringContaining('env.prefix'),
      }),
    )
    expect(() => resolveWith({ env: { prefix: ['PUBLIC_', ''] } })).toThrow(
      expect.objectContaining({ code: 'OPTIONS_INVALID' }),
    )
    expect(() => resolveWith({ env: { allow: [''] } })).toThrow(
      expect.objectContaining({
        code: 'OPTIONS_INVALID',
        message: expect.stringContaining('env.allow'),
      }),
    )
    expect(() => resolveWith({ env: { server: 'yes' } as never })).toThrow(
      expect.objectContaining({
        code: 'OPTIONS_INVALID',
        message: expect.stringContaining('env.server'),
      }),
    )
  })

  it('reads DEBUG unless debug is explicit', () => {
    expect(resolveWith({}, { DEBUG: 'unplugin-deno' }).debug).toBe(true)
    expect(resolveWith({}, { DEBUG: 'vite:*' }).debug).toBe(false)
    expect(resolveWith({ debug: false }, { DEBUG: 'unplugin-deno' }).debug).toBe(false)
  })

  it('copies arrays instead of aliasing user input', () => {
    const conditions = ['worker']
    const resolved = resolveWith({ conditions })
    conditions.push('mutated')
    expect(resolved.conditions).toEqual(['worker'])
  })

  it.each([
    [
      { engine: 'wasm' },
      "Invalid option `engine`: expected one of 'auto', 'loader', 'deno', got 'wasm'.",
    ],
    [{ platform: 'bun' }, 'Invalid option `platform`'],
    [{ platform: { client: 'web' } }, 'Invalid option `platform.client`'],
    [{ config: true }, 'Invalid option `config`: expected a non-empty path or false, got true.'],
    [{ config: '' }, 'Invalid option `config`'],
    [{ cwd: 42 }, 'Invalid option `cwd`: expected a string, got 42.'],
    [{ conditions: 'deno' }, 'Invalid option `conditions`: expected an array of strings'],
    [{ cachedOnly: 'yes' }, 'Invalid option `cachedOnly`: expected a boolean'],
    [{ external: [42] }, 'Invalid option `external`: expected strings or RegExps, got 42.'],
    [{ importers: [] }, 'Invalid option `importers`'],
    [{ env: 'PUBLIC_' }, 'Invalid option `env`'],
    [{ env: { allow: 'X' } }, 'Invalid option `env.allow`'],
    [{ checks: { lockfile: 1 } }, 'Invalid option `checks.lockfile`'],
    [{ emitDenoConfig: '' }, 'Invalid option `emitDenoConfig`'],
    [{ denoGlobals: 'throw' }, 'Invalid option `denoGlobals`'],
    [{ wasm: 'yes' }, 'Invalid option `wasm`: expected a boolean'],
    [{ importMetaMain: 1 }, 'Invalid option `importMetaMain`: expected a boolean'],
    [{ jsx: 'preact' }, "Invalid option `jsx`: expected one of 'auto', 'host', 'deno'"],
    [{ resolve: 'x' }, 'Invalid option `resolve`: expected a function'],
  ])('rejects %j', (options, message) => {
    let error: unknown
    try {
      resolveWith(options as unknown as Options)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(DenoPluginError)
    expect(error).toMatchObject({ code: 'OPTIONS_INVALID' })
    expect((error as Error).message).toContain(message)
  })

  it('rejects non-object options', () => {
    expect(() => resolveWith('deno' as unknown as Options)).toThrow(/Invalid option `options`/)
  })
})

describe('per-platform defaults', () => {
  const defaults = resolveOptions(undefined, context)

  it('pins externals for the deno platform only, unless configured', () => {
    expect(pinExternalsFor(defaults, 'deno')).toBe(true)
    expect(pinExternalsFor(defaults, 'node')).toBe(false)
    expect(pinExternalsFor(resolveWith({ pinExternals: false }), 'deno')).toBe(false)
    expect(pinExternalsFor(resolveWith({ pinExternals: true }), 'browser')).toBe(true)
  })

  it('warns about Deno globals in browser bundles only, unless configured', () => {
    expect(denoGlobalsFor(defaults, 'browser')).toBe('warn')
    expect(denoGlobalsFor(defaults, 'deno')).toBe('off')
    expect(denoGlobalsFor(resolveWith({ denoGlobals: 'error' }), 'node')).toBe('error')
  })
})

describe('defaultCacheDir', () => {
  it('lives under node_modules like Vite', () => {
    expect(defaultCacheDir(root)).toBe(join(root, 'node_modules', '.unplugin-deno'))
  })
})
