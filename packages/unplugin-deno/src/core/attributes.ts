/**
 * Import attributes as id markers (docs/architecture.md §5.5): `with { type: "text" | "bytes" |
 * "css" }` becomes `<specifier>?deno-type=<type>` and the clause is dropped, so hosts that do not
 * expose attributes to `resolveId` (Rolldown, Vite) still see the type; `json` is left to the host.
 * `load` then synthesises the marker module from the target's bytes.
 *
 * @module
 */
import { Buffer } from 'node:buffer'
import { MagicString } from 'magic-string'
import { DenoPluginError } from '../diagnostics/errors.js'
import type { EncodedSourceMap } from '../engine/types.js'
import type { ScannedImport } from '../utils/lexer.js'
import { LexerError, scanModule } from '../utils/lexer.js'
import type { DenoType } from './id.js'
import { splitQuery, withDenoType } from './id.js'

/** Languages an {@link AstParser} is asked to parse. */
export type AstLang = 'js' | 'jsx' | 'ts' | 'tsx'

/**
 * Parses a module into an ESTree `Program` with UTF-16 `start`/`end` offsets (Rolldown and Vite
 * `this.parse`, oxc). Used when the lexer cannot read the code (JSX).
 */
export type AstParser = (code: string, lang: AstLang) => unknown

/** The result of {@link transformImportAttributes}. */
export interface AttributeTransform {
  code: string
  map: EncodedSourceMap
}

/** A synthesised marker module; `moduleType` is for hosts that take one (Rolldown). */
export interface MarkerModule {
  code: string
  moduleType: 'js'
}

const DENO_TYPES: ReadonlySet<string> = new Set<DenoType>(['text', 'bytes', 'css'])

/** Byte arrays up to this size are emitted as a literal; larger ones as base64 decoded at runtime. */
export const BYTES_INLINE_LIMIT = 1024

/** Whether `value` is an attribute type the plugin encodes as a marker (`text`, `bytes`, `css`). */
export function isDenoType(value: unknown): value is DenoType {
  return typeof value === 'string' && DENO_TYPES.has(value)
}

/**
 * The parser language for a module id, from its extension or the `lang.<ext>` query of a
 * framework's script block (JavaScript files may contain JSX).
 */
export function langForId(id: string): AstLang {
  const { base, query } = splitQuery(id)
  const extension = (
    /\.([cm]?[jt]sx?)$/i.exec(base)?.[1] ?? /[?&]lang\.([cm]?[jt]sx?)(?:[&#]|$)/i.exec(query)?.[1]
  )?.toLowerCase()
  switch (extension) {
    case 'tsx':
      return 'tsx'
    case 'ts':
    case 'mts':
    case 'cts':
      return 'ts'
    default:
      return 'jsx'
  }
}

/**
 * The imports of a module with their attributes: from the lexer, or from `parse` when the lexer
 * cannot read the code (JSX). Returns `null` when neither can.
 */
export function scanImports(code: string, id: string, parse?: AstParser): ScannedImport[] | null {
  try {
    return scanModule(code).imports
  } catch (error) {
    if (!(error instanceof LexerError) || parse === undefined) return null
  }
  let ast: unknown
  try {
    ast = parse(code, langForId(id))
  } catch {
    return null
  }
  return importsFromAst(code, ast)
}

/**
 * The transform pre-pass for hosts without attributes in `resolveId` (§5.5): rewrites static
 * (`import`/`export … from`) and dynamic (`import(x, { with: { type } })`) imports whose `type` is
 * `text`, `bytes` or `css` to `x?deno-type=<type>` and removes the clause. `json` and every other
 * attribute are left untouched, as are type-only imports, template-literal and non-literal
 * dynamic imports. Returns `null` when nothing changes; only scans code that contains `with`.
 */
export function transformImportAttributes(
  code: string,
  id: string,
  parse?: AstParser,
): AttributeTransform | null {
  const magic = new MagicString(code)
  if (!applyImportAttributes(magic, code, id, parse)) return null
  const map = magic.generateMap({ source: id, hires: 'boundary', includeContent: true })
  return { code: magic.toString(), map: { ...map, version: 3 } as EncodedSourceMap }
}

/**
 * {@link transformImportAttributes} on a `MagicString` of `code` that other transforms edit too
 * (their ranges never overlap import specifiers). Returns whether it changed anything.
 */
export function applyImportAttributes(
  magic: MagicString,
  code: string,
  id: string,
  parse?: AstParser,
): boolean {
  if (!code.includes('with')) return false
  const imports = scanImports(code, id, parse)
  if (imports === null) return false
  let changed = false
  for (const entry of imports) {
    const type = entry.attributes?.type
    if (entry.specifier === undefined || entry.typeOnly || entry.template) continue
    if (!isDenoType(type) || entry.clause === null) continue
    magic.overwrite(entry.start, entry.end, JSON.stringify(withDenoType(entry.specifier, type)))
    if (entry.clause.end > entry.clause.start) magic.remove(entry.clause.start, entry.clause.end)
    changed = true
  }
  return changed
}

/**
 * The module for a marker id (§5.5): `text` → the UTF-8 text as a string, `bytes` → a
 * `Uint8Array` (a literal up to {@link BYTES_INLINE_LIMIT} bytes, base64 decoded at runtime
 * above), `css` → a constructed `CSSStyleSheet` (as Deno 2.9 does).
 *
 * @throws {DenoPluginError} `UNSUPPORTED_MEDIA_TYPE` when a `text`/`css` target is not valid UTF-8.
 */
export function synthesizeMarkerModule(
  denoType: DenoType,
  bytes: Uint8Array,
  sourceUrl: string,
): MarkerModule {
  switch (denoType) {
    case 'text':
      return {
        code: `export default ${JSON.stringify(decodeText(bytes, sourceUrl))};\n`,
        moduleType: 'js',
      }
    case 'bytes':
      return { code: bytesModule(bytes), moduleType: 'js' }
    case 'css':
      return {
        code:
          `const sheet = new CSSStyleSheet();\n` +
          `sheet.replaceSync(${JSON.stringify(decodeText(bytes, sourceUrl))});\n` +
          `export default sheet;\n`,
        moduleType: 'js',
      }
  }
}

function decodeText(bytes: Uint8Array, sourceUrl: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new DenoPluginError('UNSUPPORTED_MEDIA_TYPE', `${sourceUrl} is not valid UTF-8 text.`, {
      hint: 'Import binary files with `with { type: "bytes" }`.',
      specifier: sourceUrl,
      cause: error,
    })
  }
}

function bytesModule(bytes: Uint8Array): string {
  if (bytes.length <= BYTES_INLINE_LIMIT) {
    return `export default new Uint8Array([${bytes.join(',')}]);\n`
  }
  const base64 = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
  return (
    `const data = atob(${JSON.stringify(base64)});\n` +
    `const bytes = new Uint8Array(data.length);\n` +
    `for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i);\n` +
    `export default bytes;\n`
  )
}

// ---------------------------------------------------------------------------------------------
// ESTree fallback (JSX and TSX, which the lexer does not read)

interface Node {
  type: string
  start: number
  end: number
  [key: string]: unknown
}

function isNode(value: unknown): value is Node {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string' &&
    typeof (value as { start?: unknown }).start === 'number' &&
    typeof (value as { end?: unknown }).end === 'number'
  )
}

/**
 * The imports of an ESTree `Program` in the shape {@link scanModule} returns them: import and
 * re-export declarations and `import()` expressions whose source is a string literal. Walks the
 * whole tree (dynamic imports can be anywhere); offsets must be UTF-16 (oxc's ESTree output).
 */
export function importsFromAst(code: string, ast: unknown): ScannedImport[] {
  const imports: ScannedImport[] = []
  const stack: unknown[] = [ast]
  while (stack.length > 0) {
    const value = stack.pop()
    if (Array.isArray(value)) {
      for (const item of value) stack.push(item)
      continue
    }
    if (typeof value !== 'object' || value === null) continue
    if (isNode(value)) {
      const found =
        value.type === 'ImportExpression' ? dynamicFromAst(code, value) : staticFromAst(code, value)
      if (found !== undefined) imports.push(found)
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== 'parent' && typeof child === 'object' && child !== null) stack.push(child)
    }
  }
  return imports.toSorted((a, b) => a.start - b.start)
}

const DECLARATIONS: ReadonlySet<string> = new Set([
  'ImportDeclaration',
  'ExportNamedDeclaration',
  'ExportAllDeclaration',
])

function staticFromAst(code: string, node: Node): ScannedImport | undefined {
  if (!DECLARATIONS.has(node.type)) return undefined
  const source = node.source
  if (!isNode(source) || typeof source.value !== 'string') return undefined
  const attributes = Array.isArray(node.attributes) ? node.attributes : []
  const typeOnly = node.importKind === 'type' || node.exportKind === 'type'
  let statementEnd = node.end
  while (statementEnd > source.end && /[\s;]/.test(code[statementEnd - 1] ?? '')) statementEnd--
  const hasClause = attributes.length > 0 && code[statementEnd - 1] === '}'
  return {
    specifier: source.value,
    start: source.start,
    end: source.end,
    dynamic: false,
    template: false,
    typeOnly,
    attributesStart: hasClause ? code.indexOf('{', source.end) : -1,
    statementEnd: hasClause ? statementEnd : source.end,
    attributes: hasClause ? attributeType(attributes) : null,
    clause: hasClause ? { start: source.end, end: statementEnd } : null,
  }
}

function dynamicFromAst(code: string, node: Node): ScannedImport | undefined {
  const source = node.source
  if (!isNode(source)) return undefined
  const literal = source.type === 'Literal' && typeof source.value === 'string'
  const options = node.options
  const closes = code[node.end - 1] === ')'
  const withClause = isNode(options) && closes
  return {
    specifier: literal ? (source.value as string) : undefined,
    start: source.start,
    end: source.end,
    dynamic: true,
    template: source.type === 'TemplateLiteral',
    typeOnly: false,
    attributesStart: withClause ? options.start : -1,
    statementEnd: node.end,
    attributes: withClause ? optionsType(options) : null,
    clause: withClause ? { start: source.end, end: node.end - 1 } : null,
  }
}

function attributeType(attributes: unknown[]): { type?: string } {
  for (const attribute of attributes) {
    if (!isNode(attribute)) continue
    if (keyName(attribute.key) === 'type' && isNode(attribute.value)) {
      const value = attribute.value.value
      if (typeof value === 'string') return { type: value }
    }
  }
  return {}
}

function optionsType(options: Node): { type?: string } | null {
  if (options.type !== 'ObjectExpression' || !Array.isArray(options.properties)) return null
  for (const property of options.properties) {
    if (!isNode(property) || property.type !== 'Property') continue
    const key = keyName(property.key)
    if ((key === 'with' || key === 'assert') && isNode(property.value)) {
      const inner = property.value
      if (inner.type !== 'ObjectExpression' || !Array.isArray(inner.properties)) return null
      for (const entry of inner.properties) {
        if (!isNode(entry) || entry.type !== 'Property' || keyName(entry.key) !== 'type') continue
        const value = isNode(entry.value) ? entry.value.value : undefined
        return typeof value === 'string' ? { type: value } : null
      }
      return {}
    }
  }
  return {}
}

function keyName(key: unknown): string | undefined {
  if (!isNode(key)) return undefined
  if (key.type === 'Identifier' && typeof key.name === 'string') return key.name
  return typeof key.value === 'string' ? key.value : undefined
}
