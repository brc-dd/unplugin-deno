import { describe, expect, it } from 'vitest'
import { loadImportMapCases } from '../../test/helpers/import-map-data.js'
import type { ImportMapCase } from '../../test/helpers/import-map-data.js'
import { DenoPluginError } from '../diagnostics/errors.js'
import { parseJson } from '../utils/fs.js'
import { parseImportMap, resolveImportMap, serializeImportMap } from './import-map.js'
import type { ParsedImportMap } from './import-map.js'

// The web-platform-tests import-map data (test/data/wpt-import-maps, 3-clause BSD) and cases
// adapted from denoland/import_map's tests (test/data/deno-import-map, MIT); see the SOURCE.md
// files. Every case runs: the one test about import map *text* (`parsing-invalid-json.json`)
// parses the text with the strict JSON parser used for external import map files.

/**
 * Cases that are not run, keyed by `<file>: <name>[: <specifier>]`, with the reason. HTML-only
 * behaviour (`<script type=importmap>` registration errors) would go here; none of the current
 * data needs it.
 */
const SKIPPED: Readonly<Record<string, string>> = {}

function parse(testCase: ImportMapCase): ParsedImportMap {
  const value =
    typeof testCase.importMap === 'string'
      ? parseJson(testCase.importMap, 'importmap', 'IMPORT_MAP_INVALID')
      : testCase.importMap
  return parseImportMap(value, testCase.importMapBaseURL, { expand: testCase.expandImports })
}

type Resolution = [
  name: string,
  testCase: ImportMapCase,
  specifier: string,
  expected: string | null,
]
type Parsing = [name: string, testCase: ImportMapCase, expected: unknown]

interface Split {
  resolves: Resolution[]
  fails: Resolution[]
  parses: Parsing[]
  rejects: Parsing[]
}

/** Splits cases by expectation so that no test needs a conditional. */
function split(cases: ImportMapCase[]): Split {
  const result: Split = { resolves: [], fails: [], parses: [], rejects: [] }
  for (const testCase of cases) {
    const id = `${testCase.file}: ${testCase.name}`
    if (SKIPPED[id] !== undefined) continue
    for (const [specifier, expected] of Object.entries(testCase.expectedResults ?? {})) {
      if (SKIPPED[`${id}: ${specifier}`] !== undefined) continue
      const row: Resolution = [`${testCase.name}: ${specifier}`, testCase, specifier, expected]
      ;(expected === null ? result.fails : result.resolves).push(row)
    }
    if (testCase.expectedResults === undefined) {
      const expected = testCase.expectedParsedImportMap
      ;(expected === null ? result.rejects : result.parses).push([
        testCase.name,
        testCase,
        expected,
      ])
    }
  }
  return result
}

function referrer(testCase: ImportMapCase): string {
  return testCase.baseURL ?? testCase.importMapBaseURL
}

function register(cases: ImportMapCase[]): void {
  const { resolves, fails, parses, rejects } = split(cases)
  it.each(resolves)('%s', (_name, testCase, specifier, expected) => {
    expect(resolveImportMap(parse(testCase), specifier, referrer(testCase)).url).toBe(expected)
  })
  it.each(fails)('%s (fails)', (_name, testCase, specifier) => {
    const map = parse(testCase)
    expect(() => resolveImportMap(map, specifier, referrer(testCase))).toThrow(DenoPluginError)
  })
  it.each(parses)('%s', (_name, testCase, expected) => {
    expect(serializeImportMap(parse(testCase))).toEqual(expected)
  })
  it.each(rejects)('%s (rejected)', (_name, testCase) => {
    expect(() => parse(testCase)).toThrow(DenoPluginError)
  })
}

const wptCases = loadImportMapCases('wpt-import-maps')
const wptFiles = [...new Set(wptCases.map((testCase) => testCase.file))]

describe('WPT import-maps data-driven tests', () => {
  it('loads every data file and skips nothing', () => {
    expect(wptFiles).toHaveLength(22)
    expect(Object.keys(SKIPPED)).toEqual([])
  })

  describe.each(wptFiles)('%s', (file) => {
    register(wptCases.filter((testCase) => testCase.file === file))
  })
})

describe('denoland/import_map cases', () => {
  register(loadImportMapCases('deno-import-map'))
})
