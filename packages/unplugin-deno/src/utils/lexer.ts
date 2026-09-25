/**
 * Import/export scanning over `es-module-lexer` (docs/architecture.md §5.3, §5.5): specifier
 * positions, dynamic imports and import attributes, without a full parser. The lexer handles
 * JavaScript and TypeScript but not JSX; {@link scanModule} throws {@link LexerError} for code it
 * cannot lex, and callers fall back to an AST (see `core/attributes.ts`).
 *
 * @module
 */
import type { Import } from 'es-module-lexer'
import { init, parse } from 'es-module-lexer'

/** Import attributes read from a `with { … }` clause (or a dynamic import's options). */
export interface ImportAttributes {
  /** The `type` attribute (`"json"`, `"text"`, `"bytes"`, `"css"`, …), when present. */
  type?: string
}

/** One import (static, re-export or dynamic) found by {@link scanModule}. */
export interface ScannedImport {
  /**
   * The specifier with escape sequences decoded, or `undefined` for a dynamic import whose
   * argument is not a plain string literal.
   */
  specifier: string | undefined
  /** Start of the specifier's string literal, at its opening quote. */
  start: number
  /** End of the specifier's string literal, after its closing quote. */
  end: number
  /** `import(…)` rather than an `import`/`export … from` statement. */
  dynamic: boolean
  /** A dynamic import whose argument is a template literal (never rewritten). */
  template: boolean
  /** A TypeScript type-only import (`import type …`, `typeof import(…)`), erased by the compiler. */
  typeOnly: boolean
  /**
   * Start of the attributes: the `{` of `with { … }` for a statement, the second argument of a
   * dynamic import; `-1` when there are none.
   */
  attributesStart: number
  /**
   * End of the statement (static; after the attributes, before any `;`) or of the `import(…)`
   * expression (dynamic; after the `)`).
   */
  statementEnd: number
  /** The attributes, `null` when there are none or they are not literal (`import(x, options)`). */
  attributes: ImportAttributes | null
  /**
   * The source range that holds the attributes and can be removed: ` with { … }` after a static
   * specifier, `, { with: { … } }` after a dynamic one (up to the `)`). `null` without attributes.
   */
  clause: { start: number; end: number } | null
}

/** One export found by {@link scanModule}. */
export interface ScannedExport {
  /** The exported name; `*` for `export * from`. */
  name: string
  kind: 'direct' | 'reexport' | 'reexport-all'
  /** The module re-exported from. */
  from?: string
}

/** The result of {@link scanModule}. */
export interface ScanResult {
  imports: ScannedImport[]
  exports: ScannedExport[]
  /** Whether the code uses `import`/`export` syntax at all. */
  hasModuleSyntax: boolean
}

/** The lexer could not read the code (JSX, or a syntax error). */
export class LexerError extends Error {
  override readonly name = 'LexerError'
  /** Offset of the problem in the code, when known. */
  readonly index: number | undefined

  constructor(message: string, index: number | undefined, cause: unknown) {
    super(message, { cause })
    this.index = index
  }
}

/**
 * Compiles the lexer's WebAssembly ahead of time. Optional: {@link scanModule} compiles it
 * synchronously on first use.
 */
export function initLexer(): Promise<void> {
  return init()
}

/**
 * Lists the imports (static, re-exports, string-literal and template dynamic imports) and exports
 * of a JavaScript or TypeScript module. `import.meta` is ignored; strings and comments that merely
 * contain `import(` are not imports.
 *
 * @throws {LexerError} When the code cannot be lexed (JSX, syntax errors).
 */
export function scanModule(code: string): ScanResult {
  let result: ReturnType<typeof parse>
  try {
    result = parse(code)
  } catch (error) {
    const index = (error as { idx?: unknown }).idx
    throw new LexerError(
      `Cannot scan the imports of this module: ${error instanceof Error ? error.message : String(error)}`,
      typeof index === 'number' ? index : undefined,
      error,
    )
  }
  const [imports, exports, , hasModuleSyntax] = result
  return {
    imports: imports.flatMap((entry) => {
      const scanned = scanImport(code, entry)
      return scanned === undefined ? [] : [scanned]
    }),
    exports: exports.map((entry) =>
      entry.type === 'direct'
        ? { name: entry.name, kind: 'direct' as const }
        : entry.type === 'reexport'
          ? { name: entry.name, kind: 'reexport' as const, from: entry.from }
          : { name: '*', kind: 'reexport-all' as const, from: entry.from },
    ),
    hasModuleSyntax,
  }
}

function scanImport(code: string, entry: Import): ScannedImport | undefined {
  if (entry.type === 'import-meta') return undefined
  if (entry.type === 'dynamic') {
    const template = code[entry.start] === '`'
    const literal = !template && isQuote(code[entry.start])
    const statementEnd = entry.importEnd
    const attributes =
      entry.attributesStart < 0
        ? null
        : parseImportAttributes(code, entry.attributesStart, statementEnd - 1)
    return {
      specifier: literal ? entry.specifier : undefined,
      start: entry.start,
      end: entry.end,
      dynamic: true,
      template,
      typeOnly: entry.probablyTypeOnly,
      attributesStart: entry.attributesStart,
      statementEnd,
      attributes,
      // `, { with: { type } }` up to the closing parenthesis.
      clause: entry.attributesStart < 0 ? null : { start: entry.end, end: statementEnd - 1 },
    }
  }
  // Static imports and re-exports: the lexer reports the specifier without its quotes.
  const start = entry.start - 1
  const end = entry.end + 1
  let attributesStart = entry.attributesStart
  let statementEnd = entry.importEnd
  let attributes: ImportAttributes | null = null
  if (attributesStart >= 0) {
    attributes =
      fromLexerAttributes(entry.attributes) ??
      parseImportAttributes(code, attributesStart, statementEnd)
  } else {
    // es-module-lexer 3 drops a clause with a trailing comma (`with { type: "text", }`); find it.
    const found = findWithClause(code, end)
    if (found !== null) {
      attributesStart = found.attributesStart
      statementEnd = found.end
      attributes = found.attributes
    }
  }
  return {
    specifier: entry.specifier,
    start,
    end,
    dynamic: false,
    template: false,
    typeOnly: entry.typeOnly,
    attributesStart,
    statementEnd,
    attributes,
    clause: attributesStart < 0 ? null : { start: end, end: statementEnd },
  }
}

function fromLexerAttributes(
  attributes: ReadonlyArray<readonly [string, string]> | null,
): ImportAttributes | null {
  if (attributes === null) return null
  const type = attributes.find(([key]) => key === 'type')?.[1]
  return type === undefined ? {} : { type }
}

/**
 * Reads the import attributes between `attributesStart` and `statementEnd` without a full parser:
 * a static `{ type: "text" }` clause (the `{` at `attributesStart`), or a dynamic import's options
 * object `{ with: { type: "text" } }` (also the legacy `assert` key). Keys may be identifiers or
 * strings; comments and trailing commas are allowed. Returns `null` when the text is not such an
 * object literal (for example `import(x, options)`).
 */
export function parseImportAttributes(
  source: string,
  attributesStart: number,
  statementEnd: number,
): ImportAttributes | null {
  const object = readObject(source, attributesStart, statementEnd)
  if (object === null) return null
  const nested = object.value.get('with') ?? object.value.get('assert')
  const attributes = nested instanceof Map ? nested : nested === undefined ? object.value : null
  if (attributes === null) return null
  const type = attributes.get('type')
  if (type instanceof Map) return null
  return type === undefined ? {} : { type }
}

/** A ` with { … }` clause after the specifier literal ending at `from`, or `null`. */
function findWithClause(
  source: string,
  from: number,
): { attributesStart: number; end: number; attributes: ImportAttributes } | null {
  const keywordStart = skipTrivia(source, from, source.length)
  const keyword = /^(?:with|assert)\b/.exec(source.slice(keywordStart, keywordStart + 7))
  if (keyword === null) return null
  const attributesStart = skipTrivia(source, keywordStart + keyword[0].length, source.length)
  if (source[attributesStart] !== '{') return null
  const object = readObject(source, attributesStart, source.length)
  if (object === null) return null
  const type = object.value.get('type')
  return {
    attributesStart,
    end: object.end,
    attributes: typeof type === 'string' ? { type } : {},
  }
}

type LiteralValue = string | Map<string, LiteralValue>

/** Reads an object literal whose values are strings or nested object literals. */
function readObject(
  source: string,
  start: number,
  limit: number,
): { value: Map<string, LiteralValue>; end: number } | null {
  let index = skipTrivia(source, start, limit)
  if (source[index] !== '{') return null
  index++
  const value = new Map<string, LiteralValue>()
  for (;;) {
    index = skipTrivia(source, index, limit)
    if (index >= limit) return null
    if (source[index] === '}') return { value, end: index + 1 }
    const key = readKey(source, index, limit)
    if (key === null) return null
    index = skipTrivia(source, key.end, limit)
    if (source[index] !== ':') return null
    index = skipTrivia(source, index + 1, limit)
    let item: { value: LiteralValue; end: number } | null
    if (source[index] === '{') item = readObject(source, index, limit)
    else item = readString(source, index, limit)
    if (item === null) return null
    value.set(key.value, item.value)
    index = skipTrivia(source, item.end, limit)
    if (source[index] === ',') index++
    else if (source[index] !== '}') return null
  }
}

function readKey(
  source: string,
  start: number,
  limit: number,
): { value: string; end: number } | null {
  if (isQuote(source[start])) return readString(source, start, limit)
  const identifier = /^[A-Za-z_$][\w$]*/.exec(source.slice(start, Math.min(limit, start + 64)))
  return identifier === null ? null : { value: identifier[0], end: start + identifier[0].length }
}

/** Reads a single- or double-quoted string literal with the common escapes. */
function readString(
  source: string,
  start: number,
  limit: number,
): { value: string; end: number } | null {
  const quote = source[start]
  if (!isQuote(quote)) return null
  let value = ''
  for (let index = start + 1; index < limit; index++) {
    const char = source[index]
    if (char === quote) return { value, end: index + 1 }
    if (char === '\n' || char === '\r' || char === undefined) return null
    if (char !== '\\') {
      value += char
      continue
    }
    const next = source[++index]
    if (next === 'u' && /^[\da-fA-F]{4}$/.test(source.slice(index + 1, index + 5))) {
      value += String.fromCharCode(Number.parseInt(source.slice(index + 1, index + 5), 16))
      index += 4
    } else if (next !== undefined) {
      value += ESCAPES[next] ?? next
    }
  }
  return null
}

const ESCAPES: Readonly<Record<string, string>> = {
  n: '\n',
  r: '\r',
  t: '\t',
  b: '\b',
  f: '\f',
  v: '\v',
  '0': '\0',
}

/** Skips whitespace, line comments and block comments. */
function skipTrivia(source: string, start: number, limit: number): number {
  let index = start
  while (index < limit) {
    const char = source[index]
    if (
      char === ' ' ||
      char === '\t' ||
      char === '\n' ||
      char === '\r' ||
      char === '\f' ||
      char === '\v' ||
      char === '﻿' ||
      char === ' ' ||
      char === ' ' ||
      char === ' '
    ) {
      index++
    } else if (char === '/' && source[index + 1] === '/') {
      const newline = source.indexOf('\n', index + 2)
      index = newline === -1 ? limit : newline + 1
    } else if (char === '/' && source[index + 1] === '*') {
      const close = source.indexOf('*/', index + 2)
      index = close === -1 ? limit : close + 2
    } else {
      break
    }
  }
  return index
}

function isQuote(char: string | undefined): char is '"' | "'" {
  return char === '"' || char === "'"
}
