/**
 * Locates `DENO_DIR`, Deno's global cache, the way the vendored loader does (`deno_cache_dir`
 * 0.34 `resolve_deno_dir` over sys_traits' wasm environment), so the engine can tell files in the
 * global npm cache (`DENO_DIR/npm/`) from local files.
 *
 * @module
 */
import { posix, win32 } from 'node:path'

/** Inputs of {@link resolveDenoDir}; each defaults to the current process. */
export interface DenoDirContext {
  /** Environment variables (`DENO_DIR`, `XDG_CACHE_HOME`, `HOME`, `USERPROFILE`). */
  env?: Readonly<Record<string, string | undefined>>
  /** A `process.platform` value; `win32` and `darwin` change the defaults and the path syntax. */
  platform?: string
  /** Base directory for a relative `DENO_DIR`. */
  cwd?: string
}

/**
 * The absolute `DENO_DIR` path, or `undefined` when no home directory is known. First match wins
 * (empty variables count as unset):
 *
 * 1. `$DENO_DIR`, resolved against `cwd` when relative;
 * 2. `$XDG_CACHE_HOME/deno`, on every platform (macOS and Windows included);
 * 3. the OS cache directory + `deno`: `$HOME/Library/Caches` on macOS,
 *    `%USERPROFILE%\AppData\Local` on Windows (the wasm build reads `USERPROFILE`; the Deno CLI
 *    asks Windows for the LocalAppData folder, normally the same directory), `$HOME/.cache`
 *    elsewhere.
 *
 * Symlinks are not resolved; the loader reports canonical paths, so compare against the realpath.
 */
export function resolveDenoDir(context: DenoDirContext = {}): string | undefined {
  const env = context.env ?? process.env
  const platform = context.platform ?? process.platform
  const path = platform === 'win32' ? win32 : posix
  const read = (name: string): string | undefined => {
    const value = env[name]
    return value === undefined || value === '' ? undefined : value
  }
  const custom = read('DENO_DIR')
  const xdg = read('XDG_CACHE_HOME')
  const home = read(platform === 'win32' ? 'USERPROFILE' : 'HOME')
  let root: string | undefined
  if (custom !== undefined) root = custom
  else if (xdg !== undefined) root = path.join(xdg, 'deno')
  else if (home !== undefined) root = path.join(osCacheDir(platform, home), 'deno')
  return root === undefined ? undefined : path.resolve(context.cwd ?? process.cwd(), root)
}

function osCacheDir(platform: string, home: string): string {
  if (platform === 'win32') return win32.join(home, 'AppData', 'Local')
  if (platform === 'darwin') return posix.join(home, 'Library', 'Caches')
  return posix.join(home, '.cache')
}
