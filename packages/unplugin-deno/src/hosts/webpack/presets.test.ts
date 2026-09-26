import { describe, expect, it } from 'vitest'
import type { ExternalsPresetsOptions, TakenPreset } from './presets.js'
import { presetExternal, presetMessages, takeOverPresets } from './presets.js'

const WEBPACK_WEB: TakenPreset = { kind: 'web', schemes: true, async: false, css: true }
const RSPACK_WEB: TakenPreset = { kind: 'web', schemes: false, async: false, css: true }
const DENO: TakenPreset = { kind: 'deno' }

const webpackWeb = (request: string, dependencyType = 'esm') =>
  presetExternal([WEBPACK_WEB], request, dependencyType)
const rspackWeb = (request: string, dependencyType = 'esm') =>
  presetExternal([RSPACK_WEB], request, dependencyType)
const deno = (request: string, dependencyType = 'esm') =>
  presetExternal([DENO], request, dependencyType)

describe('takeOverPresets', () => {
  it('turns off the presets webpack enabled by default and applies them after the plugin', () => {
    const presets: ExternalsPresetsOptions = { web: true, deno: true, webAsync: false }
    const decision = takeOverPresets(presets, {}, 'webpack', false)
    expect(presets).toEqual({ web: false, deno: false, webAsync: false })
    // In webpack's order: the deno preset first.
    expect(decision).toEqual({
      taken: [{ kind: 'deno' }, { kind: 'web', schemes: true, async: false, css: false }],
      kept: [],
    })
  })

  it('keeps presets the user set explicitly', () => {
    const presets: ExternalsPresetsOptions = { web: true, deno: true }
    const decision = takeOverPresets(presets, { web: true, deno: true }, 'webpack', true)
    expect(presets).toEqual({ web: true, deno: true })
    expect(decision).toEqual({ taken: [], kept: ['deno', 'web'] })
  })

  it("takes Rspack's web preset (http(s): only) and webAsync", () => {
    const presets: ExternalsPresetsOptions = { webAsync: true }
    expect(takeOverPresets(presets, {}, 'rspack', true)).toEqual({
      taken: [{ kind: 'web', schemes: false, async: true, css: true }],
      kept: [],
    })
    expect(presets).toEqual({ web: false, webAsync: false })
  })

  it('does nothing for presets that are off', () => {
    const presets: ExternalsPresetsOptions = { web: false }
    expect(takeOverPresets(presets, {}, 'webpack', false)).toEqual({ taken: [], kept: [] })
    expect(presets).toEqual({ web: false })
  })
})

describe('presetExternal', () => {
  it("applies webpack's web preset (≥ 5.102) to requests the plugin leaves alone", () => {
    const external = webpackWeb
    expect(external('//cdn.example.com/x.js')).toEqual({
      request: '//cdn.example.com/x.js',
      type: 'module',
    })
    expect(external('std:kv-storage')).toEqual({ request: 'std:kv-storage', type: 'module' })
    expect(external('jsr:@std/path')).toEqual({ request: 'jsr:@std/path', type: 'module' })
    expect(external('https://example.com/bg.png', 'url')).toEqual({
      request: 'https://example.com/bg.png',
      type: 'asset',
    })
    expect(external('#icon', 'url')).toEqual({ request: '#icon', type: 'asset' })
    expect(external('https://fonts.example/a.css', 'css-import')).toEqual({
      request: 'https://fonts.example/a.css',
      type: 'css-import',
    })
    expect(external('#icon')).toBeUndefined()
    expect(external('./local.js')).toBeUndefined()
    expect(external('react')).toBeUndefined()
    expect(presetExternal([{ ...WEBPACK_WEB, async: true }], 'std:x', 'esm')).toEqual({
      request: 'std:x',
      type: 'import',
    })
    // Without experiments.css a CSS import of a URL is a module external, as webpack does it.
    expect(
      presetExternal([{ ...WEBPACK_WEB, css: false }], 'https://a.example/b.css', 'css-import'),
    ).toEqual({ request: 'https://a.example/b.css', type: 'module' })
  })

  it("applies Rspack's web preset (no jsr:/npm:)", () => {
    const external = rspackWeb
    expect(external('https://esm.sh/x')).toEqual({ request: 'https://esm.sh/x', type: 'module' })
    expect(external('https://example.com/a.css')).toEqual({
      request: 'https://example.com/a.css',
      type: 'css-import',
    })
    expect(external('#frag', 'url')).toEqual({ request: '#frag', type: 'asset' })
    expect(external('https://fonts.example/a.css', 'css-import')).toEqual({
      request: 'https://fonts.example/a.css',
      type: 'css-import',
    })
    expect(external('std:x', 'url')).toBeUndefined()
    expect(external('jsr:@std/path')).toBeUndefined()
    expect(external('npm:kleur')).toBeUndefined()
  })

  it("applies webpack's deno preset: Deno protocols as written, bare builtins with node:", () => {
    const external = deno
    expect(external('node:fs')).toEqual({ request: 'node:fs', type: 'module-import' })
    expect(external('node:fs', 'commonjs')).toEqual({ request: 'node:fs', type: 'node-commonjs' })
    expect(external('npm:kleur@4')).toEqual({ request: 'npm:kleur@4', type: 'module-import' })
    expect(external('https://deno.land/x.ts')).toEqual({
      request: 'https://deno.land/x.ts',
      type: 'module-import',
    })
    expect(external('fs')).toEqual({ request: 'node:fs', type: 'module-import' })
    expect(external('fs/promises', 'commonjs')).toEqual({
      request: 'node:fs/promises',
      type: 'node-commonjs',
    })
    expect(external('react')).toBeUndefined()
    expect(external('./fs')).toBeUndefined()
  })

  it('applies the deno preset before the web preset, as webpack does', () => {
    expect(presetExternal([DENO, WEBPACK_WEB], 'https://esm.sh/x', 'esm')).toEqual({
      request: 'https://esm.sh/x',
      type: 'module-import',
    })
    expect(presetExternal([DENO, WEBPACK_WEB], 'std:x', 'esm')).toEqual({
      request: 'std:x',
      type: 'module',
    })
    expect(presetExternal([], 'https://esm.sh/x', 'esm')).toBeUndefined()
  })
})

describe('presetMessages', () => {
  it('describes taken, kept presets and buildHttp at info level', () => {
    const messages = presetMessages(
      { taken: [{ kind: 'deno' }, WEBPACK_WEB], kept: ['webAsync'] },
      'webpack',
      true,
    )
    expect(messages).toHaveLength(4)
    expect(messages[0]).toMatch(/^\[webpack\] target deno: unplugin-deno applies its externals/)
    expect(messages[1]).toContain(
      '[webpack] externalsPresets.web: unplugin-deno resolves jsr:, npm: and https: imports itself',
    )
    expect(messages[2]).toContain('[webpack] externalsPresets.webAsync is set in the config')
    expect(messages[3]).toContain('[webpack] experiments.buildHttp is set')
    expect(presetMessages({ taken: [RSPACK_WEB], kept: [] }, 'rspack', false)).toEqual([
      expect.stringContaining('[rspack] externalsPresets.web: unplugin-deno resolves https:'),
    ])
  })
})
