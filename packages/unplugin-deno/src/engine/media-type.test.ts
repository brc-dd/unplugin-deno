import { describe, expect, it } from 'vitest'
import { loadVendoredDenoLoader } from '../vendored-deno-loader.js'
import {
  esbuildLoaderFor,
  isMediaType,
  MEDIA_TYPES,
  mediaTypeExtension,
  mediaTypeFromContentType,
  mediaTypeFromFileName,
  mediaTypeFromPath,
  mediaTypeFromUrl,
  moduleTypeFor,
} from './media-type.js'
import type { MediaType } from './types.js'

describe('MEDIA_TYPES', () => {
  it("has the names and order of the vendored loader's MediaType enum", async () => {
    const { MediaType: LoaderMediaType } = await loadVendoredDenoLoader()
    const names = MEDIA_TYPES.map((_, index) => LoaderMediaType[index])
    expect(names).toEqual([...MEDIA_TYPES])
    expect((LoaderMediaType as unknown as Record<number, unknown>)[MEDIA_TYPES.length]).toBe(
      undefined,
    )
  })

  it('recognizes media type names', () => {
    expect(isMediaType('TypeScript')).toBe(true)
    expect(isMediaType('typescript')).toBe(false)
    expect(isMediaType(4)).toBe(false)
  })
})

describe('mediaTypeFromFileName', () => {
  it.each<[string, MediaType]>([
    ['mod.ts', 'TypeScript'],
    ['MOD.TS', 'TypeScript'],
    ['types.d.ts', 'Dts'],
    ['types.d.mts', 'Dmts'],
    ['types.d.cts', 'Dcts'],
    ['styles.d.css.ts', 'Dts'],
    ['component.d.tsx', 'Tsx'],
    ['a.mts', 'Mts'],
    ['a.cts', 'Cts'],
    ['a.tsx', 'Tsx'],
    ['a.js', 'JavaScript'],
    ['a.jsx', 'Jsx'],
    ['a.mjs', 'Mjs'],
    ['a.cjs', 'Cjs'],
    ['a.css', 'Css'],
    ['a.json', 'Json'],
    ['a.jsonc', 'Jsonc'],
    ['a.json5', 'Json5'],
    ['a.wasm', 'Wasm'],
    ['README.md', 'Markdown'],
    ['notes.markdown', 'Markdown'],
    ['a.js.map', 'SourceMap'],
    ['.ts', 'TypeScript'],
    ['index.html', 'Unknown'],
    ['query.sql', 'Unknown'],
    ['Makefile', 'Unknown'],
    ['', 'Unknown'],
  ])('%s -> %s', (fileName, mediaType) => {
    expect(mediaTypeFromFileName(fileName)).toBe(mediaType)
  })
})

describe('mediaTypeFromPath', () => {
  it.each<[string, MediaType]>([
    ['/home/user/project/src/main.ts', 'TypeScript'],
    ['/cache/npm/registry.npmjs.org/kleur/4.1.5/index.mjs', 'Mjs'],
    ['C:\\Users\\x\\project\\src\\app.tsx', 'Tsx'],
    ['C:\\Users\\x\\node_modules\\pkg\\index.d.ts', 'Dts'],
    ['/dir.ts/', 'TypeScript'],
    ['/dir/', 'Unknown'],
    ['/', 'Unknown'],
  ])('%s -> %s', (path, mediaType) => {
    expect(mediaTypeFromPath(path)).toBe(mediaType)
  })
})

describe('mediaTypeFromUrl', () => {
  it.each<[string, MediaType]>([
    ['https://jsr.io/@std/path/1.1.6/mod.ts', 'TypeScript'],
    ['https://example.com/a.ts?x=b.js#c.mjs', 'TypeScript'],
    ['https://esm.sh/react@19.2.0', 'Unknown'],
    ['https://example.com/', 'Unknown'],
    ['file:///home/user/a%20b.jsx', 'Jsx'],
    ['file:///C:/project/src/types.d.ts', 'Dts'],
    ['node:fs', 'Unknown'],
    ['npm:kleur@4.1.5', 'Unknown'],
    ['bun:sqlite', 'Unknown'],
    ['data:text/javascript,export default 42', 'JavaScript'],
    ['data:text/javascript,import "./x.mjs"', 'JavaScript'],
    ['data:application/typescript;base64,ZXhwb3J0IGNvbnN0IHggPSAx', 'TypeScript'],
    ['data:application/json,{"a":1}', 'Json'],
    ['data:application/vnd.api+json,{}', 'Json'],
    ['data:text/jsx,<a/>', 'Jsx'],
    ['data:text/css,a{}', 'Css'],
    ['data:,hello', 'Unknown'],
    ['data:text/plain,hello.ts', 'Unknown'],
    ['data:;base64,AAAA', 'Unknown'],
    ['not a url', 'Unknown'],
  ])('%s -> %s', (url, mediaType) => {
    expect(mediaTypeFromUrl(url)).toBe(mediaType)
  })

  it('accepts URL objects', () => {
    expect(mediaTypeFromUrl(new URL('https://deno.land/std@0.224.0/fmt/colors.ts'))).toBe(
      'TypeScript',
    )
  })
})

describe('mediaTypeFromContentType', () => {
  it.each<[string, string | undefined, MediaType]>([
    ['application/typescript', undefined, 'TypeScript'],
    ['text/typescript; charset=utf-8', 'https://x.test/a', 'TypeScript'],
    ['video/mp2t', 'https://x.test/a.ts', 'TypeScript'],
    ['application/typescript', 'https://x.test/a.d.ts', 'Dts'],
    ['application/typescript', 'https://x.test/a.cts', 'Cts'],
    ['application/typescript', 'https://x.test/a.tsx', 'Tsx'],
    ['TEXT/JAVASCRIPT; charset=utf-8', undefined, 'JavaScript'],
    ['application/javascript', 'https://x.test/a.mjs', 'Mjs'],
    ['application/javascript', 'https://x.test/a.mts', 'Mjs'],
    ['application/javascript', 'https://x.test/a.cts', 'Cjs'],
    ['application/javascript', 'https://x.test/a.ts', 'JavaScript'],
    ['application/node', 'https://x.test/a.cjs', 'Cjs'],
    ['text/jscript', 'https://x.test/a.js', 'Jsx'],
    ['text/jsx', undefined, 'Jsx'],
    ['text/tsx', undefined, 'Tsx'],
    ['application/json', undefined, 'Json'],
    ['application/manifest+json', undefined, 'Json'],
    ['text/jsonc', undefined, 'Jsonc'],
    ['application/json5', undefined, 'Json5'],
    ['application/wasm', undefined, 'Wasm'],
    ['text/css', undefined, 'Css'],
    ['text/markdown', undefined, 'Markdown'],
    ['text/plain', 'https://x.test/a.ts', 'TypeScript'],
    ['application/octet-stream', 'https://x.test/a.wasm', 'Wasm'],
    ['text/plain', 'data:text/plain,a.ts', 'Unknown'],
    ['text/plain', undefined, 'Unknown'],
    ['text/html', 'https://x.test/index.html', 'Unknown'],
    ['image/png', undefined, 'Unknown'],
  ])('%s (%s) -> %s', (contentType, url, mediaType) => {
    expect(mediaTypeFromContentType(contentType, url)).toBe(mediaType)
  })
})

describe('mediaTypeExtension', () => {
  it('names a file with each media type so the name maps back to it', () => {
    const roundTrip = MEDIA_TYPES.map((mediaType) => [
      mediaType,
      mediaTypeFromFileName(`file${mediaTypeExtension(mediaType)}`),
    ])
    // Deno maps no file extension to Html or Sql (they come from content types only).
    const expected = MEDIA_TYPES.map((mediaType) => [
      mediaType,
      mediaType === 'Html' || mediaType === 'Sql' ? 'Unknown' : mediaType,
    ])
    expect(roundTrip).toEqual(expected)
    expect(mediaTypeExtension('Unknown')).toBe('')
    expect(mediaTypeExtension('Dmts')).toBe('.d.mts')
    expect(mediaTypeExtension('Markdown')).toBe('.md')
  })
})

describe('esbuildLoaderFor and moduleTypeFor', () => {
  it('follow the table of docs/architecture.md §2 (deno bundle)', () => {
    const table = Object.fromEntries(MEDIA_TYPES.map((type) => [type, esbuildLoaderFor(type)]))
    expect(table).toEqual({
      JavaScript: 'js',
      Mjs: 'js',
      Cjs: 'js',
      Mts: 'js',
      TypeScript: 'ts',
      Cts: 'ts',
      Dts: 'ts',
      Dmts: 'ts',
      Dcts: 'ts',
      Jsx: 'jsx',
      Tsx: 'jsx',
      Css: 'css',
      Json: 'json',
      Jsonc: 'text',
      Json5: 'text',
      Markdown: 'text',
      Html: 'text',
      Sql: 'text',
      SourceMap: 'text',
      Wasm: 'binary',
      Unknown: 'binary',
    })
    for (const type of MEDIA_TYPES) expect(moduleTypeFor(type)).toBe(esbuildLoaderFor(type))
  })
})
