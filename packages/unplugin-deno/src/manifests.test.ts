/**
 * The npm and JSR manifests describe the same package: `deno.json` mirrors `package.json` (version,
 * exports, dependency ranges), and the package's README.md and LICENSE are copies of the repository
 * root files (docs/contributing.md, "Release"). changesets bumps only package.json; the root
 * `version-packages` script copies the version with `scripts/sync-version.ts`.
 */
import { readFileSync } from 'node:fs'
import { parse } from 'jsonc-parser'
import { describe, expect, it } from 'vitest'

interface PackageJson {
  version: string
  exports: Record<string, string>
  dependencies: Record<string, string>
}

interface DenoJson {
  version: string
  exports: Record<string, string>
  imports: Record<string, string>
}

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

const packageJson = JSON.parse(read('../package.json')) as PackageJson
const denoJson = parse(read('../deno.json')) as DenoJson

describe('package manifests', () => {
  it('deno.json has the version of package.json', () => {
    expect(denoJson.version).toBe(packageJson.version)
  })

  it('deno.json exports the files package.json exports, in the same order', () => {
    const javascript = Object.entries(packageJson.exports).filter(
      ([subpath]) => subpath !== './package.json',
    )
    // Plain targets: TypeScript finds dist/<name>.d.ts next to each file, Deno and JSR through
    // the file's @ts-self-types comment.
    for (const [, target] of javascript) expect(target).toMatch(/^\.\/dist\/[\w-]+\.js$/)
    expect(Object.entries(denoJson.exports)).toEqual(javascript)
  })

  it('deno.json maps each dependency to npm: with the range of package.json', () => {
    const imports = Object.entries(packageJson.dependencies).map(([name, range]) => [
      name,
      `npm:${name}@${range}`,
    ])
    expect(denoJson.imports).toEqual(Object.fromEntries(imports))
  })

  it('README.md and LICENSE are copies of the repository root files', () => {
    expect(read('../README.md')).toBe(read('../../../README.md'))
    expect(read('../LICENSE')).toBe(read('../../../LICENSE'))
  })
})
