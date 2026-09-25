import { describe, expect, it } from 'vitest'
import {
  ensureTrailingSlash,
  hasOpaquePath,
  isSpecialScheme,
  normalizeUrl,
  percentDecodeLossy,
  urlDirname,
} from './url.js'

describe('ensureTrailingSlash', () => {
  it('adds a slash only when missing', () => {
    expect(ensureTrailingSlash('file:///a')).toBe('file:///a/')
    expect(ensureTrailingSlash('file:///a/')).toBe('file:///a/')
  })
})

describe('urlDirname', () => {
  it.each([
    ['file:///a/b.ts', 'file:///a/'],
    ['file:///a/b/', 'file:///a/b/'],
    ['file:///C:/x/y.ts?raw#h', 'file:///C:/x/'],
    ['https://jsr.io/@std/path/1.1.6/mod.ts', 'https://jsr.io/@std/path/1.1.6/'],
  ])('%s -> %s', (url, expected) => {
    expect(urlDirname(url)).toBe(expected)
    expect(urlDirname(new URL(url))).toBe(expected)
  })
})

describe('normalizeUrl', () => {
  it.each([
    ['file:///c:/proj/x.ts', 'file:///C:/proj/x.ts'],
    ['file:///C:/proj/x.ts', 'file:///C:/proj/x.ts'],
    ['file:///home/c:/x', 'file:///home/c:/x'],
    ['HTTPS://Example.COM/a/../b', 'https://example.com/b'],
    // Deno's `url` crate keeps `^` in paths; Node.js and Bun encode it (newer WHATWG rule).
    ['jsr:/@std/path@^1/join', 'jsr:/@std/path@^1/join'],
    ['https://esm.sh/x@^1/y', 'https://esm.sh/x@^1/y'],
    ['file:///a^b/c', 'file:///a^b/c'],
    ['jsr:@std/path@^1', 'jsr:@std/path@^1'],
    ['data:text/plain,%5E', 'data:text/plain,%5E'],
  ])('%s -> %s', (url, expected) => {
    expect(normalizeUrl(url)).toBe(expected)
    expect(normalizeUrl(expected)).toBe(expected)
  })

  it('returns undefined for relative or invalid input', () => {
    expect(normalizeUrl('./x.ts')).toBeUndefined()
    expect(normalizeUrl('react')).toBeUndefined()
    expect(normalizeUrl('http://[bad')).toBeUndefined()
  })
})

describe('hasOpaquePath / isSpecialScheme', () => {
  it.each([
    ['jsr:@std/fmt@^1/', true],
    ['npm:preact/', true],
    ['data:text/javascript,x/', true],
    ['mailto:x@y', true],
    ['jsr:/@std/fmt@^1/', false],
    ['npm:/preact@10/', false],
    ['https://example.com/', false],
    ['file:///a/', false],
    ['foo://host/x', false],
  ])('%s -> %s', (url, expected) => {
    expect(hasOpaquePath(new URL(url))).toBe(expected)
  })

  it('knows the WHATWG special schemes', () => {
    for (const scheme of ['ftp:', 'file:', 'http:', 'https:', 'ws:', 'wss:']) {
      expect(isSpecialScheme(scheme)).toBe(true)
    }
    for (const scheme of ['jsr:', 'npm:', 'data:', 'blob:', 'node:']) {
      expect(isSpecialScheme(scheme)).toBe(false)
    }
  })
})

describe('percentDecodeLossy', () => {
  it.each([
    ['plain', 'plain'],
    ['a%20b', 'a b'],
    ['%E3%81%8D%E3%81%A4%E3%81%AD', 'きつね'],
    ['%2E%2E/x', '../x'],
    ['%2f', '/'],
    ['100%', '100%'],
    ['%zz%4', '%zz%4'],
    ['%FF', '\u{FFFD}'],
    ['%C3', '\u{FFFD}'],
    ['ok%C3%A9', 'oké'],
    ['emoji-😀', 'emoji-😀'],
  ])('%j -> %j', (input, expected) => {
    expect(percentDecodeLossy(input)).toBe(expected)
  })
})
