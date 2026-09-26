import { describe, expect, it } from 'vitest'
import {
  coreMarkerId,
  parseViteMarkerId,
  VITE_MARKER_ID_FILTER,
  viteMarkerId,
  viteMarkerIdFor,
} from './marker.js'

/** Vite's `CSS_LANGS_RE` and the id part of its JSON plugin filter (Vite 7 and 8). */
const VITE_CSS = /\.(css|less|sass|scss|styl|stylus|pcss|postcss|sss)(?:$|\?)/
const VITE_JSON = /\.json(?:$|\?)(?!commonjs-(?:proxy|external))/

describe('viteMarkerId', () => {
  it('hides the target extension from the plugins that claim ids by extension', () => {
    const css = viteMarkerId('/app/src/style.css', 'css', '/app', 'posix')
    expect(css).toBe('\0deno:css:src/style.css.js')
    expect(VITE_CSS.test(css)).toBe(false)
    expect(VITE_CSS.test('/app/src/style.css?deno-type=css')).toBe(true)
    const json = viteMarkerId('/app/data.json', 'text', '/app', 'posix')
    expect(VITE_JSON.test(json)).toBe(false)
    expect(VITE_MARKER_ID_FILTER.test(json)).toBe(true)
  })

  it('is relative to the root, so no machine path reaches the output', () => {
    expect(viteMarkerId('/a/b.txt?raw', 'text', '/a', 'posix')).toBe('\0deno:text:b.txt.js')
    expect(
      viteMarkerId('/p/node_modules/.unplugin-deno/0123abcd/https/x.test/l', 'text', '/p', 'posix'),
    ).toBe('\0deno:text:node_modules/.unplugin-deno/0123abcd/https/x.test/l.js')
    expect(viteMarkerId('C:\\app\\src\\data.bin', 'bytes', 'C:\\app', 'win32')).toBe(
      '\0deno:bytes:src/data.bin.js',
    )
  })

  it('writes `..` segments as ~u, which dev-server URLs keep', () => {
    expect(viteMarkerId('/ws/lib/data.txt', 'text', '/ws/app', 'posix')).toBe(
      '\0deno:text:~u/lib/data.txt.js',
    )
    expect(viteMarkerId('/x/y.txt', 'text', '/ws/app', 'posix')).toBe(
      '\0deno:text:~u/~u/x/y.txt.js',
    )
    expect(viteMarkerId('C:\\ws\\lib\\d.txt', 'text', 'C:\\ws\\app', 'win32')).toBe(
      '\0deno:text:~u/lib/d.txt.js',
    )
    const url = `/@id/${viteMarkerId('/x/y.txt', 'text', '/ws/app', 'posix').replace('\0', '__x00__')}`
    expect(new URL(url, 'http://localhost').pathname).toBe(url)
  })

  it('keeps an absolute path for another drive and names starting with ~', () => {
    expect(viteMarkerId('D:\\data\\x.txt', 'text', 'C:\\app', 'win32')).toBe(
      '\0deno:text:~abs/D:/data/x.txt.js',
    )
    expect(viteMarkerId('/app/~u/x.txt', 'text', '/app', 'posix')).toBe(
      '\0deno:text:~abs//app/~u/x.txt.js',
    )
  })

  it('converts core marker ids', () => {
    expect(viteMarkerIdFor('/a/b.txt?raw&deno-type=text', '/a', 'posix')).toBe(
      '\0deno:text:b.txt.js',
    )
    expect(viteMarkerIdFor('/a/b.txt', '/a', 'posix')).toBeNull()
    expect(viteMarkerIdFor('/a/b.txt?deno-type=json', '/a', 'posix')).toBeNull()
  })
})

describe('parseViteMarkerId', () => {
  it('reads the type and the absolute file back, ignoring queries Vite adds', () => {
    expect(parseViteMarkerId('\0deno:css:src/style.css.js', '/app', 'posix')).toEqual({
      type: 'css',
      path: '/app/src/style.css',
    })
    expect(parseViteMarkerId('\0deno:bytes:x.js.js?t=123', 'C:\\app', 'win32')).toEqual({
      type: 'bytes',
      path: 'C:\\app\\x.js',
    })
    expect(coreMarkerId({ type: 'text', path: '/a/b.txt' })).toBe('/a/b.txt?deno-type=text')
  })

  it.each([
    ['/ws/lib/data.txt', '/ws/app', 'posix'],
    ['/x/y.txt', '/ws/app', 'posix'],
    ['/app/~u/x.txt', '/app', 'posix'],
    ['/app/src/a b/c.txt', '/app', 'posix'],
    ['C:\\ws\\lib\\d.txt', 'C:\\ws\\app', 'win32'],
    ['D:\\data\\x.txt', 'C:\\app', 'win32'],
  ] as const)('round-trips %s from root %s', (file, root, flavor) => {
    const id = viteMarkerId(file, 'text', root, flavor)
    expect(parseViteMarkerId(id, root, flavor)).toEqual({ type: 'text', path: file })
  })

  it('returns null for other ids', () => {
    for (const id of ['\0deno:empty', '\0deno:json:a.json.js', '/a.js', '\0deno:text:a.txt']) {
      expect(parseViteMarkerId(id, '/app', 'posix')).toBeNull()
    }
  })
})
