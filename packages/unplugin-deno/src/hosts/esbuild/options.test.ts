import { describe, expect, it } from 'vitest'
import { resolveOptions } from '../../core/options.js'
import { buildOptions, entryInput, entryList, hintsFor, settingsKey } from './options.js'

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
