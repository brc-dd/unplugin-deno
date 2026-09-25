import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Environment variable that overrides the test `DENO_DIR` (CI points it at a cached directory). */
export const TEST_DENO_DIR_ENV = 'UNPLUGIN_DENO_TEST_DENO_DIR'

/**
 * The path of the `DENO_DIR` tests use instead of the user's global Deno cache:
 * `$UNPLUGIN_DENO_TEST_DENO_DIR` when set, otherwise `<os temp>/unplugin-deno-test/deno-dir`,
 * shared by the test runs on this machine so remote fixtures download once. Does not create it.
 */
export function testDenoDirPath(): string {
  return process.env[TEST_DENO_DIR_ENV] || join(tmpdir(), 'unplugin-deno-test', 'deno-dir')
}

/** Creates (if needed) and returns the test `DENO_DIR`; see {@link testDenoDirPath}. */
export async function denoDir(): Promise<string> {
  const dir = testDenoDirPath()
  await mkdir(dir, { recursive: true })
  return realpath(dir)
}

/** An empty `DENO_DIR` for tests that need a cold cache. */
export interface FreshDenoDir extends AsyncDisposable {
  readonly path: string
  /** Removes the directory. */
  dispose(): Promise<void>
}

/** Creates an empty, uniquely named `DENO_DIR` under the OS temp directory. */
export async function freshDenoDir(): Promise<FreshDenoDir> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'unplugin-deno-deno-dir-')))
  const dispose = (): Promise<void> => rm(path, { recursive: true, force: true, maxRetries: 3 })
  return { path, dispose, [Symbol.asyncDispose]: dispose }
}
