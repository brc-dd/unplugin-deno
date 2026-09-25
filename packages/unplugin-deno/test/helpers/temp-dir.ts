import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { toDirUrl, toFileUrl } from '../../src/utils/path.js'

/** A temporary directory tree for tests that need a file system. */
export interface TempDir extends AsyncDisposable {
  /** Absolute, symlink-free path of the directory (outside the repository). */
  readonly root: string
  /** Absolute path inside the directory (`/`-separated segments are accepted). */
  path(...segments: string[]): string
  /** `file:` URL inside the directory; a trailing `/` in the last segment is kept. */
  url(...segments: string[]): string
  /** Writes more files (`{ 'a/b.json': '…' }`); objects are serialised as JSON. */
  write(files: TempFiles): Promise<void>
  /** Removes the directory; safe to call more than once. */
  dispose(): Promise<void>
}

/** File contents by relative path; objects are written as JSON, `null` creates a directory. */
export type TempFiles = Record<string, string | object | null>

/** Creates a temporary directory containing `files`. */
export async function tempDir(files: TempFiles = {}): Promise<TempDir> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'unplugin-deno-test-')))
  const path = (...segments: string[]): string =>
    join(root, ...segments.flatMap((segment) => segment.split('/')).filter((part) => part !== ''))
  const write = async (more: TempFiles): Promise<void> => {
    for (const [relative, content] of Object.entries(more)) {
      const target = path(relative)
      if (content === null) {
        await mkdir(target, { recursive: true })
        continue
      }
      await mkdir(dirname(target), { recursive: true })
      await writeFile(
        target,
        typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`,
      )
    }
  }
  await write(files)
  const dispose = (): Promise<void> => rm(root, { recursive: true, force: true, maxRetries: 3 })
  return {
    root,
    path,
    url: (...segments) => {
      const last = segments.at(-1) ?? ''
      return last.endsWith('/') || segments.length === 0
        ? toDirUrl(path(...segments))
        : toFileUrl(path(...segments))
    },
    write,
    dispose,
    [Symbol.asyncDispose]: dispose,
  }
}
