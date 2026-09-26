/**
 * Copies the `version` of `package.json` into `deno.json` (the JSR manifest): changesets bumps
 * only `package.json`. The root `version-packages` script runs it after `changeset version`.
 *
 * Usage (from `packages/unplugin-deno/`, Node >= 22.18 for type stripping):
 *
 *     node scripts/sync-version.ts           # write the version into deno.json
 *     node scripts/sync-version.ts --check   # only compare; exit code 1 when they differ
 *
 * Only the `"version"` value is replaced, so the formatting of deno.json stays as it is.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const packageJsonPath = join(packageDir, 'package.json')
const denoJsonPath = join(packageDir, 'deno.json')
/** The top-level `"version": "…"` member; deno.json has no other `version` key. */
const VERSION_MEMBER = /^(\s*"version"\s*:\s*)"([^"\n]*)"/gm

function main(): void {
  const check = process.argv.includes('--check')
  const manifest: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  const version =
    typeof manifest === 'object' && manifest !== null && 'version' in manifest
      ? manifest.version
      : undefined
  if (typeof version !== 'string' || version === '') {
    throw new Error(`${packageJsonPath}: no "version" string.`)
  }

  const denoJson = readFileSync(denoJsonPath, 'utf8')
  const members = [...denoJson.matchAll(VERSION_MEMBER)]
  if (members.length !== 1) {
    throw new Error(`${denoJsonPath}: expected one "version" member, found ${members.length}.`)
  }
  const denoVersion = members[0]?.[2]

  if (denoVersion === version) {
    console.log(`deno.json and package.json are both at version ${version}.`)
    return
  }
  if (check) {
    console.error(
      `deno.json has version ${denoVersion} but package.json has ${version}; ` +
        'run `pnpm sync-version` (the root `version-packages` script does it after `changeset version`).',
    )
    process.exitCode = 1
    return
  }
  writeFileSync(
    denoJsonPath,
    denoJson.replace(VERSION_MEMBER, (_member, prefix: string) => `${prefix}"${version}"`),
  )
  console.log(`deno.json: version ${denoVersion} -> ${version}`)
}

main()
