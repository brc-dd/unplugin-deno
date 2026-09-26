import { describe, expect, it } from 'vitest'
import type { NodeModulesInfo } from '../config/node-modules.js'
import { jsrNpmName, jsrRouteFor, jsrToNpmSpecifier } from './jsr-npm.js'

function nodeModules(overrides: Partial<NodeModulesInfo> = {}): NodeModulesInfo {
  return {
    mode: 'auto',
    explicit: true,
    dir: '/p/node_modules',
    layout: 'isolated',
    hasJsrDeps: false,
    foreignManager: null,
    ...overrides,
  }
}

describe('the npm names of JSR packages', () => {
  it("maps @scope/name to @jsr/scope__name like JSR's npm registry", () => {
    expect(jsrNpmName('@std/path')).toBe('@jsr/std__path')
    expect(jsrNpmName('@luca/flag')).toBe('@jsr/luca__flag')
  })

  it('keeps the range and the subpath of jsr: specifiers', () => {
    expect(jsrToNpmSpecifier('jsr:@std/path@^1/posix/join')).toBe(
      'npm:@jsr/std__path@^1/posix/join',
    )
    expect(jsrToNpmSpecifier('jsr:@std/path@1.1.6')).toBe('npm:@jsr/std__path@1.1.6')
    expect(jsrToNpmSpecifier('jsr:@std/path')).toBe('npm:@jsr/std__path')
    expect(jsrToNpmSpecifier('jsr:/@std/path@^1/')).toBe('npm:@jsr/std__path@^1')
    expect(jsrToNpmSpecifier('npm:kleur@4')).toBeUndefined()
    expect(jsrToNpmSpecifier('jsr:unscoped')).toBeUndefined()
  })
})

describe('jsrRouteFor', () => {
  it('takes node_modules/@jsr with jsrDepsInNodeModules or an @jsr directory, for node_modules builds', () => {
    expect(
      jsrRouteFor({ jsrDepsInNodeModules: true, nodeModules: nodeModules() }, 'node_modules'),
    ).toEqual({ route: 'node_modules', reason: '`"jsrDepsInNodeModules": true`' })
    expect(
      jsrRouteFor(
        { jsrDepsInNodeModules: false, nodeModules: nodeModules({ hasJsrDeps: true }) },
        'node_modules',
      ),
    ).toEqual({ route: 'node_modules', reason: '/p/node_modules/@jsr exists' })
    expect(
      jsrRouteFor({ jsrDepsInNodeModules: false, nodeModules: nodeModules() }, 'node_modules')
        .route,
    ).toBe('mirror')
    // Deno uses its global cache (nodeModulesDir "none", or npm: 'deno-cache'): no @jsr route.
    expect(
      jsrRouteFor(
        { jsrDepsInNodeModules: true, nodeModules: nodeModules({ hasJsrDeps: true }) },
        'deno-cache',
      ),
    ).toEqual({ route: 'mirror', reason: 'npm packages come from the Deno cache' })
  })
})
