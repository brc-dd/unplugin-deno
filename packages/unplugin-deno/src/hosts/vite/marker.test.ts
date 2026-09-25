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
    const css = viteMarkerId('/app/src/style.css', 'css', 'posix')
    expect(css).toBe('\0deno:css:/app/src/style.css.js')
    expect(VITE_CSS.test(css)).toBe(false)
    expect(VITE_CSS.test('/app/src/style.css?deno-type=css')).toBe(true)
    const json = viteMarkerId('/app/data.json', 'text', 'posix')
    expect(VITE_JSON.test(json)).toBe(false)
    expect(VITE_MARKER_ID_FILTER.test(json)).toBe(true)
  })

  it('drops the query of the target and uses / on Windows', () => {
    expect(viteMarkerId('/a/b.txt?raw', 'text', 'posix')).toBe('\0deno:text:/a/b.txt.js')
    expect(viteMarkerId('C:\\app\\data.bin', 'bytes', 'win32')).toBe(
      '\0deno:bytes:C:/app/data.bin.js',
    )
  })

  it('converts core marker ids', () => {
    expect(viteMarkerIdFor('/a/b.txt?raw&deno-type=text', 'posix')).toBe('\0deno:text:/a/b.txt.js')
    expect(viteMarkerIdFor('/a/b.txt', 'posix')).toBeNull()
    expect(viteMarkerIdFor('/a/b.txt?deno-type=json', 'posix')).toBeNull()
  })
})

describe('parseViteMarkerId', () => {
  it('reads the type and the file back, ignoring queries Vite adds', () => {
    expect(parseViteMarkerId('\0deno:css:/app/src/style.css.js')).toEqual({
      type: 'css',
      path: '/app/src/style.css',
    })
    expect(parseViteMarkerId('\0deno:bytes:C:/app/x.js.js?t=123')).toEqual({
      type: 'bytes',
      path: 'C:/app/x.js',
    })
    expect(coreMarkerId({ type: 'text', path: '/a/b.txt' })).toBe('/a/b.txt?deno-type=text')
  })

  it('returns null for other ids', () => {
    for (const id of ['\0deno:empty', '\0deno:json:/a.json.js', '/a.js', '\0deno:text:/a.txt']) {
      expect(parseViteMarkerId(id)).toBeNull()
    }
  })
})
