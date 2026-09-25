import { describe, expect, it } from 'vitest'
import type { PackageSpecifier } from './package-specifier.js'
import {
  isBareSpecifier,
  isPackageRequirement,
  parsePackageSpecifier,
} from './package-specifier.js'

describe('parsePackageSpecifier', () => {
  it.each<[string, PackageSpecifier | undefined]>([
    ['jsr:@std/path', { scheme: 'jsr', name: '@std/path', version: undefined, subpath: '' }],
    ['jsr:@std/path@^1', { scheme: 'jsr', name: '@std/path', version: '^1', subpath: '' }],
    [
      'jsr:@std/path@^1/posix',
      { scheme: 'jsr', name: '@std/path', version: '^1', subpath: '/posix' },
    ],
    [
      'jsr:/@std/path@^1/posix',
      { scheme: 'jsr', name: '@std/path', version: '^1', subpath: '/posix' },
    ],
    [
      'JSR:@std/path@1.1.6/posix/join',
      { scheme: 'jsr', name: '@std/path', version: '1.1.6', subpath: '/posix/join' },
    ],
    ['npm:kleur', { scheme: 'npm', name: 'kleur', version: undefined, subpath: '' }],
    ['npm:kleur@^4/colors', { scheme: 'npm', name: 'kleur', version: '^4', subpath: '/colors' }],
    ['npm:/kleur@4.1.5', { scheme: 'npm', name: 'kleur', version: '4.1.5', subpath: '' }],
    [
      'npm:@types/node@^22/fs',
      { scheme: 'npm', name: '@types/node', version: '^22', subpath: '/fs' },
    ],
    ['npm:kleur/colors', { scheme: 'npm', name: 'kleur', version: undefined, subpath: '/colors' }],
    [
      'npm:preact@10.26.0/jsx-runtime',
      { scheme: 'npm', name: 'preact', version: '10.26.0', subpath: '/jsx-runtime' },
    ],
    ['kleur', { scheme: 'bare', name: 'kleur', version: undefined, subpath: '' }],
    ['kleur/colors', { scheme: 'bare', name: 'kleur', version: undefined, subpath: '/colors' }],
    ['@std/path/join', { scheme: 'bare', name: '@std/path', version: undefined, subpath: '/join' }],
    ['kleur@4', { scheme: 'bare', name: 'kleur@4', version: undefined, subpath: '' }],
    ['jsr:', undefined],
    ['jsr:@std', undefined],
    ['npm:@scope/', undefined],
    ['npm:kleur@', undefined],
    ['@scope', undefined],
    ['./kleur', undefined],
    ['../kleur', undefined],
    ['/abs/kleur', undefined],
    ['C:\\x\\kleur', undefined],
    ['https://esm.sh/kleur', undefined],
    ['node:fs', undefined],
    ['#internal', undefined],
    ['', undefined],
  ])('%s', (specifier, expected) => {
    expect(parsePackageSpecifier(specifier)).toEqual(expected)
  })
})

describe('isBareSpecifier', () => {
  it.each<[string, boolean]>([
    ['kleur', true],
    ['@std/path', true],
    ['fs', true],
    ['.', false],
    ['..', false],
    ['./x', false],
    ['../x', false],
    ['.\\x', false],
    ['/x', false],
    ['\\x', false],
    ['C:/x', false],
    ['c:\\x', false],
    ['node:fs', false],
    ['data:text/javascript,1', false],
    ['#internal', false],
    ['', false],
  ])('%s -> %s', (specifier, expected) => {
    expect(isBareSpecifier(specifier)).toBe(expected)
  })
})

describe('isPackageRequirement', () => {
  it('matches jsr: and npm: specifiers only', () => {
    expect(isPackageRequirement('jsr:@std/path@^1')).toBe(true)
    expect(isPackageRequirement('jsr:/@std/path@^1/posix')).toBe(true)
    expect(isPackageRequirement('NPM:kleur')).toBe(true)
    expect(isPackageRequirement('https://jsr.io/@std/path/1.1.6/mod.ts')).toBe(false)
    expect(isPackageRequirement('kleur')).toBe(false)
  })
})
