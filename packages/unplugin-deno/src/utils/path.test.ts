import { fileURLToPath, pathToFileURL } from 'node:url'
import posixPath from 'node:path/posix'
import win32Path from 'node:path/win32'
import { describe, expect, it } from 'vitest'
import {
  HOST_PATH_FLAVOR,
  isSubpath,
  normalizeDriveLetter,
  relativeUrlPath,
  toDirUrl,
  toFileUrl,
  toPath,
} from './path.js'

describe('normalizeDriveLetter', () => {
  it.each([
    ['c:\\Users\\x', 'C:\\Users\\x'],
    ['c:/Users/x', 'C:/Users/x'],
    ['/c:/Users/x', '/C:/Users/x'],
    ['file:///c:/Users/x', 'file:///C:/Users/x'],
    ['\\\\?\\c:\\x', '\\\\?\\C:\\x'],
    ['c:', 'C:'],
    ['C:\\already', 'C:\\already'],
    ['/usr/lib', '/usr/lib'],
    ['cd:/x', 'cd:/x'],
    ['file:///home/c:/x', 'file:///home/c:/x'],
    ['relative/c:/x', 'relative/c:/x'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeDriveLetter(input)).toBe(expected)
    expect(normalizeDriveLetter(expected)).toBe(expected)
  })
})

describe('toPath', () => {
  it.each([
    ['file:///home/user/a%20b.ts', '/home/user/a b.ts'],
    ['file:///home/user/%E2%9C%93.ts', '/home/user/✓.ts'],
    ['file://localhost/etc/hosts', '/etc/hosts'],
    ['file:///tmp/a%25b', '/tmp/a%b'],
    ['file:///tmp/back%5Cslash', '/tmp/back\\slash'],
  ])('posix: %s -> %s', (url, expected) => {
    expect(toPath(url, 'posix')).toBe(expected)
  })

  it.each([
    ['file:///C:/Users/x/a%20b.ts', 'C:\\Users\\x\\a b.ts'],
    ['file:///c:/Users/x', 'C:\\Users\\x'],
    ['file:///C:/', 'C:\\'],
    ['file://server/share/dir/file.ts', '\\\\server\\share\\dir\\file.ts'],
    ['file:///D:/%E2%9C%93/%23hash.ts', 'D:\\✓\\#hash.ts'],
  ])('win32: %s -> %s', (url, expected) => {
    expect(toPath(url, 'win32')).toBe(expected)
  })

  it('accepts URL objects', () => {
    expect(toPath(new URL('file:///srv/app.ts'), 'posix')).toBe('/srv/app.ts')
  })

  it('rejects invalid input', () => {
    expect(() => toPath('https://jsr.io/x.ts', 'posix')).toThrow(TypeError)
    expect(() => toPath('file://server/share/x', 'posix')).toThrow(/host/)
    expect(() => toPath('file:///a%2Fb', 'posix')).toThrow(/encoded/)
    expect(() => toPath('file:///C:/a%5Cb', 'win32')).toThrow(/encoded/)
    expect(() => toPath('file:///no-drive/x', 'win32')).toThrow(/absolute/)
  })

  it('matches url.fileURLToPath on this OS', () => {
    const url = pathToFileURL(fileURLToPath(import.meta.url)).href
    expect(toPath(url)).toBe(normalizeDriveLetter(fileURLToPath(url)))
  })
})

describe('toFileUrl', () => {
  it.each([
    ['/home/user/a b.ts', 'file:///home/user/a%20b.ts'],
    ['/tmp/a%b#c?d', 'file:///tmp/a%25b%23c%3Fd'],
    ['/tmp/back\\slash', 'file:///tmp/back%5Cslash'],
    ['/tmp/line\nbreak\ttab', 'file:///tmp/line%0Abreak%09tab'],
    ['/tmp/✓.ts', 'file:///tmp/%E2%9C%93.ts'],
    ['/a/./b/../c', 'file:///a/c'],
    ['/dir/', 'file:///dir/'],
  ])('posix: %j -> %s', (path, expected) => {
    expect(toFileUrl(path, 'posix')).toBe(expected)
  })

  it.each([
    ['C:\\Users\\x\\a b.ts', 'file:///C:/Users/x/a%20b.ts'],
    ['c:\\Users\\x', 'file:///C:/Users/x'],
    ['C:/mixed/separators', 'file:///C:/mixed/separators'],
    ['C:\\a\\..\\b\\.\\c.ts', 'file:///C:/b/c.ts'],
    ['C:\\', 'file:///C:/'],
    ['D:\\100%\\#1.ts', 'file:///D:/100%25/%231.ts'],
    ['\\\\server\\share\\dir\\file.ts', 'file://server/share/dir/file.ts'],
    ['\\\\?\\C:\\very\\long\\path', 'file:///C:/very/long/path'],
    ['\\\\?\\UNC\\server\\share\\x', 'file://server/share/x'],
  ])('win32: %j -> %s', (path, expected) => {
    expect(toFileUrl(path, 'win32')).toBe(expected)
  })

  it('rejects relative paths', () => {
    expect(() => toFileUrl('relative/x', 'posix')).toThrow(TypeError)
    expect(() => toFileUrl('C:relative', 'win32')).toThrow(TypeError)
    expect(() => toFileUrl('\\rootless', 'win32')).toThrow(TypeError)
  })

  it.each([
    ['posix', '/srv/app/x y/%/#.ts'],
    ['win32', 'C:\\srv\\app\\x y\\%\\#.ts'],
    ['win32', '\\\\host\\share\\x y.ts'],
  ] as const)('round-trips %s path %j', (flavor, path) => {
    expect(toPath(toFileUrl(path, flavor), flavor)).toBe(path)
  })

  it('matches url.pathToFileURL on this OS', () => {
    const path = fileURLToPath(import.meta.url)
    expect(toFileUrl(path)).toBe(normalizeDriveLetter(pathToFileURL(path).href))
    expect(HOST_PATH_FLAVOR).toBe(process.platform === 'win32' ? 'win32' : 'posix')
  })
})

describe('isSubpath', () => {
  it.each([
    ['/a/b', '/a/b', true],
    ['/a/b', '/a/b/c.ts', true],
    ['/a/b/', '/a/b/c/d', true],
    ['/a/b', '/a/bc', false],
    ['/a/b', '/a', false],
    ['/a/b', '/a/b/../c', false],
    ['/a/b', '/a/b/..foo', true],
  ])('posix: %s contains %s -> %s', (parent, child, expected) => {
    expect(isSubpath(parent, child, 'posix')).toBe(expected)
  })

  it.each([
    ['C:\\a\\b', 'C:\\a\\b\\c.ts', true],
    ['C:\\a\\b', 'c:\\A\\B\\c.ts', true],
    ['C:\\a\\b', 'C:/a/b/c.ts', true],
    ['C:\\a\\b', 'C:\\a\\bc', false],
    ['C:\\a\\b', 'D:\\a\\b\\c.ts', false],
    ['\\\\server\\share', '\\\\server\\share\\x', true],
    ['\\\\server\\share', '\\\\other\\share\\x', false],
  ])('win32: %s contains %s -> %s', (parent, child, expected) => {
    expect(isSubpath(parent, child, 'win32')).toBe(expected)
  })

  it('uses the same semantics as the platform path module', () => {
    expect(posixPath.relative('/a', '/a/b')).toBe('b')
    expect(win32Path.relative('C:\\a', 'c:\\A\\b')).toBe('b')
  })
})

describe('relativeUrlPath', () => {
  it.each([
    [
      'file:///m/jsr.io/@std/path/1.1.6/mod.ts.js',
      'file:///m/jsr.io/@std/path/1.1.6/join.ts.js',
      './join.ts.js',
    ],
    [
      'file:///m/jsr.io/@std/path/1.1.6/mod.ts.js',
      'file:///m/jsr.io/@std/fmt/1.0.0/colors.ts.js',
      '../../fmt/1.0.0/colors.ts.js',
    ],
    ['file:///m/a/b/c.js', 'file:///m/a/b/c.js', './c.js'],
    ['file:///m/a/b/c.js', 'file:///m/a/b', '../b'],
    ['file:///m/a/b/c.js', 'file:///m/x%20y/%25z.js', '../../x%20y/%25z.js'],
    ['file:///m/a/c.js', 'file:///m/a/d.js?deno-type=text', './d.js?deno-type=text'],
    ['file:///C:/m/a/c.js', 'file:///c:/m/b/d.js', '../b/d.js'],
    ['file:///C:/m/a/c.js', 'file:///D:/m/b/d.js', 'file:///D:/m/b/d.js'],
    ['https://jsr.io/@std/path/1.1.6/mod.ts', 'https://jsr.io/@std/path/1.1.6/_os.ts', './_os.ts'],
    ['https://jsr.io/a/b.ts', 'https://deno.land/a/b.ts', 'https://deno.land/a/b.ts'],
    ['https://jsr.io/a/b.ts', 'file:///a/b.ts', 'file:///a/b.ts'],
  ])('%s -> %s = %s', (from, to, expected) => {
    const result = relativeUrlPath(from, to)
    expect(result).toBe(expected)
    expect(new URL(result, from).href.toLowerCase()).toBe(new URL(to).href.toLowerCase())
  })

  it('never produces a reference that parses as a scheme', () => {
    expect(relativeUrlPath('file:///m/a.js', 'file:///m/c:x.js')).toBe('./c:x.js')
  })
})

describe('toDirUrl', () => {
  it.each([
    ['posix', '/home/user/proj', 'file:///home/user/proj/'],
    ['posix', '/home/user/proj/', 'file:///home/user/proj/'],
    ['posix', '/', 'file:///'],
    ['win32', 'C:\\proj\\app', 'file:///C:/proj/app/'],
    ['win32', 'c:\\proj\\app\\', 'file:///C:/proj/app/'],
    ['win32', '\\\\server\\share\\dir', 'file://server/share/dir/'],
  ] as const)('%s: %j -> %s', (flavor, path, expected) => {
    expect(toDirUrl(path, flavor)).toBe(expected)
  })

  it('rejects relative paths', () => {
    expect(() => toDirUrl('relative', 'posix')).toThrow(TypeError)
  })
})
