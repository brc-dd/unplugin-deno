import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Hosts an integration test can build a fixture with. */
export type HostName =
  | 'vite'
  | 'rolldown'
  | 'rollup'
  | 'esbuild'
  | 'webpack'
  | 'rspack'
  | 'rsbuild'
  | 'bun'
  | 'farm'

const HOST_NAMES: ReadonlySet<string> = new Set<HostName>([
  'vite',
  'rolldown',
  'rollup',
  'esbuild',
  'webpack',
  'rspack',
  'rsbuild',
  'bun',
  'farm',
])

/**
 * The `fixture.json` of a fixture: what it exercises, so tests can iterate fixtures generically
 * and readers know the purpose without reading the code.
 */
export interface FixtureManifest {
  /** One line describing the scenario. */
  title: string
  /** Entry modules, relative to the fixture root. */
  entries: string[]
  /** Hosts whose integration tests build this fixture; `[]` for fixtures used by other tests. */
  hosts: HostName[]
  /** Scenario-specific expectations the tests assert (resolved URLs, exported values, …). */
  expect?: Record<string, unknown>
  /** Upstream issues the fixture reproduces, e.g. `denoland/deno-vite-plugin#98`. */
  issues?: string[]
  /** Provenance and license note when the fixture is adapted from another project. */
  source?: string
}

/** A fixture on disk. */
export interface Fixture {
  name: string
  /** Absolute path of `test/fixtures/<name>`. */
  dir: string
  manifest: FixtureManifest
}

/** Absolute path of `test/fixtures`. */
export const fixturesDir: string = fileURLToPath(new URL('../fixtures/', import.meta.url))

/** Reads and validates `<root>/<name>/fixture.json` (`root` defaults to `test/fixtures`). */
export async function loadFixture(name: string, root: string = fixturesDir): Promise<Fixture> {
  const dir = join(root, name)
  const file = join(dir, 'fixture.json')
  const raw: unknown = JSON.parse(await readFile(file, 'utf8'))
  return { name, dir, manifest: validateManifest(raw, file) }
}

function validateManifest(raw: unknown, file: string): FixtureManifest {
  const fail = (message: string): never => {
    throw new Error(`${file}: ${message}`)
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return fail('expected an object')
  const value = raw as Record<string, unknown>
  if (typeof value.title !== 'string' || value.title === '')
    fail('"title" must be a non-empty string')
  if (!isStringArray(value.entries) || value.entries.length === 0) {
    fail('"entries" must be a non-empty array of paths')
  }
  if (!isStringArray(value.hosts) || !value.hosts.every((host) => HOST_NAMES.has(host))) {
    fail(`"hosts" must be an array of ${[...HOST_NAMES].join(', ')}`)
  }
  const expectValue = value.expect
  if (
    expectValue !== undefined &&
    (typeof expectValue !== 'object' || expectValue === null || Array.isArray(expectValue))
  ) {
    fail('"expect" must be an object')
  }
  if (value.issues !== undefined && !isStringArray(value.issues)) fail('"issues" must be strings')
  if (value.source !== undefined && typeof value.source !== 'string')
    fail('"source" must be a string')
  return value as unknown as FixtureManifest
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}
