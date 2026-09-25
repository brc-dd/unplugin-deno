import { describe, expect, it } from 'vitest'
import {
  DENO_TYPE_PARAM,
  EMPTY_MODULE_ID,
  isMirrorPath,
  isVirtualId,
  readDenoType,
  splitQuery,
  stripDenoType,
  withDenoType,
} from './id.js'

describe('splitQuery', () => {
  it.each([
    ['/src/logo.svg?raw', '/src/logo.svg', '?raw'],
    ['/src/worker.ts?worker&url', '/src/worker.ts', '?worker&url'],
    ['/src/a.ts?v=1a2b3c', '/src/a.ts', '?v=1a2b3c'],
    ['/src/a.ts?import#hash', '/src/a.ts', '?import#hash'],
    ['/src/a.ts?a=1?b=2', '/src/a.ts', '?a=1?b=2'],
    ['/src/a.ts?', '/src/a.ts', '?'],
    ['/src/a.ts#hash', '/src/a.ts#hash', ''],
    ['/src/a.ts', '/src/a.ts', ''],
    ['C:\\proj\\src\\a.ts?raw', 'C:\\proj\\src\\a.ts', '?raw'],
    ['C:/proj/src/a.ts?raw', 'C:/proj/src/a.ts', '?raw'],
    ['\\\\?\\C:\\very\\long\\a.ts?raw', '\\\\?\\C:\\very\\long\\a.ts', '?raw'],
    ['\\\\?\\C:\\very\\long\\a.ts', '\\\\?\\C:\\very\\long\\a.ts', ''],
    ['//?/C:/very/long/a.ts?url', '//?/C:/very/long/a.ts', '?url'],
    ['\\\\server\\share\\a.ts?raw', '\\\\server\\share\\a.ts', '?raw'],
    ['file:///C:/x/a.ts?raw', 'file:///C:/x/a.ts', '?raw'],
    ['https://esm.sh/preact?target=es2022', 'https://esm.sh/preact', '?target=es2022'],
    ['\0virtual:x?y', '\0virtual:x', '?y'],
    ['data:text/javascript,console.log("?")', 'data:text/javascript,console.log("?")', ''],
    ['data:text/plain;base64,SGk/?raw', 'data:text/plain;base64,SGk/?raw', ''],
    ['DATA:text/plain,a?b', 'DATA:text/plain,a?b', ''],
    ['data:text/plain,a?b?deno-type=text', 'data:text/plain,a?b', '?deno-type=text'],
    [
      'data:application/octet-stream,xy?deno-type=bytes',
      'data:application/octet-stream,xy',
      '?deno-type=bytes',
    ],
    ['data:text/plain,a?deno-type=json', 'data:text/plain,a?deno-type=json', ''],
  ])('%j -> %j + %j', (id, base, query) => {
    expect(splitQuery(id)).toEqual({ base, query })
  })
})

describe('withDenoType', () => {
  it.each([
    ['/src/data.txt', 'text', '/src/data.txt?deno-type=text'],
    ['/src/data.bin', 'bytes', '/src/data.bin?deno-type=bytes'],
    ['/src/style.css', 'css', '/src/style.css?deno-type=css'],
    ['/src/data.txt?raw', 'text', '/src/data.txt?raw&deno-type=text'],
    ['/src/data.txt?', 'text', '/src/data.txt?deno-type=text'],
    ['/src/data.txt#frag', 'text', '/src/data.txt#frag?deno-type=text'],
    ['/src/data.txt?v=1#frag', 'text', '/src/data.txt?v=1&deno-type=text#frag'],
    ['/src/data.txt?deno-type=bytes', 'text', '/src/data.txt?deno-type=text'],
    ['/src/data.txt?a&deno-type=bytes&b', 'css', '/src/data.txt?a&b&deno-type=css'],
    ['C:\\proj\\data.txt', 'text', 'C:\\proj\\data.txt?deno-type=text'],
    ['data:text/plain,a?b', 'text', 'data:text/plain,a?b?deno-type=text'],
  ] as const)('%j + %s -> %j', (id, type, expected) => {
    expect(withDenoType(id, type)).toBe(expected)
    expect(readDenoType(expected)?.type).toBe(type)
  })
})

describe('readDenoType', () => {
  it.each([
    ['/src/data.txt?deno-type=text', { base: '/src/data.txt', type: 'text' }],
    ['/src/data.txt?raw&deno-type=bytes', { base: '/src/data.txt?raw', type: 'bytes' }],
    ['/src/data.txt?deno-type=css&raw', { base: '/src/data.txt?raw', type: 'css' }],
    ['/src/data.txt?a=1&deno-type=text&b=2#h', { base: '/src/data.txt?a=1&b=2#h', type: 'text' }],
    ['data:text/plain,a?b?deno-type=text', { base: 'data:text/plain,a?b', type: 'text' }],
    ['\\\\?\\C:\\x\\d.txt?deno-type=text', { base: '\\\\?\\C:\\x\\d.txt', type: 'text' }],
  ])('%j', (id, expected) => {
    expect(readDenoType(id)).toEqual(expected)
  })

  it.each([
    '/src/data.txt',
    '/src/data.txt?raw',
    '/src/data.txt?deno-type=json',
    '/src/data.txt?deno-type=',
    '/src/data.txt?deno-type',
    '/src/data.txt?not-deno-type=text',
    'data:text/plain,deno-type=text',
  ])('returns null for %j', (id) => {
    expect(readDenoType(id)).toBeNull()
  })
})

describe('stripDenoType', () => {
  it.each([
    ['/src/data.txt?deno-type=text', '/src/data.txt'],
    ['/src/data.txt?raw&deno-type=text', '/src/data.txt?raw'],
    ['/src/data.txt?deno-type=unknown', '/src/data.txt'],
    ['/src/data.txt?deno-type=text&deno-type=bytes', '/src/data.txt'],
    ['/src/data.txt?raw', '/src/data.txt?raw'],
    ['/src/data.txt', '/src/data.txt'],
    ['data:text/plain,x?deno-type=bytes', 'data:text/plain,x'],
  ])('%j -> %j', (id, expected) => {
    expect(stripDenoType(id)).toBe(expected)
  })

  it('uses the documented parameter name', () => {
    expect(DENO_TYPE_PARAM).toBe('deno-type')
  })
})

describe('isVirtualId', () => {
  it('detects the \\0 prefix only', () => {
    expect(isVirtualId('\0virtual:x')).toBe(true)
    expect(isVirtualId(EMPTY_MODULE_ID)).toBe(true)
    expect(isVirtualId('virtual:x')).toBe(false)
    expect(isVirtualId('/src/\0x')).toBe(false)
    expect(EMPTY_MODULE_ID).toBe('\0deno:empty')
  })
})

describe('isMirrorPath', () => {
  const posixCache = '/proj/node_modules/.unplugin-deno'
  const winCache = 'C:\\proj\\node_modules\\.unplugin-deno'

  it.each([
    ['/proj/node_modules/.unplugin-deno/3fa9c21b/https/jsr.io/@std/path/1.1.6/mod.ts.js', true],
    ['/proj/node_modules/.unplugin-deno/3fa9c21b/https/jsr.io/x.txt?deno-type=text', true],
    ['/proj/node_modules/.unplugin-deno', true],
    ['/proj/node_modules/.unplugin-deno-other/x.js', false],
    ['/proj/node_modules/kleur/index.mjs', false],
    ['/proj/src/main.ts', false],
    ['node_modules/.unplugin-deno/x.js', false],
    ['\0/proj/node_modules/.unplugin-deno/x.js', false],
    ['/proj/node_modules/.unplugin-deno/../../src/main.ts', false],
  ])('posix: %j -> %s', (id, expected) => {
    expect(isMirrorPath(id, posixCache, 'posix')).toBe(expected)
  })

  it.each([
    ['C:\\proj\\node_modules\\.unplugin-deno\\3fa9c21b\\https\\jsr.io\\mod.ts.js', true],
    ['C:/proj/node_modules/.unplugin-deno/3fa9c21b/https/jsr.io/mod.ts.js?raw', true],
    ['c:\\PROJ\\node_modules\\.unplugin-deno\\x.js', true],
    ['D:\\proj\\node_modules\\.unplugin-deno\\x.js', false],
    ['C:\\proj\\src\\main.ts', false],
    ['/proj/node_modules/.unplugin-deno/x.js', false],
  ])('win32: %j -> %s', (id, expected) => {
    expect(isMirrorPath(id, winCache, 'win32')).toBe(expected)
  })
})
