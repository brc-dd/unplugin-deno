import { describe, expect, it } from 'vitest'
import { resolveOptions } from '../../core/options.js'
import type { BuildOptions } from 'esbuild'
import {
  applyJsx,
  buildOptions,
  configuresJsx,
  defineEnv,
  entryInput,
  entryList,
  hintsFor,
  settingsKey,
} from './options.js'

describe('entryInput and entryList', () => {
  it('reads every shape of entryPoints', () => {
    expect(entryInput(undefined)).toEqual([])
    expect(entryInput(['src/a.ts', { in: 'src/b.ts', out: 'b' }])).toEqual(['src/a.ts', 'src/b.ts'])
    expect(entryInput({ main: 'src/main.ts' })).toEqual({ main: 'src/main.ts' })
    expect(entryList({ main: 'src/main.ts', other: 'src/other.ts' })).toEqual([
      'src/main.ts',
      'src/other.ts',
    ])
    expect(entryList(undefined)).toEqual([])
  })
})

describe('hintsFor', () => {
  it('takes the root, platform, conditions and entries from the build options', () => {
    expect(
      hintsFor(
        {
          absWorkingDir: '/p',
          platform: 'neutral',
          conditions: ['worker'],
          entryPoints: [{ in: 'src/main.ts', out: 'main' }],
        },
        '0.28.2',
      ),
    ).toEqual({
      root: '/p',
      platform: 'neutral',
      conditions: ['worker'],
      input: ['src/main.ts'],
      version: '0.28.2',
      command: 'build',
    })
  })

  it("uses the process's working directory and esbuild's default platform (browser)", () => {
    const hints = hintsFor({}, undefined)
    expect(hints.root).toBe(process.cwd())
    expect(hints.platform).toBe('browser')
    expect(hints.input).toEqual([])
  })
})

describe('settingsKey', () => {
  it('changes with the options a loaded project depends on, and only with those', () => {
    const base = settingsKey({ absWorkingDir: '/p', platform: 'browser' })
    expect(settingsKey({ absWorkingDir: '/p', platform: 'browser', entryPoints: ['x.ts'] })).toBe(
      base,
    )
    expect(settingsKey({ absWorkingDir: '/q', platform: 'browser' })).not.toBe(base)
    expect(settingsKey({ absWorkingDir: '/p', platform: 'node' })).not.toBe(base)
    expect(settingsKey({ absWorkingDir: '/p', platform: 'browser', conditions: ['x'] })).not.toBe(
      base,
    )
    expect(
      settingsKey({ absWorkingDir: '/p', platform: 'browser', packages: 'external' }),
    ).not.toBe(base)
    expect(settingsKey({ absWorkingDir: '/p', platform: 'browser', packages: 'bundle' })).toBe(base)
  })
})

describe('buildOptions', () => {
  const context = { root: '/p', env: {} }

  it('keeps the options unless packages are external', () => {
    const base = resolveOptions({ external: ['npm:x'] }, context)
    expect(buildOptions(base, false)).toBe(base)
  })

  it('keeps npm: and jsr: specifiers external and pinned for packages: external', () => {
    const base = resolveOptions({ external: ['https://esm.sh/*'] }, context)
    const options = buildOptions(base, true)
    expect(options.external).toEqual(['https://esm.sh/*', 'npm:*', 'jsr:*'])
    expect(options.pinExternals).toBe(true)
    expect(base.external).toEqual(['https://esm.sh/*'])
    // Applying it again adds nothing.
    expect(buildOptions(options, true).external).toEqual(options.external)
    // An explicit pinExternals wins.
    expect(buildOptions(resolveOptions({ pinExternals: false }, context), true).pinExternals).toBe(
      false,
    )
  })
})

describe('JSX and env build options', () => {
  it('sees JSX configured by the build options or tsconfigRaw', () => {
    expect(configuresJsx({})).toBe(false)
    expect(configuresJsx({ jsx: 'automatic' })).toBe(true)
    expect(configuresJsx({ jsxDev: true })).toBe(true)
    expect(configuresJsx({ tsconfigRaw: { compilerOptions: { jsxImportSource: 'x' } } })).toBe(true)
    expect(configuresJsx({ tsconfigRaw: '{ "compilerOptions": { "jsx": "react-jsx" } }' })).toBe(
      true,
    )
    expect(configuresJsx({ tsconfigRaw: '{ "compilerOptions": {} }' })).toBe(false)
    expect(configuresJsx({ tsconfigRaw: 'not json' })).toBe(false)
  })

  it('applies the automatic and classic runtimes', () => {
    const automatic: BuildOptions = {}
    applyJsx(automatic, { runtime: 'automatic', importSource: 'preact', development: true })
    expect(automatic).toEqual({ jsx: 'automatic', jsxImportSource: 'preact', jsxDev: true })
    const classic: BuildOptions = {}
    applyJsx(classic, { runtime: 'classic', factory: 'h', fragment: 'Fragment' })
    expect(classic).toEqual({ jsx: 'transform', jsxFactory: 'h', jsxFragment: 'Fragment' })
  })

  it('defines process.env entries for identifier keys, keeping the build’s own', () => {
    const options: BuildOptions = { define: { 'process.env.PUBLIC_B': '"mine"' } }
    defineEnv(options, [
      ['PUBLIC_A', 'a "b"'],
      ['PUBLIC_B', 'b'],
      ['PUBLIC-C', 'c'],
    ])
    expect(options.define).toEqual({
      'process.env.PUBLIC_A': '"a \\"b\\""',
      'process.env.PUBLIC_B': '"mine"',
    })
    const untouched: BuildOptions = {}
    defineEnv(untouched, [])
    expect(untouched).toEqual({})
  })
})
