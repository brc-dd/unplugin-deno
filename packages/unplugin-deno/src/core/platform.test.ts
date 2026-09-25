import { describe, expect, it } from 'vitest'
import type { ResolvedModule } from '../engine/types.js'
import type { Pattern, Platform } from './options.js'
import {
  conditionsFor,
  derivePlatform,
  enginePlatformFor,
  externalOutcomeFor,
  isExternal,
  matchPattern,
  pinSpecifier,
} from './platform.js'
import { parseSpecifier } from './specifier.js'

const withConfig = { configPath: '/proj/deno.json' }
const withoutConfig = { configPath: null }

describe('derivePlatform', () => {
  it('takes an explicit platform option first', () => {
    for (const platform of ['browser', 'node', 'deno', 'neutral'] as const) {
      expect(derivePlatform({ platform }, { platformHint: 'browser' }, withConfig)).toBe(platform)
    }
  })

  it('looks environment names up in a platform record, falling back to auto', () => {
    const record = { platform: { client: 'browser', ssr: 'deno' } as const }
    expect(derivePlatform(record, {}, withoutConfig, 'client')).toBe('browser')
    expect(derivePlatform(record, {}, withoutConfig, 'ssr')).toBe('deno')
    expect(derivePlatform(record, {}, withoutConfig, 'other')).toBe('node')
    expect(derivePlatform(record, {}, withoutConfig)).toBe('node')
  })

  it.each([
    ['browser', withConfig, 'browser'],
    ['browser', withoutConfig, 'browser'],
    ['deno', withoutConfig, 'deno'],
    ['node', withConfig, 'deno'],
    ['node', withoutConfig, 'node'],
    ['neutral', withConfig, 'deno'],
    ['neutral', withoutConfig, 'node'],
    [undefined, withConfig, 'deno'],
    [undefined, withoutConfig, 'node'],
  ] as const)('host hint %s with %j → %s (§5.6)', (hint, project, expected) => {
    expect(derivePlatform({ platform: 'auto' }, { platformHint: hint }, project)).toBe(expected)
  })
})

describe('conditionsFor / enginePlatformFor', () => {
  it('adds deno for the Deno platform and keeps extra conditions once', () => {
    expect(conditionsFor('deno', [])).toEqual(['deno'])
    expect(conditionsFor('deno', ['deno', 'worker'])).toEqual(['deno', 'worker'])
    expect(conditionsFor('browser', ['development', 'development'])).toEqual(['development'])
    expect(conditionsFor('node', [])).toEqual([])
    expect(conditionsFor('neutral', ['x'])).toEqual(['x'])
  })

  it('maps the browser to the browser engine and everything else to node', () => {
    expect(enginePlatformFor('browser')).toBe('browser')
    expect(enginePlatformFor('node')).toBe('node')
    expect(enginePlatformFor('deno')).toBe('node')
    expect(enginePlatformFor('neutral')).toBe('node')
  })
})

describe('matchPattern', () => {
  it.each<[Pattern[], string, boolean]>([
    [['npm:*'], 'npm:kleur@^4/colors', true],
    [['npm:*'], 'jsr:@std/path', false],
    [['jsr:@std/*'], 'jsr:@std/path@^1/join', true],
    [['jsr:@std/*'], 'jsr:@other/path', false],
    [['npm:kleur'], 'npm:kleur', true],
    [['npm:kleur'], 'npm:kleur@^4', true],
    [['npm:kleur'], 'npm:kleur@4.1.5/colors', true],
    [['npm:kleur'], 'npm:kleurx', false],
    [['npm:kleur@4'], 'npm:kleur@^4', false],
    [['npm:kleur@^4'], 'npm:kleur@^4/colors', true],
    [['jsr:@std/path'], 'jsr:@std/path@1.1.6/join', true],
    [['react'], 'react', true],
    [['react'], 'react/jsx-runtime', true],
    [['react'], 'react-dom', false],
    [['https://esm.sh'], 'https://esm.sh/preact', true],
    [['https://esm.sh/*'], 'https://esm.sh/preact?target=es2022', true],
    [['*.wasm'], 'https://x.test/a.wasm', true],
    [[/^npm:@scope\//], 'npm:@scope/pkg@1', true],
    [[/kleur/g], 'npm:kleur', true],
    [[], 'npm:kleur', false],
  ])('%j matches %j: %s', (patterns, specifier, expected) => {
    expect(matchPattern(patterns, specifier)).toBe(expected)
  })

  it('matches any of several spellings of one import', () => {
    expect(matchPattern(['kleur'], ['npm:kleur@^4', 'kleur'])).toBe(true)
    expect(matchPattern(['npm:kleur'], ['kleur', 'npm:kleur@^4'])).toBe(true)
  })

  it('does not keep RegExp state between calls', () => {
    const pattern = /npm:/g
    expect(matchPattern([pattern], 'npm:a')).toBe(true)
    expect(matchPattern([pattern], 'npm:b')).toBe(true)
  })
})

function npmModule(name: string, version: string, subpath: string): ResolvedModule {
  return {
    kind: 'npm',
    url: `file:///proj/node_modules/.deno/${name}@${version}/node_modules/${name}/index.mjs`,
    path: `/proj/node_modules/.deno/${name}@${version}/node_modules/${name}/index.mjs`,
    mediaType: 'Mjs',
    npm: {
      name,
      version,
      subpath,
      packageDir: `/proj/node_modules/.deno/${name}@${version}/node_modules/${name}`,
      packageJsonPath: `/proj/node_modules/.deno/${name}@${version}/node_modules/${name}/package.json`,
    },
  }
}

const jsrModule = (url: string): ResolvedModule => ({
  kind: 'remote',
  url,
  mediaType: 'TypeScript',
})

describe('pinSpecifier', () => {
  const lockfile = {
    pin: (specifier: string): string | null =>
      ({ 'npm:ms@2': 'npm:ms@2.1.3', 'jsr:@std/fmt@^1/colors': 'jsr:@std/fmt@1.0.8/colors' })[
        specifier
      ] ?? null,
  }

  it.each([
    [npmModule('kleur', '4.1.5', ''), 'npm:kleur@^4', 'npm:kleur@4.1.5'],
    [npmModule('kleur', '4.1.5', '/colors'), 'npm:kleur@^4/colors', 'npm:kleur@4.1.5/colors'],
    [
      npmModule('@scope/pkg', '1.0.0-rc.1', '/x'),
      'npm:@scope/pkg@^1.0.0-0/x',
      'npm:@scope/pkg@1.0.0-rc.1/x',
    ],
    [
      npmModule('react', '19.2.0', '/jsx-runtime'),
      'react/jsx-runtime',
      'npm:react@19.2.0/jsx-runtime',
    ],
    [
      jsrModule('https://jsr.io/@std/path/1.1.6/join.ts'),
      'jsr:@std/path@^1/join',
      'jsr:@std/path@1.1.6/join',
    ],
    [jsrModule('https://jsr.io/@std/path/1.1.6/mod.ts'), 'jsr:@std/path@^1', 'jsr:@std/path@1.1.6'],
    [
      jsrModule('https://jsr.example.test/@std/path/1.1.6/mod.ts'),
      'jsr:@std/path',
      'jsr:@std/path@1.1.6',
    ],
  ])('%j for %s → %s', (resolved, original, expected) => {
    expect(pinSpecifier(resolved, original)).toBe(expected)
  })

  it('falls back to deno.lock when the resolution carries no version', () => {
    const noVersion: ResolvedModule = {
      kind: 'npm',
      url: 'file:///x/index.js',
      mediaType: 'JavaScript',
    }
    expect(pinSpecifier(noVersion, 'npm:ms@2', lockfile)).toBe('npm:ms@2.1.3')
    const otherHost = jsrModule('https://mirror.test/files/colors.ts')
    expect(pinSpecifier(otherHost, 'jsr:@std/fmt@^1/colors', lockfile)).toBe(
      'jsr:@std/fmt@1.0.8/colors',
    )
    expect(pinSpecifier(otherHost, 'jsr:@std/other@^1', lockfile)).toBeNull()
  })

  it('returns null for specifiers that are not packages', () => {
    expect(
      pinSpecifier(jsrModule('https://deno.land/x/mod.ts'), 'https://deno.land/x/mod.ts'),
    ).toBeNull()
  })
})

interface PolicyOptions {
  bundle: Pattern[]
  external: Pattern[]
  pinExternals: boolean | null
}

function options(overrides: Partial<PolicyOptions> = {}): PolicyOptions {
  return { bundle: [], external: [], pinExternals: null, ...overrides }
}

const spec = parseSpecifier

describe('externals policy', () => {
  it.each<[string, Platform, boolean]>([
    ['bun:sqlite', 'browser', true],
    ['cloudflare:workers', 'node', true],
    ['node:fs', 'node', true],
    ['node:fs', 'deno', true],
    ['node:fs', 'neutral', true],
    ['node:fs', 'browser', false],
    ['npm:kleur@^4', 'deno', true],
    ['jsr:@std/path@^1', 'deno', true],
    ['npm:kleur@^4', 'node', false],
    ['npm:kleur@^4', 'browser', false],
    ['https://deno.land/x/mod.ts', 'deno', false],
  ])('%s on %s: external = %s', (specifier, platform, expected) => {
    expect(isExternal(spec(specifier), options(), platform)).toBe(expected)
  })

  it('bundles what `bundle` names and externalises what `external` names', () => {
    expect(isExternal(spec('npm:kleur@^4'), options({ bundle: ['npm:kleur'] }), 'deno')).toBe(false)
    expect(
      isExternal(spec('npm:kleur@^4'), options({ bundle: ['kleur'] }), 'deno', ['kleur']),
    ).toBe(false)
    expect(
      isExternal(spec('https://esm.sh/x'), options({ external: ['https://esm.sh/*'] }), 'browser'),
    ).toBe(true)
    expect(isExternal(spec('npm:kleur'), options({ external: ['npm:*'] }), 'browser')).toBe(true)
    expect(
      isExternal(
        spec('npm:kleur'),
        options({ external: ['npm:*'], bundle: ['npm:kleur'] }),
        'deno',
      ),
    ).toBe(false)
  })

  it('pins npm: and jsr: externals on the Deno platform', () => {
    const resolved = npmModule('kleur', '4.1.5', '/colors')
    expect(externalOutcomeFor(spec('npm:kleur@^4/colors'), resolved, options(), 'deno')).toEqual({
      type: 'external',
      id: 'npm:kleur@4.1.5/colors',
    })
    const jsr = jsrModule('https://jsr.io/@std/path/1.1.6/join.ts')
    expect(externalOutcomeFor(spec('jsr:@std/path@^1/join'), jsr, options(), 'deno')).toEqual({
      type: 'external',
      id: 'jsr:@std/path@1.1.6/join',
    })
  })

  it('keeps ranges with pinExternals: false, and when no version is known', () => {
    const resolved = npmModule('kleur', '4.1.5', '')
    expect(
      externalOutcomeFor(spec('npm:kleur@^4'), resolved, options({ pinExternals: false }), 'deno'),
    ).toEqual({ type: 'external', id: 'npm:kleur@^4' })
    expect(externalOutcomeFor(spec('npm:kleur@^4'), undefined, options(), 'deno')).toEqual({
      type: 'external',
      id: 'npm:kleur@^4',
    })
  })

  it('pins `external` matches on other platforms only with pinExternals: true', () => {
    const resolved = npmModule('kleur', '4.1.5', '')
    const external = { external: ['npm:*'] as Pattern[] }
    expect(
      externalOutcomeFor(spec('npm:kleur@^4'), resolved, options(external), 'browser')?.id,
    ).toBe('npm:kleur@^4')
    expect(
      externalOutcomeFor(
        spec('npm:kleur@^4'),
        resolved,
        options({ ...external, pinExternals: true }),
        'browser',
      )?.id,
    ).toBe('npm:kleur@4.1.5')
  })

  it('keeps builtins as written and bundles the rest', () => {
    expect(externalOutcomeFor(spec('node:fs/promises'), undefined, options(), 'node')).toEqual({
      type: 'external',
      id: 'node:fs/promises',
    })
    expect(externalOutcomeFor(spec('bun:sqlite'), undefined, options(), 'browser')?.id).toBe(
      'bun:sqlite',
    )
    expect(externalOutcomeFor(spec('node:fs'), undefined, options(), 'browser')).toBeNull()
    expect(externalOutcomeFor(spec('npm:kleur'), undefined, options(), 'node')).toBeNull()
  })
})
