import { copyFile, mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toFileUrl } from '../../src/utils/path.js'
import type { FixtureManifest } from './fixture.js'
import { loadFixture } from './fixture.js'

/** A temporary copy of a fixture, so tests never modify `test/fixtures`. */
export interface TempProject extends AsyncDisposable {
  /** Fixture name. */
  readonly name: string
  /** Absolute, symlink-free path of the copy (outside the repository, so no ancestor config leaks in). */
  readonly root: string
  /** The fixture's `fixture.json`. */
  readonly manifest: FixtureManifest
  /** Absolute path inside the copy (`/`-separated segments are accepted). */
  path(...segments: string[]): string
  /** `file:` URL inside the copy. */
  url(...segments: string[]): string
  /** Removes the copy; safe to call more than once. */
  dispose(): Promise<void>
}

/** Copies `test/fixtures/<name>` into a new temporary directory. */
export async function tempProject(name: string): Promise<TempProject> {
  const fixture = await loadFixture(name)
  const root = await realpath(await mkdtemp(join(tmpdir(), `unplugin-deno-${name}-`)))
  await copyDir(fixture.dir, root)
  const path = (...segments: string[]): string =>
    join(root, ...segments.flatMap((s) => s.split('/')))
  const dispose = (): Promise<void> => rm(root, { recursive: true, force: true, maxRetries: 3 })
  return {
    name,
    root,
    manifest: fixture.manifest,
    path,
    url: (...segments) => toFileUrl(path(...segments)),
    dispose,
    [Symbol.asyncDispose]: dispose,
  }
}

async function copyDir(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true })
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) await copyDir(source, target)
    else if (entry.isFile()) await copyFile(source, target)
  }
}
