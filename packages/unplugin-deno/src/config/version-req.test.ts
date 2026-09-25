import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  formatVersion,
  normalizeVersionReq,
  parseSpecifierVersionReq,
  parseVersion,
  satisfies,
} from './version-req.js'
import type { SemVer } from './version-req.js'

function version(text: string): SemVer {
  const parsed = parseVersion(text)
  if (parsed === null) throw new Error(`invalid version ${text}`)
  return parsed
}

describe('parseVersion', () => {
  it.each([
    ['1.2.3', { major: 1, minor: 2, patch: 3, pre: [], build: [] }],
    ['v1.2.3', { major: 1, minor: 2, patch: 3, pre: [], build: [] }],
    ['=1.2.3', { major: 1, minor: 2, patch: 3, pre: [], build: [] }],
    [' 1.2.3 ', { major: 1, minor: 2, patch: 3, pre: [], build: [] }],
    [
      '1.0.0-rc.1+build.5',
      { major: 1, minor: 0, patch: 0, pre: ['rc', '1'], build: ['build', '5'] },
    ],
  ])('%j', (text, expected) => {
    expect(parseVersion(text)).toEqual(expected)
    expect(formatVersion(version(text))).toBe(text.trim().replace(/^[=v]/, ''))
  })

  it.each(['1', '1.2', '01.2.3', '1.2.3.4', 'x.y.z', '', '1.2.3-', '99999999999999999999.0.0'])(
    'rejects %j',
    (text) => {
      expect(parseVersion(text)).toBeNull()
    },
  )
})

describe('compareVersions', () => {
  // The deno_semver test vectors (`src/lib.rs`, `version_cmp`).
  it.each([
    ['1.0.0', '1.0.0-pre', 1],
    ['0.0.0', '0.0.0-pre', 1],
    ['0.0.0-a', '0.0.0-b', -1],
    ['0.0.0-a', '0.0.0-a', 0],
    ['2.0.0-rc.3.0.5', '2.0.0-rc.3.0.6', -1],
    ['2.0.0-rc.3.0.5', '2.0.0-rc.3.1.0', -1],
    ['2.0.0-rc.3.1.0', '2.0.0-rc.3.0.5', 1],
    ['2.0.0-rc.3.0.5', '2.0.0', -1],
    ['2.0.0-rc.3.0.5', '2.1.0', -1],
    ['1.0.0-2', '1.0.0-alpha', -1],
    ['1.0.0-alpha', '1.0.0-alpha.1', -1],
    ['1.0.0+a', '1.0.0+b', 0],
    ['1.10.0', '1.9.0', 1],
  ])('%s vs %s = %i', (a, b, expected) => {
    expect(compareVersions(version(a), version(b))).toBe(expected)
  })
})

describe('parseSpecifierVersionReq + normalizeVersionReq', () => {
  // The normalised form is what Deno writes as deno.lock `specifiers` keys (deno_semver's
  // `VersionRange` display); `^1` → `1` and `^1.0.14` → `^1.0.14` appear in real lockfiles.
  it.each([
    ['1', '1'],
    ['^1', '1'],
    ['~1', '1'],
    ['1.x', '1'],
    ['1.X', '1'],
    ['1.*', '1'],
    ['^1.0.0', '1'],
    ['^1.0', '1'],
    ['1.2', '1.2'],
    ['~1.2', '1.2'],
    ['~1.2.0', '1.2'],
    ['1.2.x', '1.2'],
    ['^1.2', '^1.2.0'],
    ['^1.2.3', '^1.2.3'],
    ['^1.0.14', '^1.0.14'],
    ['~1.2.3', '~1.2.3'],
    ['1.2.3', '1.2.3'],
    ['1.2.3-rc.1', '1.2.3-rc.1'],
    ['^1.2.3-beta', '^1.2.3-beta'],
    ['^0', '0'],
    ['^0.0', '0.0'],
    ['^0.1', '0.1'],
    ['^0.1.2', '~0.1.2'],
    ['^0.0.3', '^0.0.3'],
    ['~0.0.3', '~0.0.3'],
    ['1.x.3', '>=1.0.3 <2.0.3'],
    ['*', '*'],
    ['x', '*'],
    ['^*', '*'],
    ['latest', 'latest'],
    ['next', 'next'],
    ['~latest', '~latest'],
  ])('%j -> %j', (text, expected) => {
    const req = parseSpecifierVersionReq(text)
    expect(req).not.toBeNull()
    expect(req && normalizeVersionReq(req)).toBe(expected)
  })

  it.each(['', ' ', '>=1', '1 || 2', '^1 || ^2', '01', '1.2.3.4', '^latest', '1.2.3-', 'a b'])(
    'rejects %j',
    (text) => {
      expect(parseSpecifierVersionReq(text)).toBeNull()
    },
  )
})

describe('satisfies', () => {
  it.each([
    ['^1', '1.0.0', true],
    ['^1', '1.9.9', true],
    ['^1', '2.0.0', false],
    ['^1', '0.9.9', false],
    ['1', '1.2.3', true],
    ['1.2.3', '1.2.3', true],
    ['1.2.3', '1.2.4', false],
    ['~1.2.3', '1.2.9', true],
    ['~1.2.3', '1.3.0', false],
    ['^0.1.2', '0.1.9', true],
    ['^0.1.2', '0.2.0', false],
    ['^0.0.3', '0.0.3', true],
    ['^0.0.3', '0.0.4', false],
    ['*', '5.0.0', true],
    // Prerelease versions only match ranges with a prerelease on the same major.minor.patch.
    ['*', '1.0.0-rc.1', false],
    ['^1', '1.1.0-rc.1', false],
    ['^1.1.0-rc.0', '1.1.0-rc.1', true],
    ['^1.1.0-rc.0', '1.2.0-rc.1', false],
    ['latest', '1.0.0', false],
  ])('%s matches %s: %s', (req, v, expected) => {
    const parsed = parseSpecifierVersionReq(req)
    expect(parsed).not.toBeNull()
    expect(parsed !== null && satisfies(version(v), parsed)).toBe(expected)
  })
})
