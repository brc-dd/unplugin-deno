import { MagicString } from 'magic-string'
import { parseSync } from 'rolldown/utils'
import { parseAst } from 'rollup/parseAst'
import { describe, expect, it } from 'vitest'
import type { AstParser } from './attributes.js'
import type { SourceScan } from './source.js'
import { applySourceTransforms, scanAst, scanSource, scanTokens } from './source.js'

/** oxc through Rolldown, like `this.parse` in Rolldown and Vite 8 (TypeScript and JSX). */
const oxc: AstParser = (code, lang) => parseSync(`module.${lang}`, code, { lang }).program

/** Rollup's parser, like `this.parse` in Rollup and Vite 7 (JavaScript only). */
const rollupParse: AstParser = (code) => parseAst(code)

/** The scan without offsets, for comparing the two scanners. */
function summary(code: string, scan: SourceScan): object {
  return {
    importMetaMain: scan.importMetaMain.map((range) => code.slice(range.start, range.end)),
    envReads: scan.envReads.map((read) => ({
      text: code.slice(read.start, read.end),
      key: read.key,
      api: read.api,
    })),
    denoReferences: scan.denoReferences.map((reference) => reference.member),
  }
}

const SAMPLE = [
  'const main = import.meta.main',
  'const env = Deno.env.get("PUBLIC_A") ?? process.env.PUBLIC_B + process.env["PUBLIC_C"]',
  'const cwd = Deno.cwd()',
  "const text = 'Deno.exit() import.meta.main process.env.X' // Deno.exit()",
  '/* Deno.exit() */ const re = /Deno\\.exit/',
  'const all = Deno.env.toObject()',
  'export { main, env, cwd, text, re, all }',
].join('\n')

describe('scanSource', () => {
  it('finds import.meta.main, env reads and Deno references outside strings and comments', () => {
    const expected = {
      importMetaMain: ['import.meta.main'],
      envReads: [
        { text: 'Deno.env.get("PUBLIC_A")', key: 'PUBLIC_A', api: 'Deno.env.get' },
        { text: 'process.env.PUBLIC_B', key: 'PUBLIC_B', api: 'process.env' },
        { text: 'process.env["PUBLIC_C"]', key: 'PUBLIC_C', api: 'process.env' },
      ],
      denoReferences: ['env', 'cwd', 'env'],
    }
    const tokens = scanTokens(SAMPLE)
    expect(tokens.scanner).toBe('tokens')
    expect(summary(SAMPLE, tokens)).toEqual(expected)
    const ast = scanSource(SAMPLE, '/src/main.ts', oxc)
    expect(ast.scanner).toBe('ast')
    expect(summary(SAMPLE, ast)).toEqual(expected)
  })

  it('reads TypeScript and JSX with oxc, and ignores Deno types', () => {
    const code = [
      'const kv: Deno.Kv | null = null',
      'function f(x: Deno.ServeOptions): typeof Deno.env { return Deno.env }',
      "export const el = <p title={String(import.meta.main)}>it's {Deno.pid}</p>",
    ].join('\n')
    const scan = scanSource(code, '/src/app.tsx', oxc)
    expect(summary(code, scan)).toEqual({
      importMetaMain: ['import.meta.main'],
      envReads: [],
      denoReferences: ['env', 'pid'],
    })
  })

  it('falls back to the tokens when the parser cannot read the module (Rollup and TypeScript)', () => {
    const code = 'const kv: Deno.Kv = await Deno.openKv()\nexport const m = import.meta.main'
    const scan = scanSource(code, '/src/main.ts', rollupParse)
    expect(scan.scanner).toBe('tokens')
    // PascalCase members are taken for types by the token scanner.
    expect(summary(code, scan)).toEqual({
      importMetaMain: ['import.meta.main'],
      envReads: [],
      denoReferences: ['openKv'],
    })
    expect(scanSource('export const m = import.meta.main', '/src/a.js', rollupParse).scanner).toBe(
      'ast',
    )
  })

  it('counts PascalCase members as runtime references after new, before a call or a member', () => {
    const code = 'new Deno.Command("x"); Deno.UnsafePointer.of(p); let t: Deno.Kv'
    expect(summary(code, scanTokens(code))).toMatchObject({
      denoReferences: ['Command', 'UnsafePointer'],
    })
  })

  it('leaves writes, other objects and computed keys alone', () => {
    const code = [
      'process.env.PUBLIC_A = "x"',
      'process.env.PUBLIC_B += "x"',
      'delete process.env.PUBLIC_C',
      'process.env.PUBLIC_D++',
      'globalThis.process.env.PUBLIC_E',
      'foo.Deno.cwd()',
      'import.meta.main = true',
      'process.env[key]',
      'Deno.env.get(`PUBLIC_F`)',
      'Deno.env.get(name)',
    ].join('\n')
    for (const scan of [scanTokens(code), scanSource(code, '/a.js', oxc)]) {
      expect(summary(code, scan)).toMatchObject({ importMetaMain: [], envReads: [] })
    }
    expect(summary(code, scanTokens(code))).toMatchObject({ denoReferences: ['env', 'env'] })
  })

  it('reports UTF-16 offsets from both scanners', () => {
    const code = 'const s = "é😀"; export const m = import.meta.main'
    for (const scan of [scanTokens(code), scanSource(code, '/a.ts', oxc)]) {
      const [range] = scan.importMetaMain
      expect(code.slice(range?.start, range?.end)).toBe('import.meta.main')
    }
  })

  it('accepts a Program from any ESTree parser', () => {
    expect(scanAst(parseAst('export const m = import.meta.main')).importMetaMain).toHaveLength(1)
  })
})

describe('applySourceTransforms', () => {
  it('replaces import.meta.main and inlines allowed variables as JSON literals', () => {
    const magic = new MagicString(SAMPLE)
    const values: Record<string, string> = { PUBLIC_A: 'a "quoted" value', PUBLIC_B: 'b' }
    const applied = applySourceTransforms(magic, scanTokens(SAMPLE), {
      importMetaMain: true,
      envValue: (key) => (key.startsWith('PUBLIC_') ? values[key] : null),
    })
    expect(applied.changed).toBe(true)
    const code = magic.toString()
    expect(code).toContain('const main = false')
    expect(code).toContain('const env = "a \\"quoted\\" value" ?? "b" + undefined')
    expect(code).toContain("'Deno.exit() import.meta.main process.env.X'")
    expect(code).toContain('Deno.env.toObject()')
    // The inlined `Deno.env.get` is no longer a Deno reference.
    expect(applied.denoReferences.map((reference) => reference.member)).toEqual(['cwd', 'env'])
  })

  it('leaves reads the env callback declines, and import.meta.main when asked to', () => {
    const magic = new MagicString(SAMPLE)
    const applied = applySourceTransforms(magic, scanTokens(SAMPLE), {
      importMetaMain: false,
      envValue: () => null,
    })
    expect(applied.changed).toBe(false)
    expect(magic.toString()).toBe(SAMPLE)
    expect(applied.denoReferences).toHaveLength(3)
  })
})
