/**
 * Finds the npm package that contains a resolved file: under a `node_modules` directory (isolated
 * `.deno/`, pnpm or hoisted layouts) or in Deno's global npm cache (`DENO_DIR/npm/<registry>/…`).
 *
 * @module
 */
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs'
import { join, posix, win32 } from 'node:path'
import type { PathFlavor } from '../utils/path.js'
import { HOST_PATH_FLAVOR, isSubpath, normalizeDriveLetter } from '../utils/path.js'

/** The `package.json` fields the engine uses. */
export interface PackageJsonFields {
  name: string
  version: string
  /** `sideEffects` when it is a boolean, otherwise `null`. */
  sideEffects: boolean | null
}

/** A package found by {@link NpmPackageLocator.find}. */
export interface FoundPackage extends PackageJsonFields {
  /** The package directory. */
  dir: string
  /** `<dir>/package.json`. */
  packageJsonPath: string
}

/** Reads `<dir>/package.json`; `undefined` when it is missing, unreadable or has no `name`. */
export type PackageJsonReader = (dir: string) => PackageJsonFields | undefined

/**
 * Locates npm packages for one engine. `package.json` reads are cached per directory for the
 * lifetime of the locator (installed packages do not change while an engine lives).
 */
export class NpmPackageLocator {
  readonly #cacheRoots: () => readonly string[]
  readonly #flavor: PathFlavor
  readonly #read: PackageJsonReader
  readonly #packageJsons = new Map<string, PackageJsonFields | undefined>()

  /**
   * @param cacheRoots Directories that hold npm packages outside `node_modules` (the global npm
   *   cache `DENO_DIR/npm`, as literal and canonical paths).
   * @param flavor Path syntax of the paths passed in.
   * @param read Reads a `package.json` (tests inject one).
   */
  constructor(
    cacheRoots: () => readonly string[],
    flavor: PathFlavor = HOST_PATH_FLAVOR,
    read: PackageJsonReader = readPackageJsonFields,
  ) {
    this.#cacheRoots = cacheRoots
    this.#flavor = flavor
    this.#read = read
  }

  /** Whether `path` is inside a `node_modules` directory or a global npm cache root. */
  contains(path: string): boolean {
    return this.#boundary(path) !== undefined
  }

  /**
   * The package containing `file`: the nearest ancestor whose `package.json` is named
   * `expectedName` (when given), otherwise the outermost ancestor with a named `package.json` below
   * the `node_modules` directory or cache root (so nested `package.json` files such as
   * `dist/esm/package.json` are skipped). `undefined` when `file` is not in an npm location or no
   * package is found.
   */
  find(file: string, expectedName?: string): FoundPackage | undefined {
    const boundary = this.#boundary(file)
    if (boundary === undefined) return undefined
    const path = this.#flavor === 'win32' ? win32 : posix
    let outermost: FoundPackage | undefined
    let dir = path.dirname(file)
    while (dir !== boundary && isSubpath(boundary, dir, this.#flavor)) {
      const fields = this.#packageJson(dir)
      if (fields !== undefined) {
        const found = { ...fields, dir, packageJsonPath: path.join(dir, 'package.json') }
        if (expectedName !== undefined && fields.name === expectedName) return found
        outermost = found
      }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return outermost
  }

  /** The directory a package search must stay below: a cache root or the innermost `node_modules`. */
  #boundary(file: string): string | undefined {
    for (const root of this.#cacheRoots()) {
      if (root !== file && isSubpath(root, file, this.#flavor)) return root
    }
    const separator = this.#flavor === 'win32' ? /[\\/]/ : /\//
    const segments = file.split(separator)
    const index = segments.lastIndexOf('node_modules')
    if (index <= 0 || index === segments.length - 1) return undefined
    return segments.slice(0, index + 1).join(this.#flavor === 'win32' ? win32.sep : posix.sep)
  }

  #packageJson(dir: string): PackageJsonFields | undefined {
    if (this.#packageJsons.has(dir)) return this.#packageJsons.get(dir)
    const fields = this.#read(dir)
    this.#packageJsons.set(dir, fields)
    return fields
  }
}

/** Reads the {@link PackageJsonFields} of `<dir>/package.json` from disk. */
export function readPackageJsonFields(dir: string): PackageJsonFields | undefined {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const { name, version, sideEffects } = value as Record<string, unknown>
  if (typeof name !== 'string' || name === '') return undefined
  return {
    name,
    version: typeof version === 'string' ? version : '',
    sideEffects: typeof sideEffects === 'boolean' ? sideEffects : null,
  }
}

/** Symlink hops {@link realpathMaybeMissing} follows before giving up (like `ELOOP`). */
const MAX_SYMLINK_HOPS = 40

/**
 * The canonical path of `path`: symlinks resolved, including when the file (or part of the path)
 * does not exist yet, in which case the nearest existing ancestor is canonicalised and the rest
 * appended (like Deno's `canonicalize_path_maybe_not_exists`).
 *
 * Only directories go through the OS `realpath`; the last segment is followed only when it is a
 * symlink. A regular file may have several names (npm installs hard-link files from the global
 * cache into `node_modules/.deno`), and some `realpath` implementations return any of them (Bun on
 * macOS answers from the file descriptor), which would move a file into another package.
 */
export function realpathMaybeMissing(path: string, flavor: PathFlavor = HOST_PATH_FLAVOR): string {
  return canonicalize(path, flavor).path
}

/** {@link realpathMaybeMissing}, also telling whether the canonical path exists. */
export function canonicalize(
  path: string,
  flavor: PathFlavor = HOST_PATH_FLAVOR,
): { path: string; exists: boolean } {
  const syntax = flavor === 'win32' ? win32 : posix
  let current = path
  for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop++) {
    const name = syntax.basename(current)
    const dir = realDirectory(syntax.dirname(current), syntax)
    const candidate = name === '' ? dir : syntax.join(dir, name)
    let target: string
    try {
      if (!lstatSync(candidate).isSymbolicLink()) return { path: candidate, exists: true }
      target = readlinkSync(candidate)
    } catch {
      return { path: candidate, exists: false }
    }
    current = syntax.resolve(dir, target)
  }
  return { path: current, exists: false }
}

/** `realpath` of a directory, canonicalising the existing part of a missing one. */
function realDirectory(dir: string, syntax: typeof posix): string {
  const missing: string[] = []
  let current = dir
  for (;;) {
    try {
      const real = normalizeDriveLetter(realpathSync.native(current))
      return missing.length === 0 ? real : syntax.join(real, ...missing.toReversed())
    } catch {
      const parent = syntax.dirname(current)
      if (parent === current) return dir
      missing.push(syntax.basename(current))
      current = parent
    }
  }
}
