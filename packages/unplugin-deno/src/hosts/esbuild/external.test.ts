import { describe, expect, it } from 'vitest'
import { externalMatcher } from './external.js'

describe('externalMatcher', () => {
  it('matches nothing without patterns', () => {
    expect(externalMatcher(undefined)('jsr:@std/path', 'import-statement')).toBe(false)
    expect(externalMatcher([])('react', 'import-statement')).toBe(false)
  })

  it('matches wildcard patterns by prefix and suffix', () => {
    const isExternal = externalMatcher(['jsr:*', 'https://esm.sh/*?bundle', 'ab*ba'])
    expect(isExternal('jsr:@std/path@^1/join', 'import-statement')).toBe(true)
    expect(isExternal('npm:kleur', 'import-statement')).toBe(false)
    expect(isExternal('https://esm.sh/react?bundle', 'dynamic-import')).toBe(true)
    expect(isExternal('https://esm.sh/react', 'import-statement')).toBe(false)
    // Prefix and suffix may not overlap.
    expect(isExternal('aba', 'import-statement')).toBe(false)
    expect(isExternal('abba', 'import-statement')).toBe(true)
  })

  it('matches package paths and their subpaths, like esbuild', () => {
    const isExternal = externalMatcher(['kleur', 'jsr:@std', '@scope/pkg', 'https://example.com'])
    expect(isExternal('kleur', 'import-statement')).toBe(true)
    expect(isExternal('kleur/colors', 'require-call')).toBe(true)
    expect(isExternal('kleurx', 'import-statement')).toBe(false)
    expect(isExternal('jsr:@std/path', 'import-statement')).toBe(true)
    expect(isExternal('jsr:@stdx/path', 'import-statement')).toBe(false)
    expect(isExternal('@scope/pkg/sub/file.js', 'import-statement')).toBe(true)
    expect(isExternal('@scope/other', 'import-statement')).toBe(false)
    expect(isExternal('https://example.com/x.js', 'import-statement')).toBe(true)
  })

  it('leaves patterns for resolved paths and entry points to esbuild', () => {
    const isExternal = externalMatcher(['./local.js', '/abs/file.js', 'kleur'])
    // esbuild matches these against resolved absolute paths; the plugin never resolves them.
    expect(isExternal('./local.js', 'import-statement')).toBe(false)
    expect(isExternal('/abs/file.js', 'import-statement')).toBe(false)
    // Entry points are never external.
    expect(isExternal('kleur', 'entry-point')).toBe(false)
    expect(externalMatcher(['*'])('./anything.js', 'import-statement')).toBe(true)
  })
})
