/**
 * The `jsrDepsInNodeModules` route (docs/architecture.md §5.4, plan R11). Deno 2.9's
 * `"jsrDepsInNodeModules": true` installs `jsr:` dependencies from JSR's npm registry
 * (`npm.jsr.io`) into `node_modules/@jsr/<scope>__<name>` and maps `jsr:@scope/name@range` import-map
 * entries to `npm:@jsr/scope__name@range` (verified with Deno 2.9.7; both engines know the `@jsr`
 * scope's registry). When the project uses that layout, every `jsr:` specifier of the build takes
 * this npm route, so the host resolves `@jsr/scope__name/<subpath>` from `node_modules` like any
 * npm package; the JSR sources are never mirrored in the same build (two copies of one package).
 * Unlike Deno 2.9.7, subpaths of import-map keys (`@std/path/posix/join`) work, and `jsr:`
 * specifiers written in code take the npm route too.
 *
 * @module
 */
import type { Project } from '../config/project.js'
import type { NpmStrategy } from './npm.js'
import { parseJsrSpecifier } from './specifier.js'

/** Where `jsr:` packages come from: mirrored registry sources, or `node_modules/@jsr`. */
export type JsrRoute = 'mirror' | 'node_modules'

/** The route of a build and why, for the debug output. */
export interface JsrRouteDecision {
  route: JsrRoute
  reason: string
}

/**
 * The `jsr:` route of a project: `node_modules` when npm packages come from `node_modules` and the
 * project installs JSR packages there (`jsrDepsInNodeModules` in the root config, or packages in
 * `node_modules/@jsr/`), else `mirror`.
 */
export function jsrRouteFor(
  project: Pick<Project, 'jsrDepsInNodeModules' | 'nodeModules'>,
  npmStrategy: NpmStrategy,
): JsrRouteDecision {
  if (npmStrategy !== 'node_modules') {
    return { route: 'mirror', reason: 'npm packages come from the Deno cache' }
  }
  if (project.jsrDepsInNodeModules) {
    return { route: 'node_modules', reason: '`"jsrDepsInNodeModules": true`' }
  }
  if (project.nodeModules.hasJsrDeps) {
    return {
      route: 'node_modules',
      reason: `${project.nodeModules.dir ?? 'node_modules'}/@jsr exists`,
    }
  }
  return { route: 'mirror', reason: 'the project does not install JSR packages into node_modules' }
}

/** The npm name of a JSR package on JSR's npm registry: `@std/path` → `@jsr/std__path`. */
export function jsrNpmName(name: string): string {
  const [scope = '', packageName = ''] = name.slice(1).split('/')
  return `@jsr/${scope}__${packageName}`
}

/**
 * The npm requirement a `jsr:` specifier maps to on this route, with its range and subpath:
 * `jsr:@std/path@^1/posix` → `npm:@jsr/std__path@^1/posix`. `undefined` for anything else.
 */
export function jsrToNpmSpecifier(specifier: string): string | undefined {
  const jsr = parseJsrSpecifier(specifier)
  if (jsr === null) return undefined
  const range = jsr.range === undefined ? '' : `@${jsr.range}`
  const subpath = jsr.subpath === '/' ? '' : jsr.subpath
  return `npm:${jsrNpmName(jsr.name)}${range}${subpath}`
}
