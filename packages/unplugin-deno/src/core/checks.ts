/**
 * Diagnostics checks (docs/architecture.md §5.8, §5.10; plan X3, X4, L10, S5): the messages of the
 * browser-safety warnings, `Deno.*` globals in browser bundles, native addons, and npm packages
 * bundled in several versions (recorded while resolving, reported when a build ends).
 *
 * @module
 */
import { isAbsolute, relative } from 'node:path'
import { lineColumn } from '../utils/js-tokens.js'
import type { NodeModulesInfo } from '../config/project.js'
import type { Platform } from './options.js'
import type { DenoReference } from './source.js'

/** A module id or URL for messages: files relative to `root` (with `/`), URLs as they are. */
export function displayModule(id: string, root: string): string {
  if (!isAbsolute(id)) return id
  const path = relative(root, id)
  return path.replaceAll('\\', '/')
}

/** The warning for a `node:` builtin imported by a module of a browser bundle (X3). */
export function nodeBuiltinMessage(importer: string, specifier: string): string {
  return `${importer} imports \`${specifier}\`, a Node.js builtin, into a browser bundle (${importer} → ${specifier}); the bundler will fail or substitute a polyfill. Import it only from server code, alias it to a browser implementation, or mark it external.`
}

/** The warning for an npm package that resolves to a native addon, kept external (S5). */
export function nativeAddonMessage(specifier: string, file: string): string {
  return `\`${specifier}\` resolves to the native addon ${file}, which cannot be bundled; it is kept external (loaded at runtime). Add it to the \`external\` option to make this explicit.`
}

/** The message for `Deno.*` references in a local module of a browser bundle (L10). */
export function denoGlobalsMessage(
  file: string,
  code: string,
  references: readonly DenoReference[],
): string {
  const [first] = references
  const position = first === undefined ? { line: 1, column: 1 } : lineColumn(code, first.start)
  const members = [...new Set(references.map((reference) => `Deno.${reference.member}`))]
  const listed = members.slice(0, 3).map((member) => `\`${member}\``)
  if (members.length > 3) listed.push(`${members.length - 3} more`)
  return `${file}:${position.line}:${position.column} uses ${listed.join(', ')}, which browsers do not have (a browser bundle). Move it to server code or inline environment variables with the \`env\` option; set \`denoGlobals: 'off'\` when the code is guarded (\`typeof Deno !== "undefined"\`).`
}

/**
 * The warning for a `node_modules` directory another package manager installed when Deno manages
 * it (`nodeModulesDir: "auto"`): Deno installs into `node_modules/.deno` and re-links the
 * top-level packages over the other manager's links.
 */
export function foreignNodeModulesMessage(info: NodeModulesInfo): string | undefined {
  if (info.mode !== 'auto' || info.foreignManager === null || info.dir === null) return undefined
  return `${info.dir} was installed by ${info.foreignManager}, but deno.json sets "nodeModulesDir": "auto": Deno will install the package.json dependencies into node_modules/.deno and re-link the top-level packages over ${info.foreignManager}'s. Use "nodeModulesDir": "manual" to keep installing with ${info.foreignManager}, or keep node_modules managed by Deno only (remove it and run \`deno install\`).`
}

/**
 * The npm packages bundled per platform (X4): records `name@version` as the resolver meets them,
 * and reports the names bundled in more than one version.
 */
export class PackageVersions {
  readonly #byPlatform = new Map<Platform, Map<string, Set<string>>>()

  /** Records that `name@version` is bundled for `platform`. */
  record(platform: Platform, name: string, version: string): void {
    if (version === '') return
    let packages = this.#byPlatform.get(platform)
    if (packages === undefined) {
      packages = new Map()
      this.#byPlatform.set(platform, packages)
    }
    let versions = packages.get(name)
    if (versions === undefined) {
      versions = new Set()
      packages.set(name, versions)
    }
    versions.add(version)
  }

  /**
   * The warnings for the packages of `platform` (every platform when omitted) bundled in several
   * versions, and forgets those records.
   */
  take(platform?: Platform): string[] {
    const platforms = platform === undefined ? [...this.#byPlatform.keys()] : [platform]
    const messages: string[] = []
    for (const current of platforms) {
      const packages = this.#byPlatform.get(current)
      this.#byPlatform.delete(current)
      if (packages === undefined) continue
      for (const [name, versions] of [...packages].toSorted(([a], [b]) => a.localeCompare(b))) {
        if (versions.size < 2) continue
        const list = [...versions].toSorted().join(', ')
        messages.push(
          `The npm package ${name} is bundled in ${versions.size} versions (${list}) for the ${current} platform. Use one version range for it (deno.json \`imports\`, package.json) so one copy is bundled.`,
        )
      }
    }
    return messages
  }
}
