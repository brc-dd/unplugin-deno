import { describe, expect, it } from 'vitest'
import type { SpecifierKind } from './specifier.js'
import {
  formatJsrSpecifier,
  formatNpmSpecifier,
  isDenoScheme,
  parseJsrSpecifier,
  parseNpmSpecifier,
  parseSpecifier,
} from './specifier.js'

describe('parseSpecifier', () => {
  it.each<[string, SpecifierKind]>([
    ['jsr:@std/path@^1/join', 'jsr'],
    ['jsr:/@std/path@^1/join', 'jsr'],
    ['npm:kleur@^4', 'npm'],
    ['npm:/kleur@4.1.5/colors', 'npm'],
    ['https://jsr.io/@std/path/1.1.6/mod.ts', 'https'],
    ['HTTPS://example.com/x.ts', 'https'],
    ['http://localhost:8000/mod.ts', 'http'],
    ['data:text/javascript,export default 1', 'data'],
    ['node:fs', 'node'],
    ['bun:sqlite', 'bun'],
    ['cloudflare:workers', 'cloudflare'],
    ['file:///home/user/mod.ts', 'file'],
    ['file:///C:/Users/x/mod.ts', 'file'],
    ['react', 'bare'],
    ['react-dom/client', 'bare'],
    ['@std/path', 'bare'],
    ['@std/path/join', 'bare'],
    ['#internal/utils', 'bare'],
    ['.foo', 'bare'],
    ['..foo', 'bare'],
    ['.\\windows-style', 'bare'],
    ['', 'bare'],
    ['.', 'relative'],
    ['..', 'relative'],
    ['./mod.ts', 'relative'],
    ['../lib/mod.ts', 'relative'],
    ['./', 'relative'],
    ['/abs/mod.ts', 'absolute'],
    ['//cdn.example.com/x.js', 'absolute'],
    ['C:\\Users\\x\\mod.ts', 'absolute'],
    ['c:\\x', 'absolute'],
    ['C:/Users/x/mod.ts', 'absolute'],
    ['C:', 'absolute'],
    ['\\\\server\\share\\mod.ts', 'absolute'],
    ['\\\\?\\C:\\long\\mod.ts', 'absolute'],
    ['virtual:my-module', 'unknown-scheme'],
    ['\0virtual:x', 'unknown-scheme'],
    ['\0deno:empty', 'unknown-scheme'],
    ['mailto:x@example.com', 'unknown-scheme'],
    ['blob:https://example.com/uuid', 'unknown-scheme'],
    ['c:relative', 'unknown-scheme'],
  ])('%j is %s', (raw, kind) => {
    expect(parseSpecifier(raw).kind).toBe(kind)
  })

  it.each([
    ['./logo.svg?raw', './logo.svg', '?raw'],
    ['./worker.ts?worker&url', './worker.ts', '?worker&url'],
    ['npm:kleur@4?x#frag', 'npm:kleur@4', '?x#frag'],
    ['https://esm.sh/preact?target=es2022', 'https://esm.sh/preact', '?target=es2022'],
    ['./a.ts?v=123#top', './a.ts', '?v=123#top'],
    ['./a.ts#top', './a.ts#top', ''],
    ['C:\\x\\a.ts?raw', 'C:\\x\\a.ts', '?raw'],
    ['\\\\?\\C:\\x\\a.ts?raw', '\\\\?\\C:\\x\\a.ts', '?raw'],
    ['data:text/plain,a?b', 'data:text/plain,a?b', ''],
    ['data:text/plain,hello?deno-type=text', 'data:text/plain,hello', '?deno-type=text'],
    ['react', 'react', ''],
  ])('splits %j into %j + %j', (raw, base, query) => {
    const parsed = parseSpecifier(raw)
    expect(parsed).toEqual({ raw, kind: parsed.kind, base, query })
    expect(parsed.base + parsed.query).toBe(raw)
  })

  it('keeps virtual ids whole, even with a query', () => {
    expect(parseSpecifier('\0virtual:x?raw')).toEqual({
      raw: '\0virtual:x?raw',
      kind: 'unknown-scheme',
      base: '\0virtual:x?raw',
      query: '',
    })
    expect(parseSpecifier('virtual:x?y').query).toBe('')
  })
})

describe('isDenoScheme', () => {
  it.each<[SpecifierKind, boolean]>([
    ['jsr', true],
    ['npm', true],
    ['https', true],
    ['http', true],
    ['data', true],
    ['node', true],
    ['bun', true],
    ['cloudflare', true],
    ['file', true],
    ['bare', false],
    ['relative', false],
    ['absolute', false],
    ['unknown-scheme', false],
  ])('%s -> %s', (kind, expected) => {
    expect(isDenoScheme(kind)).toBe(expected)
  })
})

describe('parseNpmSpecifier', () => {
  it.each([
    ['npm:kleur', { name: 'kleur', subpath: '' }],
    ['npm:kleur@4', { name: 'kleur', range: '4', subpath: '' }],
    ['npm:kleur@^4.1.5', { name: 'kleur', range: '^4.1.5', subpath: '' }],
    ['npm:kleur@^1.2/colors', { name: 'kleur', range: '^1.2', subpath: '/colors' }],
    ['npm:kleur@latest', { name: 'kleur', range: 'latest', subpath: '' }],
    ['npm:/kleur@4.1.5/colors.mjs', { name: 'kleur', range: '4.1.5', subpath: '/colors.mjs' }],
    ['npm:/kleur', { name: 'kleur', subpath: '' }],
    ['npm:@types/node', { name: '@types/node', subpath: '' }],
    ['npm:@types/node@22', { name: '@types/node', range: '22', subpath: '' }],
    [
      'npm:@scope/pkg@^1.2.3/dist/index.js',
      { name: '@scope/pkg', range: '^1.2.3', subpath: '/dist/index.js' },
    ],
    ['npm:/@scope/pkg@1/x', { name: '@scope/pkg', range: '1', subpath: '/x' }],
    ['npm:preact@10/', { name: 'preact', range: '10', subpath: '' }],
    ['npm:preact@10/hooks/', { name: 'preact', range: '10', subpath: '/hooks/' }],
    ['npm:lodash@4.17.21/fp/map.js', { name: 'lodash', range: '4.17.21', subpath: '/fp/map.js' }],
    ['npm:react@19.0.0-rc.1', { name: 'react', range: '19.0.0-rc.1', subpath: '' }],
  ])('%s', (input, expected) => {
    expect(parseNpmSpecifier(input)).toEqual(expected)
  })

  it.each([
    'npm:',
    'npm:/',
    'npm:@scope',
    'npm:@scope/',
    'npm:kleur@',
    'npm:@scope/@1',
    'jsr:@std/path',
    'kleur',
  ])('rejects %j', (input) => {
    expect(parseNpmSpecifier(input)).toBeNull()
  })
})

describe('parseJsrSpecifier', () => {
  it.each([
    ['jsr:@std/path', { name: '@std/path', subpath: '' }],
    ['jsr:@std/path@1', { name: '@std/path', range: '1', subpath: '' }],
    ['jsr:@std/path@^1/join', { name: '@std/path', range: '^1', subpath: '/join' }],
    ['jsr:/@std/path@^1/join', { name: '@std/path', range: '^1', subpath: '/join' }],
    [
      'jsr:@std/path@1.1.6/posix/join.ts',
      { name: '@std/path', range: '1.1.6', subpath: '/posix/join.ts' },
    ],
    ['jsr:/@std/fmt@^1/', { name: '@std/fmt', range: '^1', subpath: '' }],
  ])('%s', (input, expected) => {
    expect(parseJsrSpecifier(input)).toEqual(expected)
  })

  it.each(['jsr:', 'jsr:path', 'jsr:std/path', 'jsr:@std', 'jsr:@std/path@', 'npm:@std/path'])(
    'rejects %j',
    (input) => {
      expect(parseJsrSpecifier(input)).toBeNull()
    },
  )
})

describe('formatNpmSpecifier / formatJsrSpecifier', () => {
  it.each([
    'npm:kleur',
    'npm:kleur@4',
    'npm:kleur@^4/colors',
    'npm:@scope/pkg@1.2.3/dist/x.js',
    'npm:react@latest',
  ])('round-trips %s', (specifier) => {
    const parsed = parseNpmSpecifier(specifier)
    expect(parsed).not.toBeNull()
    expect(formatNpmSpecifier(parsed ?? { name: '', subpath: '' })).toBe(specifier)
  })

  it.each(['jsr:@std/path', 'jsr:@std/path@^1', 'jsr:@std/path@1.1.6/join'])(
    'round-trips %s',
    (specifier) => {
      const parsed = parseJsrSpecifier(specifier)
      expect(parsed).not.toBeNull()
      expect(formatJsrSpecifier(parsed ?? { name: '', subpath: '' })).toBe(specifier)
    },
  )

  it('normalises the slash form and subpaths', () => {
    expect(formatNpmSpecifier({ name: 'kleur', range: '4', subpath: 'colors' })).toBe(
      'npm:kleur@4/colors',
    )
    expect(formatNpmSpecifier({ name: 'kleur', subpath: '/' })).toBe('npm:kleur')
    const slashForm = parseJsrSpecifier('jsr:/@std/path@^1/join')
    expect(slashForm && formatJsrSpecifier(slashForm)).toBe('jsr:@std/path@^1/join')
  })
})
