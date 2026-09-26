import { describe, expect, it } from 'vitest'
import { lineColumn, tokenize } from './js-tokens.js'

/** The tokens as `type:value` strings. */
function kinds(code: string): string[] {
  return tokenize(code).map((token) => `${token.type}:${token.value}`)
}

describe('tokenize', () => {
  it('splits names, numbers, punctuators and strings, with offsets', () => {
    const tokens = tokenize('const a = b?.c ?? 1.5e+3 >>>= "x"')
    expect(tokens.map((token) => `${token.type}:${token.value}`)).toEqual([
      'name:const',
      'name:a',
      'punct:=',
      'name:b',
      'punct:?.',
      'name:c',
      'punct:??',
      'number:1.5e+3',
      'punct:>>>=',
      'string:x',
    ])
    expect(tokens[3]).toEqual({ type: 'name', value: 'b', start: 10, end: 11 })
  })

  it('skips line, block and hashbang comments', () => {
    expect(kinds('#!/usr/bin/env -S deno run\n// Deno.exit()\na /* Deno.exit() */ b')).toEqual([
      'name:a',
      'name:b',
    ])
  })

  it('decodes string escapes and keeps what a string contains out of the tokens', () => {
    const [token] = tokenize(String.raw`'it\'s A\x42\u{1F600} \n Deno.exit()'`)
    expect(token).toMatchObject({ type: 'string', value: "it's AB😀 \n Deno.exit()" })
    expect(kinds(`"a\\\nb" x`)).toEqual(['string:ab', 'name:x'])
  })

  it('tokenizes template substitutions and skips template text', () => {
    expect(kinds('`Deno.exit() ${Deno.cwd()} import.meta.main ${`${x}`}`')).toEqual([
      'template:`Deno.exit() ${',
      'name:Deno',
      'punct:.',
      'name:cwd',
      'punct:(',
      'punct:)',
      'template:} import.meta.main ${',
      'template:`${',
      'name:x',
      'template:}`',
      'template:}`',
    ])
    // Braces inside a substitution do not end it.
    expect(kinds('`${{ a: 1 }.a}` b')).toContain('name:b')
  })

  it('tells regular expressions from divisions', () => {
    expect(kinds('x = /Deno\\.exit\\(\\)[/]/g.test(y)')).toEqual([
      'name:x',
      'punct:=',
      'regex:/Deno\\.exit\\(\\)[/]/g',
      'punct:.',
      'name:test',
      'punct:(',
      'name:y',
      'punct:)',
    ])
    expect(kinds('a / b / c')).toEqual(['name:a', 'punct:/', 'name:b', 'punct:/', 'name:c'])
    expect(kinds('f(x) / 2')).toContain('punct:/')
    expect(kinds('return /x/')).toEqual(['name:return', 'regex:/x/'])
    // A slash with no closing one on the line is a division.
    expect(kinds('a = b\n/ c')).toEqual(['name:a', 'punct:=', 'name:b', 'punct:/', 'name:c'])
  })

  it('never throws on unterminated input', () => {
    expect(() => tokenize('"abc')).not.toThrow()
    expect(() => tokenize('`abc ${ x')).not.toThrow()
    expect(() => tokenize('/* abc')).not.toThrow()
    expect(kinds('"abc')).toEqual(['string:abc'])
  })

  it('reads private names and numbers that start with a dot', () => {
    expect(kinds('this.#x = .5; a?.5:1')).toEqual([
      'name:this',
      'punct:.',
      'private:#x',
      'punct:=',
      'number:.5',
      'punct:;',
      'name:a',
      'punct:?',
      'number:.5',
      'punct::',
      'number:1',
    ])
  })
})

describe('lineColumn', () => {
  it('is 1-based', () => {
    const code = 'a\nbc\n  Deno.cwd()'
    expect(lineColumn(code, 0)).toEqual({ line: 1, column: 1 })
    expect(lineColumn(code, code.indexOf('c'))).toEqual({ line: 2, column: 2 })
    expect(lineColumn(code, code.indexOf('Deno'))).toEqual({ line: 3, column: 3 })
  })
})
