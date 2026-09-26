/**
 * Source transforms and checks of the modules a host bundles (docs/architecture.md §5.10):
 *
 * - `import.meta.main` becomes `false` outside entry modules (L7): bundled into an entry chunk, a
 *   module would otherwise see the entry's `import.meta.main`;
 * - environment variables read with a literal key (`Deno.env.get("PUBLIC_X")`,
 *   `process.env.PUBLIC_X`, `process.env["PUBLIC_X"]`) are inlined as JSON literals (L9);
 * - `Deno.*` references are collected so browser builds can report them (L10).
 *
 * One scan finds all three: from the host's AST when it parses the module (Rolldown and Vite 8
 * parse TypeScript and JSX with oxc; Rollup's `this.parse` reads JavaScript only), otherwise from
 * the token-aware scanner of `utils/js-tokens.ts`, which skips strings, comments, template text and
 * regular expressions. The scanner cannot tell TypeScript types from values, so it only counts
 * `Deno.<member>` as a runtime reference when the member starts in lower case (`Deno.cwd`,
 * `Deno.env`), follows `new`, or is itself called or accessed (`Deno.Command(`, `Deno.X.y`): types
 * such as `Deno.Kv` are PascalCase.
 *
 * @module
 */
import type { MagicString } from 'magic-string'
import type { Token } from '../utils/js-tokens.js'
import { tokenize } from '../utils/js-tokens.js'
import type { AstParser } from './attributes.js'
import { langForId } from './attributes.js'

/** A range of the source. */
export interface SourceRange {
  start: number
  end: number
}

/** An environment variable read with a literal key. */
export interface EnvRead extends SourceRange {
  key: string
  api: 'Deno.env.get' | 'process.env'
}

/** A `Deno.<member>` reference. */
export interface DenoReference extends SourceRange {
  member: string
}

/** What {@link scanSource} found. */
export interface SourceScan {
  importMetaMain: SourceRange[]
  envReads: EnvRead[]
  denoReferences: DenoReference[]
  /** Which scanner produced the result. */
  scanner: 'ast' | 'tokens'
}

/** Code that may contain something {@link scanSource} finds (a cheap pre-check). */
export const SOURCE_SCAN_HINT = /import\.meta|Deno\.|process\.env/

/**
 * Scans a module: with the host's parser when given and able to parse it (`lang` from the id's
 * extension), else with the token scanner.
 */
export function scanSource(code: string, id: string, parse?: AstParser): SourceScan {
  if (parse !== undefined) {
    let ast: unknown
    try {
      ast = parse(code, langForId(id))
    } catch {
      ast = undefined
    }
    if (isNode(ast)) return scanAst(ast)
  }
  return scanTokens(code)
}

// ---------------------------------------------------------------------------------------------
// Tokens

/** The token scanner (see the module documentation). */
export function scanTokens(code: string): SourceScan {
  const tokens = tokenize(code)
  const result: SourceScan = {
    importMetaMain: [],
    envReads: [],
    denoReferences: [],
    scanner: 'tokens',
  }
  const at = (index: number): Token | undefined => tokens[index]
  const is = (index: number, type: Token['type'], value?: string): boolean => {
    const token = tokens[index]
    return (
      token !== undefined && token.type === type && (value === undefined || token.value === value)
    )
  }
  const isDot = (index: number): boolean => is(index, 'punct', '.') || is(index, 'punct', '?.')
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] as Token
    if (token.type !== 'name' || isDot(index - 1)) continue
    if (token.value === 'import') {
      if (is(index + 1, 'punct', '.') && is(index + 2, 'name', 'meta') && isDot(index + 3)) {
        if (is(index + 4, 'name', 'main') && !isAssignmentTarget(tokens, index, index + 4)) {
          result.importMetaMain.push({ start: token.start, end: (at(index + 4) as Token).end })
        }
      }
      continue
    }
    if (token.value === 'process') {
      if (!isDot(index + 1) || !is(index + 2, 'name', 'env')) continue
      let key: string | undefined
      let last = -1
      if (isDot(index + 3) && is(index + 4, 'name')) {
        key = (at(index + 4) as Token).value
        last = index + 4
      } else if (
        is(index + 3, 'punct', '[') &&
        is(index + 4, 'string') &&
        is(index + 5, 'punct', ']')
      ) {
        key = (at(index + 4) as Token).value
        last = index + 5
      }
      if (key !== undefined && !isAssignmentTarget(tokens, index, last)) {
        const end = (at(last) as Token).end
        result.envReads.push({ start: token.start, end, key, api: 'process.env' })
      }
      continue
    }
    if (token.value !== 'Deno' || !isDot(index + 1) || !is(index + 2, 'name')) continue
    const member = (at(index + 2) as Token).value
    if (
      member === 'env' &&
      isDot(index + 3) &&
      is(index + 4, 'name', 'get') &&
      is(index + 5, 'punct', '(') &&
      is(index + 6, 'string') &&
      is(index + 7, 'punct', ')')
    ) {
      const key = (at(index + 6) as Token).value
      result.envReads.push({
        start: token.start,
        end: (at(index + 7) as Token).end,
        key,
        api: 'Deno.env.get',
      })
    }
    const runtime =
      /^[a-z_$]/.test(member) ||
      is(index - 1, 'name', 'new') ||
      isDot(index + 3) ||
      is(index + 3, 'punct', '(')
    if (runtime) {
      result.denoReferences.push({ start: token.start, end: (at(index + 2) as Token).end, member })
    }
  }
  return result
}

/** Assignment operators: a member expression followed by one of them is written, not read. */
const ASSIGNMENTS: ReadonlySet<string> = new Set([
  '=',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '**=',
  '<<=',
  '>>=',
  '>>>=',
  '&=',
  '|=',
  '^=',
  '&&=',
  '||=',
  '??=',
  '++',
  '--',
])

/** Whether the tokens `first..last` are written (`x = …`, `x++`, `++x`, `delete x`). */
function isAssignmentTarget(tokens: readonly Token[], first: number, last: number): boolean {
  const before = tokens[first - 1]
  const after = tokens[last + 1]
  if (after?.type === 'punct' && ASSIGNMENTS.has(after.value)) return true
  if (before?.type === 'punct' && (before.value === '++' || before.value === '--')) return true
  return before?.type === 'name' && before.value === 'delete'
}

// ---------------------------------------------------------------------------------------------
// AST (ESTree, as produced by oxc and Rollup)

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

/** The AST scanner: walks an ESTree `Program` (UTF-16 offsets) once. */
export function scanAst(ast: unknown): SourceScan {
  const result: SourceScan = {
    importMetaMain: [],
    envReads: [],
    denoReferences: [],
    scanner: 'ast',
  }
  const stack: Array<[unknown, Node | undefined]> = [[ast, undefined]]
  while (stack.length > 0) {
    const [value, parent] = stack.pop() as [unknown, Node | undefined]
    if (Array.isArray(value)) {
      for (const item of value) stack.push([item, parent])
      continue
    }
    if (!isNode(value)) {
      if (typeof value === 'object' && value !== null) {
        for (const [key, child] of Object.entries(value)) {
          if (key !== 'parent' && typeof child === 'object' && child !== null) {
            stack.push([child, parent])
          }
        }
      }
      continue
    }
    visitNode(value, parent, result)
    for (const [key, child] of Object.entries(value)) {
      if (key !== 'parent' && typeof child === 'object' && child !== null) {
        stack.push([child, value])
      }
    }
  }
  result.importMetaMain.sort(byStart)
  result.envReads.sort(byStart)
  result.denoReferences.sort(byStart)
  return result
}

function byStart(a: SourceRange, b: SourceRange): number {
  return a.start - b.start
}

function visitNode(node: Node, parent: Node | undefined, result: SourceScan): void {
  if (node.type === 'CallExpression') {
    const key = denoEnvGetKey(node)
    if (key !== undefined) {
      result.envReads.push({ start: node.start, end: node.end, key, api: 'Deno.env.get' })
    }
    return
  }
  if (node.type !== 'MemberExpression') return
  const object = node.object
  const property = memberName(node)
  if (!isNode(object) || property === undefined) return
  if (isImportMeta(object)) {
    if (property === 'main' && !isWritten(node, parent)) {
      result.importMetaMain.push({ start: node.start, end: node.end })
    }
    return
  }
  if (isIdentifier(object, 'Deno')) {
    result.denoReferences.push({ start: node.start, end: node.end, member: property })
    return
  }
  if (
    object.type === 'MemberExpression' &&
    memberName(object) === 'env' &&
    isIdentifier(object.object, 'process') &&
    !isWritten(node, parent)
  ) {
    result.envReads.push({ start: node.start, end: node.end, key: property, api: 'process.env' })
  }
}

/** The key of `Deno.env.get("<key>")`, else `undefined`. */
function denoEnvGetKey(call: Node): string | undefined {
  const callee = call.callee
  const args = call.arguments
  if (!isNode(callee) || callee.type !== 'MemberExpression' || memberName(callee) !== 'get') {
    return undefined
  }
  const env = callee.object
  if (!isNode(env) || env.type !== 'MemberExpression' || memberName(env) !== 'env') return undefined
  if (!isIdentifier(env.object, 'Deno')) return undefined
  if (!Array.isArray(args) || args.length !== 1) return undefined
  const [arg] = args as unknown[]
  return isNode(arg) && arg.type === 'Literal' && typeof arg.value === 'string'
    ? arg.value
    : undefined
}

/** The property name of a member expression (`a.b`, `a["b"]`), else `undefined`. */
function memberName(member: Node): string | undefined {
  const property = member.property
  if (!isNode(property)) return undefined
  if (member.computed === true) {
    return property.type === 'Literal' && typeof property.value === 'string'
      ? property.value
      : undefined
  }
  return property.type === 'Identifier' && typeof property.name === 'string'
    ? property.name
    : undefined
}

function isIdentifier(node: unknown, name: string): boolean {
  return isNode(node) && node.type === 'Identifier' && node.name === name
}

function isImportMeta(node: Node): boolean {
  return (
    node.type === 'MetaProperty' &&
    isIdentifier(node.meta, 'import') &&
    isIdentifier(node.property, 'meta')
  )
}

/** Whether `node` is written by its parent (assignment, update, `delete`). */
function isWritten(node: Node, parent: Node | undefined): boolean {
  if (parent === undefined) return false
  if (parent.type === 'AssignmentExpression') return parent.left === node
  if (parent.type === 'UpdateExpression') return true
  return parent.type === 'UnaryExpression' && parent.operator === 'delete'
}

// ---------------------------------------------------------------------------------------------
// Applying

/** What {@link applySourceTransforms} does. */
export interface SourceTransformOptions {
  /** Replace `import.meta.main` with `false` (non-entry modules). */
  importMetaMain: boolean
  /**
   * The inlined value of an environment variable: a string, `undefined` for an allowed variable
   * that is not set, or `null` to leave the read alone. Absent: no inlining.
   */
  envValue?: ((key: string) => string | undefined | null) | undefined
}

/** The result of {@link applySourceTransforms}. */
export interface AppliedSourceTransforms {
  /** Whether `magic` changed. */
  changed: boolean
  /** The `Deno.*` references left in the code (inlined env reads removed). */
  denoReferences: DenoReference[]
}

/** Applies the replacements of `scan` to `magic` (see {@link SourceTransformOptions}). */
export function applySourceTransforms(
  magic: MagicString,
  scan: SourceScan,
  options: SourceTransformOptions,
): AppliedSourceTransforms {
  let changed = false
  const replaced: SourceRange[] = []
  if (options.importMetaMain) {
    for (const range of scan.importMetaMain) {
      magic.overwrite(range.start, range.end, 'false')
      changed = true
    }
  }
  const envValue = options.envValue
  if (envValue !== undefined) {
    for (const read of scan.envReads) {
      const value = envValue(read.key)
      if (value === null) continue
      magic.overwrite(
        read.start,
        read.end,
        value === undefined ? 'undefined' : JSON.stringify(value),
      )
      replaced.push(read)
      changed = true
    }
  }
  const denoReferences = scan.denoReferences.filter(
    (reference) =>
      !replaced.some((range) => reference.start >= range.start && reference.end <= range.end),
  )
  return { changed, denoReferences }
}
