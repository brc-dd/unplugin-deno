/**
 * Change detection for the files a project is loaded from (docs/architecture.md §5.7). esbuild has
 * no `watchChange` hook: a rebuild of a context (or another build with the same plugin instance)
 * only calls `onStart`, so the adapter compares the contents of the watched files (configs, import
 * maps, package.json files, lockfile) with those of the last project load.
 *
 * @module
 */
import { readFile } from 'node:fs/promises'

/** The contents of watched files by path; `null` for a file that does not exist. */
export type WatchSnapshot = ReadonlyMap<string, string | null>

async function contents(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

/** Reads the current contents of `files`. */
export async function takeSnapshot(files: readonly string[]): Promise<WatchSnapshot> {
  const entries = await Promise.all(
    files.map(async (file) => [file, await contents(file)] as const),
  )
  return new Map(entries)
}

/** The first file of `snapshot` whose contents changed since, or `undefined`. */
export async function changedFile(snapshot: WatchSnapshot): Promise<string | undefined> {
  const current = await takeSnapshot([...snapshot.keys()])
  for (const [file, content] of snapshot) {
    if (current.get(file) !== content) return file
  }
  return undefined
}
