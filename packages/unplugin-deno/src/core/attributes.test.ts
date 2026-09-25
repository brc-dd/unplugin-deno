import { parseAst } from 'rolldown/parseAst'
import { describe, expect, it, onTestFinished } from 'vitest'
import { tempDir } from '../../test/helpers/temp-dir.js'
import type { AstParser } from './attributes.js'
import {
  BYTES_INLINE_LIMIT,
  importsFromAst,
  isDenoType,
  langForId,
  scanImports,
  synthesizeMarkerModule,
  transformImportAttributes,
} from './attributes.js'

const parse: AstParser = (code, lang) => parseAst(code, { lang })

const failing: AstParser = () => {
  throw new SyntaxError('Unexpected token')
}

function transform(code: string, id = '/src/main.ts', parser?: AstParser): string | null {
  return transformImportAttributes(code, id, parser)?.code ?? null
}

describe('isDenoType / langForId', () => {
  it('knows the marker types', () => {
    expect(['text', 'bytes', 'css'].every(isDenoType)).toBe(true)
    expect(['json', 'javascript', '', undefined, 1].some(isDenoType)).toBe(false)
  })

  it.each([
    ['/a/b.tsx', 'tsx'],
    ['/a/b.ts', 'ts'],
    ['/a/b.mts?x', 'ts'],
    ['C:\\a\\b.cts', 'ts'],
    ['/a/b.jsx', 'jsx'],
    ['/a/b.js', 'jsx'],
    ['/a/b.vue?vue&type=script', 'jsx'],
  ])('%s → %s', (id, lang) => {
    expect(langForId(id)).toBe(lang)
  })
})

describe('transformImportAttributes', () => {
  it('rewrites text, bytes and css imports to markers and drops the clause', () => {
    const code = [
      "import text from './data.txt' with { type: 'text' }",
      "import bytes from './data.bin' with { type: 'bytes' };",
      "export { default as sheet } from './style.css' with { type: 'css' }",
      "import json from './data.json' with { type: 'json' }",
    ].join('\n')
    expect(transform(code)).toBe(
      [
        'import text from "./data.txt?deno-type=text"',
        'import bytes from "./data.bin?deno-type=bytes";',
        'export { default as sheet } from "./style.css?deno-type=css"',
        "import json from './data.json' with { type: 'json' }",
      ].join('\n'),
    )
  })

  it('rewrites dynamic imports and removes the options argument', () => {
    const code = [
      "const a = await import('./a.txt', { with: { type: 'text' } })",
      'const b = import("./b.bin", { with: { type: "bytes" } }, )',
      "const c = import('./c.json', { with: { type: 'json' } })",
    ].join('\n')
    expect(transform(code)).toBe(
      [
        'const a = await import("./a.txt?deno-type=text")',
        'const b = import("./b.bin?deno-type=bytes")',
        "const c = import('./c.json', { with: { type: 'json' } })",
      ].join('\n'),
    )
  })

  it('keeps existing queries and handles remote, npm and data specifiers', () => {
    const code = [
      "import a from './a.txt?raw' with { type: 'text' }",
      "import b from 'https://x.test/b.txt?v=1' with { type: 'bytes' }",
      "import c from 'npm:pkg@1/c.css' with { type: 'css' }",
      "import d from 'data:text/plain,hi?' with { type: 'text' }",
    ].join('\n')
    expect(transform(code)).toBe(
      [
        'import a from "./a.txt?raw&deno-type=text"',
        'import b from "https://x.test/b.txt?v=1&deno-type=bytes"',
        'import c from "npm:pkg@1/c.css?deno-type=css"',
        'import d from "data:text/plain,hi??deno-type=text"',
      ].join('\n'),
    )
  })

  it('leaves type-only, template, non-literal and unknown-type imports alone', () => {
    const code = [
      "import type { T } from './t.ts' with { type: 'text' }",
      "const t = import(`./${name}.txt`, { with: { type: 'text' } })",
      "const o = import('./o.txt', options)",
      "import w from './w.wasm' with { type: 'webassembly' }",
    ].join('\n')
    expect(transform(code)).toBeNull()
  })

  it('does nothing without `with` or without attributes', () => {
    expect(transform("import a from './a.ts'")).toBeNull()
    expect(transform('const withText = \'with { type: "text" }\'')).toBeNull()
  })

  it('returns a source map of the edit', () => {
    const result = transformImportAttributes(
      "import t from './t.txt' with { type: 'text' }\nexport default t\n",
      '/src/main.ts',
    )
    expect(result?.map).toMatchObject({ version: 3, sources: ['/src/main.ts'] })
    expect(result?.map.sourcesContent?.[0]).toContain("with { type: 'text' }")
    expect(result?.map.mappings).not.toBe('')
  })

  it('falls back to the host parser for JSX and TSX', () => {
    const tsx = [
      "import type { FC } from 'react'",
      "import text from './a.txt' with { type: 'text' };",
      'export const A: FC<{ a: number }> = ({ a }) => <span title="é😀">{a / 2}</span>',
      "const b = await import('./b.bin', { with: { type: 'bytes' } })",
      "import j from './j.json' with { type: 'json' }",
    ].join('\n')
    expect(transform(tsx, '/src/a.tsx')).toBeNull()
    expect(transform(tsx, '/src/a.tsx', parse)).toBe(
      [
        "import type { FC } from 'react'",
        'import text from "./a.txt?deno-type=text";',
        'export const A: FC<{ a: number }> = ({ a }) => <span title="é😀">{a / 2}</span>',
        'const b = await import("./b.bin?deno-type=bytes")',
        "import j from './j.json' with { type: 'json' }",
      ].join('\n'),
    )
    const jsx = "const el = <div />\nexport { default as c } from './c.css' with { type: 'css' }"
    expect(transform(jsx, '/src/a.jsx', parse)).toBe(
      'const el = <div />\nexport { default as c } from "./c.css?deno-type=css"',
    )
  })

  it('skips code neither the lexer nor the parser can read', () => {
    const broken = "import a from './a.txt' with { type: 'text' }\nconst x = <div>{a}</div>\n<<<"
    expect(transform(broken, '/src/a.tsx', failing)).toBeNull()
    expect(scanImports(broken, '/src/a.tsx', failing)).toBeNull()
    expect(transform(broken, '/src/a.tsx', parse)).toBeNull()
  })
})

describe('importsFromAst', () => {
  it('reads declarations, re-exports and import() expressions', () => {
    const code = [
      "import a from './a.txt' with { type: 'text' }",
      "export * from './b.json' with { type: 'json' };",
      "import type { T } from './t.ts'",
      'const c = import(`./c.js`)',
      "const d = () => import('./d.css', { with: { 'type': 'css' } })",
      "const e = import('./e.txt', { with: { type: variable } })",
    ].join('\n')
    const imports = importsFromAst(code, parseAst(code, { lang: 'ts' }))
    expect(
      imports.map(({ specifier, typeOnly, template, attributes, clause, start, end }) => ({
        specifier,
        literal: code.slice(start, end),
        typeOnly,
        template,
        attributes,
        clause: clause === null ? null : code.slice(clause.start, clause.end),
      })),
    ).toEqual([
      {
        specifier: './a.txt',
        literal: "'./a.txt'",
        typeOnly: false,
        template: false,
        attributes: { type: 'text' },
        clause: " with { type: 'text' }",
      },
      {
        specifier: './b.json',
        literal: "'./b.json'",
        typeOnly: false,
        template: false,
        attributes: { type: 'json' },
        clause: " with { type: 'json' }",
      },
      {
        specifier: './t.ts',
        literal: "'./t.ts'",
        typeOnly: true,
        template: false,
        attributes: null,
        clause: null,
      },
      {
        specifier: undefined,
        literal: '`./c.js`',
        typeOnly: false,
        template: true,
        attributes: null,
        clause: null,
      },
      {
        specifier: './d.css',
        literal: "'./d.css'",
        typeOnly: false,
        template: false,
        attributes: { type: 'css' },
        clause: ", { with: { 'type': 'css' } }",
      },
      {
        specifier: './e.txt',
        literal: "'./e.txt'",
        typeOnly: false,
        template: false,
        attributes: null,
        clause: ', { with: { type: variable } }',
      },
    ])
  })

  it('ignores values that are not ESTree nodes', () => {
    expect(importsFromAst('', null)).toEqual([])
    expect(importsFromAst('', { type: 'Program', body: 'x' })).toEqual([])
  })
})

let evaluated = 0

/** Imports a synthesised module from a file (Bun rejects long `data:` URLs). */
async function evaluate(code: string): Promise<unknown> {
  const dir = await tempDir({ [`module-${++evaluated}.mjs`]: code })
  onTestFinished(() => dir.dispose())
  const namespace = (await import(dir.url(`module-${evaluated}.mjs`))) as { default: unknown }
  return namespace.default
}

describe('synthesizeMarkerModule', () => {
  const encoder = new TextEncoder()

  it('exports text as a string', async () => {
    const module = synthesizeMarkerModule(
      'text',
      encoder.encode('héllo "world"\n\u2028'),
      'file:///a.txt',
    )
    expect(module.moduleType).toBe('js')
    expect(await evaluate(module.code)).toBe('héllo "world"\n\u2028')
  })

  it('removes a byte-order mark from text, as UTF-8 decoding does', async () => {
    const module = synthesizeMarkerModule(
      'text',
      new Uint8Array([0xef, 0xbb, 0xbf, 0x61]),
      'file:///a.txt',
    )
    expect(await evaluate(module.code)).toBe('a')
  })

  it('exports small byte arrays as a literal', async () => {
    const module = synthesizeMarkerModule(
      'bytes',
      new Uint8Array([0, 1, 250, 255]),
      'file:///a.bin',
    )
    expect(module.code).toBe('export default new Uint8Array([0,1,250,255]);\n')
    const value = await evaluate(module.code)
    expect(value).toBeInstanceOf(Uint8Array)
    expect([...(value as Uint8Array)]).toEqual([0, 1, 250, 255])
  })

  it('decodes larger byte arrays from base64 at runtime', async () => {
    const bytes = new Uint8Array(BYTES_INLINE_LIMIT + 7).map((_, index) => (index * 31) % 256)
    const module = synthesizeMarkerModule('bytes', bytes, 'file:///a.bin')
    expect(module.code).toContain('atob(')
    expect(module.code.length).toBeLessThan(bytes.length * 2)
    expect([...((await evaluate(module.code)) as Uint8Array)]).toEqual([...bytes])
    const empty = synthesizeMarkerModule('bytes', new Uint8Array(), 'file:///e.bin')
    expect([...((await evaluate(empty.code)) as Uint8Array)]).toEqual([])
  })

  it('exports a constructed CSSStyleSheet for css', async () => {
    const module = synthesizeMarkerModule(
      'css',
      encoder.encode('a { color: red }'),
      'file:///a.css',
    )
    expect(module.code).toBe(
      'const sheet = new CSSStyleSheet();\nsheet.replaceSync("a { color: red }");\nexport default sheet;\n',
    )
  })

  it('rejects text that is not UTF-8', () => {
    const invalid = new Uint8Array([0xff, 0xfe, 0xfd])
    expect(() => synthesizeMarkerModule('text', invalid, 'https://x.test/a.bin')).toThrow(
      expect.objectContaining({
        name: 'DenoPluginError',
        code: 'UNSUPPORTED_MEDIA_TYPE',
        specifier: 'https://x.test/a.bin',
        message: expect.stringContaining('https://x.test/a.bin'),
      }),
    )
    expect(() => synthesizeMarkerModule('css', invalid, 'file:///a.css')).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_MEDIA_TYPE' }),
    )
  })
})
