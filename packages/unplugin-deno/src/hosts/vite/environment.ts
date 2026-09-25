/**
 * Vite environments and platforms (docs/architecture.md §5.6, §6.1): which platform each
 * environment builds for, the resolve target the adapter hands to the core, and the export
 * conditions added to server environments on the Deno platform.
 *
 * @module
 */
import type { Pattern, Platform } from '../../core/options.js'
import { derivePlatform } from '../../core/platform.js'
import type { ResolveTarget } from '../../core/resolve.js'
import type { PluginState } from '../../core/state.js'

/** Who consumes an environment's code (Vite's `environment.config.consumer`). */
export type EnvironmentConsumer = 'client' | 'server'

/** The parts of a Vite environment the adapter reads. */
export interface EnvironmentLike {
  name: string
  /** `dev`, `build` or `scan` (the dependency scan of a dev environment). */
  mode: string
  config: { consumer: EnvironmentConsumer }
}

/**
 * Vite's default server conditions (`defaultServerConditions` in Vite 7 and 8). A config that sets
 * `resolve.conditions` replaces the defaults, so adding `deno` means listing them too.
 */
export const VITE_SERVER_CONDITIONS: readonly string[] = [
  'module',
  'node',
  'development|production',
]

/** Vite's default `resolve.externalConditions` (`defaultExternalConditions` in Vite 7 and 8). */
export const VITE_EXTERNAL_CONDITIONS: readonly string[] = ['node', 'module-sync']

/**
 * What server environments on the Deno platform bundle in the dev server: Vite's module runner
 * executes them in the dev server's own runtime, which cannot load `npm:` and `jsr:` externals,
 * so they are resolved and loaded through Vite (mirror files, npm redirects) instead.
 */
export const DEV_SERVER_BUNDLE: readonly Pattern[] = ['npm:*', 'jsr:*']

/** The consumer of the environment `name` in a config that may not have set it yet. */
export function consumerOf(
  name: string,
  consumer: EnvironmentConsumer | undefined,
): EnvironmentConsumer {
  return consumer ?? (name === 'client' ? 'client' : 'server')
}

/**
 * The platform of a Vite environment (§5.6): client environments build for the browser unless
 * the `platform` option is a record naming them; server environments take the record entry, a
 * `platform` string, or `deno` when the project has a `deno.json` (else `node`). A `platform`
 * string never applies to client environments, whose code runs in the browser.
 */
export function environmentPlatform(
  state: PluginState,
  name: string,
  consumer: EnvironmentConsumer,
): Platform {
  const { platform } = state.options
  if (consumer === 'client') {
    return typeof platform === 'object' ? (platform[name] ?? 'browser') : 'browser'
  }
  return derivePlatform(state.options, {}, state.project, name)
}

/**
 * The resolve target of an environment: its platform, no host conditions (Vite's own
 * `resolve.conditions` apply to what Vite resolves), and in the dev server {@link DEV_SERVER_BUNDLE}
 * for the Deno platform. The project must be loaded.
 */
export function environmentTarget(
  state: PluginState,
  name: string,
  consumer: EnvironmentConsumer,
  dev: boolean,
): ResolveTarget {
  const platform = environmentPlatform(state, name, consumer)
  return {
    platform,
    conditions: [],
    ...(dev && platform === 'deno' ? { bundle: DEV_SERVER_BUNDLE } : {}),
  }
}

/** {@link environmentTarget} for a Vite environment instance (`this.environment`). */
export function targetOf(state: PluginState, environment: EnvironmentLike): ResolveTarget {
  return environmentTarget(
    state,
    environment.name,
    environment.config.consumer,
    environment.mode !== 'build',
  )
}

/**
 * What a `configEnvironment` result must hold to add `condition` to a conditions list (Vite
 * concatenates arrays when it merges the result): `condition` alone when the environment already
 * has a list, Vite's `defaults` plus `condition` when it has none (a configured list replaces the
 * defaults), `undefined` when the condition is there.
 */
export function conditionsToAdd(
  list: readonly string[] | undefined,
  defaults: readonly string[],
  condition: string,
): string[] | undefined {
  if (list === undefined) return [...defaults, condition]
  return list.includes(condition) ? undefined : [condition]
}
