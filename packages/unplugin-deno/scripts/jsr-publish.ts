/**
 * Publishes the package to JSR with `deno publish` (build `dist/` first) unless JSR already has
 * this version. The root `release` script runs it after `changeset publish`.
 *
 * Usage (from `packages/unplugin-deno/`, Node >= 22.18 for type stripping):
 *
 *     node scripts/jsr-publish.ts [deno publish flags]
 *
 * JSR publishing is switched on by creating the package on jsr.io and, for GitHub Actions (where
 * `deno publish` authenticates with OIDC), linking it to the GitHub repository; see
 * docs/contributing.md#release. Until then this prints a notice and succeeds, so npm releases do
 * not wait for JSR. `deno publish` itself also skips versions JSR already has.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const JSR_API = 'https://api.jsr.io'
const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..')

async function main(): Promise<void> {
  const { name, version } = JSON.parse(readFileSync(join(packageDir, 'deno.json'), 'utf8')) as {
    name?: unknown
    version?: unknown
  }
  const [, scope, packageName] =
    typeof name === 'string' ? (/^@([^/]+)\/(.+)$/.exec(name) ?? []) : []
  if (scope === undefined || packageName === undefined || typeof version !== 'string') {
    throw new Error('deno.json: expected "name": "@scope/name" and a "version" string.')
  }
  const packageUrl = `${JSR_API}/scopes/${scope}/packages/${packageName}`

  const jsrPackage = (await getJson(packageUrl)) as {
    githubRepository?: { owner?: string; name?: string } | null
  } | null
  if (jsrPackage === null) {
    notice(`${name} does not exist on JSR; not publishing ${version} there.`)
    return
  }
  const repository = process.env.GITHUB_REPOSITORY
  if (process.env.GITHUB_ACTIONS === 'true' && repository !== undefined) {
    const linked = jsrPackage.githubRepository
    const linkedName = linked ? `${linked.owner}/${linked.name}` : undefined
    if (linkedName?.toLowerCase() !== repository.toLowerCase()) {
      notice(
        `${name} on JSR is linked to ${linkedName ?? 'no GitHub repository'}, not ${repository}, ` +
          `so OIDC cannot publish it; not publishing ${version} there.`,
      )
      return
    }
  }
  if ((await getJson(`${packageUrl}/versions/${version}`)) !== null) {
    console.log(`${name}@${version} is already on JSR.`)
    return
  }

  console.log(`Publishing ${name}@${version} to JSR.`)
  const result = spawnSync('deno', ['publish', ...process.argv.slice(2)], {
    cwd: packageDir,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
}

/** GETs a JSR API resource; `null` when it does not exist (HTTP 404). */
async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`)
  return response.json()
}

/** Logs `message`, as a notice annotation in a GitHub Actions run. */
function notice(message: string): void {
  console.log(process.env.GITHUB_ACTIONS === 'true' ? `::notice title=JSR::${message}` : message)
}

await main()
