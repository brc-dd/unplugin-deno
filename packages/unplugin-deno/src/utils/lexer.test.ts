import { describe, expect, it } from 'vitest'
import type { ScannedImport } from './lexer.js'
import { initLexer, LexerError, parseImportAttributes, scanModule } from './lexer.js'

/** The imports of `code` with the source text of their literal and clause. */
function scan(code: string): Array<Record<string, unknown>> {
  return scanModule(code).imports.map((entry: ScannedImport) => ({
    specifier: entry.specifier,
    literal: code.slice(entry.start, entry.end),
    dynamic: entry.dynamic,
    template: entry.template,
    typeOnly: entry.typeOnly,
    attributes: entry.attributes,
    clause: entry.clause === null ? null : code.slice(entry.clause.start, entry.clause.end),
  }))
}

describe('scanModule', () => {
  it('compiles the lexer ahead of time on request', async () => {
    await expect(initLexer()).resolves.toBeUndefined()
  })

  it('reports static imports, re-exports and their literals', () => {
    const code = [
      "import a from './a.ts'",
      'import { b } from "./b.ts";',
      "import './side-effect.js'",
      "export { c } from './c.ts'",
      "export * from './d.ts'",
      "export * as e from './e.ts'",
    ].join('\n')
    expect(scan(code)).toEqual([
      {
        specifier: './a.ts',
        literal: "'./a.ts'",
        dynamic: false,
        template: false,
        typeOnly: false,
        attributes: null,
        clause: null,
      },
      {
        specifier: './b.ts',
        literal: '"./b.ts"',
        dynamic: false,
        template: false,
        typeOnly: false,
        attributes: null,
        clause: null,
      },
      {
        specifier: './side-effect.js',
        literal: "'./side-effect.js'",
        dynamic: false,
        template: false,
        typeOnly: false,
        attributes: null,
        clause: null,
      },
      {
        specifier: './c.ts',
        literal: "'./c.ts'",
        dynamic: false,
        template: false,
        typeOnly: false,
        attributes: null,
        clause: null,
      },
      {
        specifier: './d.ts',
        literal: "'./d.ts'",
        dynamic: false,
        template: false,
        typeOnly: false,
        attributes: null,
        clause: null,
      },
      {
        specifier: './e.ts',
        literal: "'./e.ts'",
        dynamic: false,
        template: false,
        typeOnly: false,
        attributes: null,
        clause: null,
      },
    ])
  })

  it('reads static import attributes and the clause that holds them', () => {
    const code = [
      "import t from './t.txt' with { type: 'text' };",
      'import b from "./b.bin" with {type:"bytes"}',
      "import j from './j.json' with { \"type\": 'json' }",
      "export { default as c } from './c.css' with { type: 'css' };",
      "export * from './x.json' with { type: 'json' }",
    ].join('\n')
    expect(
      scan(code).map((entry) => ({ attributes: entry.attributes, clause: entry.clause })),
    ).toEqual([
      { attributes: { type: 'text' }, clause: " with { type: 'text' }" },
      { attributes: { type: 'bytes' }, clause: ' with {type:"bytes"}' },
      { attributes: { type: 'json' }, clause: ' with { "type": \'json\' }' },
      { attributes: { type: 'css' }, clause: " with { type: 'css' }" },
      { attributes: { type: 'json' }, clause: " with { type: 'json' }" },
    ])
  })

  it('finds a clause the lexer misses (trailing comma, multi-line, comments)', () => {
    const trailing = "import t from './t.txt' with { type: 'text', };"
    expect(scan(trailing)[0]).toMatchObject({
      attributes: { type: 'text' },
      clause: " with { type: 'text', }",
    })
    const multiline = "import {\n  a,\n} from './t.txt' with {\n  type: 'text',\n}\n"
    expect(scan(multiline)[0]).toMatchObject({
      attributes: { type: 'text' },
      clause: " with {\n  type: 'text',\n}",
    })
    const commented =
      "import a from './t.txt' /* c */ with /* d */ { /* e */ type: 'text' /* f */ };"
    expect(scan(commented)[0]).toMatchObject({ attributes: { type: 'text' } })
  })

  it('reports attributes without a type as an empty object', () => {
    expect(scan("import a from './a.js' with { other: 'x' }")[0]?.attributes).toEqual({})
  })

  it('reports dynamic imports with their options argument', () => {
    const code = [
      "const a = await import('./a.ts')",
      "const t = await import('./t.txt', { with: { type: 'text' } })",
      'const b = import("./b.bin", { with: { type: "bytes" } }, )',
      "const legacy = import('./l.json', { assert: { type: 'json' } })",
      "const opts = import('./o.txt', options)",
    ].join('\n')
    expect(scan(code)).toEqual([
      expect.objectContaining({
        specifier: './a.ts',
        literal: "'./a.ts'",
        dynamic: true,
        attributes: null,
        clause: null,
      }),
      expect.objectContaining({
        specifier: './t.txt',
        dynamic: true,
        attributes: { type: 'text' },
        clause: ", { with: { type: 'text' } }",
      }),
      expect.objectContaining({
        specifier: './b.bin',
        attributes: { type: 'bytes' },
        clause: ', { with: { type: "bytes" } }, ',
      }),
      expect.objectContaining({ specifier: './l.json', attributes: { type: 'json' } }),
      expect.objectContaining({ specifier: './o.txt', attributes: null, clause: ', options' }),
    ])
  })

  it('marks template-literal and non-literal dynamic imports', () => {
    const code = 'import(`./locale/${name}.js`)\nimport(`./plain.js`)\nimport(base + "/x.js")\n'
    expect(scan(code)).toEqual([
      expect.objectContaining({ specifier: undefined, template: true }),
      expect.objectContaining({ specifier: undefined, template: true }),
      expect.objectContaining({ specifier: undefined, template: false }),
    ])
  })

  it('ignores import.meta and import( inside strings, comments and regular expressions', () => {
    const code = [
      'const url = import.meta.url',
      'const s = "import(\'./nope.js\')"',
      '// import("./comment.js")',
      '/* import x from "./block.js" */',
      'const r = /import("x")/g',
      "const t = `import('./template.js')`",
      "import real from './real.js'",
    ].join('\n')
    expect(scan(code).map((entry) => entry.specifier)).toEqual(['./real.js'])
  })

  it('reads TypeScript and marks type-only imports', () => {
    const code = [
      "import type { A } from './types.ts'",
      "import { type B, c } from './mixed.ts'",
      'function f<T extends string = "a">(a: T): Array<T> { return [a] }',
      "export type { D } from './d.ts'",
      "const x = import('./lazy.ts') as Promise<unknown>",
    ].join('\n')
    expect(scan(code).map(({ specifier, typeOnly }) => ({ specifier, typeOnly }))).toEqual([
      { specifier: './types.ts', typeOnly: true },
      { specifier: './mixed.ts', typeOnly: false },
      { specifier: './d.ts', typeOnly: true },
      { specifier: './lazy.ts', typeOnly: false },
    ])
  })

  it('decodes escape sequences in specifiers', () => {
    expect(scan("import a from './\\u0061.js'")[0]?.specifier).toBe('./a.js')
  })

  it('lists exports', () => {
    const { exports, hasModuleSyntax } = scanModule(
      "export const a = 1\nexport default 2\nexport { b as c } from './b.js'\nexport * from './d.js'",
    )
    expect(hasModuleSyntax).toBe(true)
    expect(exports).toEqual([
      { name: 'a', kind: 'direct' },
      { name: 'default', kind: 'direct' },
      { name: 'c', kind: 'reexport', from: './b.js' },
      { name: '*', kind: 'reexport-all', from: './d.js' },
    ])
  })

  it('reports scripts without module syntax', () => {
    expect(scanModule('var x = 1').hasModuleSyntax).toBe(false)
  })

  it('throws a LexerError for JSX and syntax errors', () => {
    expect(() => scanModule('const a = <div>{x}</div>')).toThrow(LexerError)
    expect(() => scanModule('import { from')).toThrow(LexerError)
  })
})

function attributes(text: string): unknown {
  return parseImportAttributes(text, 0, text.length)
}

describe('parseImportAttributes', () => {
  it.each([
    ["{ type: 'text' }", { type: 'text' }],
    ['{type:"bytes"}', { type: 'bytes' }],
    ["{ 'type': 'css', }", { type: 'css' }],
    ['{ /* c */ type /* d */ : // e\n "json" }', { type: 'json' }],
    ["{ other: 'x' }", {}],
    ['{}', {}],
    ["{ with: { type: 'text' } }", { type: 'text' }],
    ["{ assert: { type: 'json' } }", { type: 'json' }],
    ['{ with: {} }', {}],
    ["  { with: { type: 'te\\u0078t' } } )", { type: 'text' }],
  ])('%j → %j', (text, expected) => {
    expect(attributes(text)).toEqual(expected)
  })

  it.each([
    'options',
    '{ type: variable }',
    '{ with: variable }',
    '{ type: `text` }',
    "{ type: 'text'",
    '{ type: { nested: "x" } }',
    "{ type 'text' }",
    "{ type: 'text' extra }",
    "{ type: 'unterminated }",
  ])('returns null for %j', (text) => {
    expect(attributes(text)).toBeNull()
  })

  it('stops at the given end', () => {
    const text = "{ type: 'text' } trailing"
    expect(parseImportAttributes(text, 0, 5)).toBeNull()
    expect(parseImportAttributes(text, 0, 16)).toEqual({ type: 'text' })
  })
})
