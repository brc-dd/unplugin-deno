import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Absolute path of `test/data`. */
export const testDataDir: string = fileURLToPath(new URL('../data/', import.meta.url))

/**
 * One leaf of a data-driven import-map test object (the web-platform-tests format, see
 * `test/data/wpt-import-maps/SOURCE.md`), with the fields inherited from its ancestors.
 */
export interface ImportMapCase {
  /** File name the case comes from. */
  file: string
  /** Names from the root to the leaf, joined with `: ` (like the WPT harness). */
  name: string
  /** An object, or JSON text (a string) that must be parsed first. */
  importMap: unknown
  importMapBaseURL: string
  /** Deno's `expand_imports` option (only in `test/data/deno-import-map`). */
  expandImports: boolean
  /** Resolution cases: specifier → expected URL (`null` = resolution fails). */
  expectedResults?: Record<string, string | null>
  /** Parsing cases: the normalised map (`null` = parsing fails). */
  expectedParsedImportMap?: unknown
  /** Referrer URL for resolution cases. */
  baseURL?: string
}

const INHERITED = [
  'importMap',
  'importMapBaseURL',
  'baseURL',
  'expandImports',
  'expectedParsedImportMap',
] as const

/**
 * Flattens a data-driven test object: children (`tests`) inherit every field of their parent and
 * get the name `<parent name>: <child key>`; leaves have `expectedResults` or
 * `expectedParsedImportMap`.
 */
export function flattenImportMapCases(file: string, root: unknown): ImportMapCase[] {
  const cases: ImportMapCase[] = []
  const visit = (
    node: Record<string, unknown>,
    inherited: Record<string, unknown>,
    name: string,
  ): void => {
    const fields: Record<string, unknown> = { ...inherited }
    for (const key of INHERITED) if (Object.hasOwn(node, key)) fields[key] = node[key]
    const tests = node.tests
    if (typeof tests === 'object' && tests !== null) {
      for (const [childName, child] of Object.entries(tests)) {
        if (typeof child !== 'object' || child === null) continue
        visit(
          child as Record<string, unknown>,
          fields,
          name === '' ? childName : `${name}: ${childName}`,
        )
      }
      return
    }
    const importMapBaseURL = fields.importMapBaseURL
    if (typeof importMapBaseURL !== 'string')
      throw new Error(`${file}: ${name}: no importMapBaseURL`)
    const leaf: ImportMapCase = {
      file,
      name,
      importMap: fields.importMap,
      importMapBaseURL,
      expandImports: fields.expandImports === true,
    }
    if (typeof fields.baseURL === 'string') leaf.baseURL = fields.baseURL
    if (typeof node.expectedResults === 'object' && node.expectedResults !== null) {
      leaf.expectedResults = node.expectedResults as Record<string, string | null>
    } else if (Object.hasOwn(fields, 'expectedParsedImportMap')) {
      leaf.expectedParsedImportMap = fields.expectedParsedImportMap
    } else {
      throw new Error(`${file}: ${name}: no expectations`)
    }
    cases.push(leaf)
  }
  if (typeof root !== 'object' || root === null) throw new Error(`${file}: expected an object`)
  const rootNode = root as Record<string, unknown>
  visit(rootNode, {}, typeof rootNode.name === 'string' ? rootNode.name : '')
  return cases
}

/** Reads every `*.json` file of `test/data/<dir>` and flattens its cases, in file-name order. */
export function loadImportMapCases(dir: string): ImportMapCase[] {
  const directory = new URL(`../data/${dir}/`, import.meta.url)
  return readdirSync(directory)
    .filter((file) => file.endsWith('.json'))
    .toSorted()
    .flatMap((file) =>
      flattenImportMapCases(file, JSON.parse(readFileSync(new URL(file, directory), 'utf8'))),
    )
}
