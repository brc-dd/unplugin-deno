/**
 * Splits `jsr:`/`npm:` package requirements and bare package specifiers into name, version
 * constraint and subpath. The engine uses this to classify resolution failures and to report which
 * subpath of an npm package was requested; it does not validate names the way the registries do.
 *
 * @module
 */

/** A package specifier split into its parts. */
export interface PackageSpecifier {
  /** `jsr:`/`npm:` requirement, or a `bare` specifier (resolved through the import map or Node). */
  scheme: 'jsr' | 'npm' | 'bare'
  /** `@scope/name` or `name`. */
  name: string
  /** The version constraint after `@` (`^1`, `4.1.5`), or `undefined` when there is none. */
  version: string | undefined
  /** `''` for the package root, otherwise the rest with a leading slash (`/colors`). */
  subpath: string
}

/**
 * Parses `jsr:@std/path@^1/posix`, `npm:kleur@4.1.5/colors`, `npm:/kleur` (Deno accepts a leading
 * slash) and bare specifiers such as `kleur/colors` or `@std/path/join`. Returns `undefined` for
 * everything else (relative and absolute paths, URLs, `node:` builtins, `#imports`, malformed
 * names). Bare specifiers never carry a version: `kleur@4` names a package called `kleur@4`.
 */
export function parsePackageSpecifier(specifier: string): PackageSpecifier | undefined {
  const scheme = /^(jsr|npm):/i.exec(specifier)?.[1]?.toLowerCase()
  if (scheme === 'jsr' || scheme === 'npm') {
    const rest = specifier.slice(scheme.length + 1).replace(/^\//, '')
    return parseParts(scheme, rest, true)
  }
  if (!isBareSpecifier(specifier)) return undefined
  return parseParts('bare', specifier, false)
}

/**
 * Whether `specifier` is bare: not relative (`./`, `../`, `/`), not an absolute Windows path, not
 * a URL or other `scheme:` specifier, and not a package `#import`.
 */
export function isBareSpecifier(specifier: string): boolean {
  if (specifier === '' || specifier.startsWith('#')) return false
  if (/^\.{1,2}(?:[\\/]|$)/.test(specifier) || /^[\\/]/.test(specifier)) return false
  if (/^[a-zA-Z]:(?:[\\/]|$)/.test(specifier)) return false
  return !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(specifier)
}

/** Whether `specifier` is a `jsr:` or `npm:` requirement (the loader returns these unresolved). */
export function isPackageRequirement(specifier: string): boolean {
  return /^(?:jsr|npm):/i.test(specifier)
}

function parseParts(
  scheme: PackageSpecifier['scheme'],
  text: string,
  withVersion: boolean,
): PackageSpecifier | undefined {
  const segments = text.split('/')
  const scoped = segments[0]?.startsWith('@') === true
  const nameSegments = segments.slice(0, scoped ? 2 : 1)
  if (nameSegments.length < (scoped ? 2 : 1)) return undefined
  let last = nameSegments.at(-1) ?? ''
  let version: string | undefined
  if (withVersion) {
    const at = last.indexOf('@', scoped ? 0 : 1)
    if (at !== -1) {
      version = last.slice(at + 1)
      last = last.slice(0, at)
      if (version === '') return undefined
    }
  }
  nameSegments[nameSegments.length - 1] = last
  if (nameSegments.some((segment) => segment === '' || segment === '@')) return undefined
  const rest = segments.slice(nameSegments.length)
  return {
    scheme,
    name: nameSegments.join('/'),
    version,
    subpath: rest.length === 0 ? '' : `/${rest.join('/')}`,
  }
}
