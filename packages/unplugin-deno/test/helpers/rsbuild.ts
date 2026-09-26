/**
 * Rsbuild test helpers: `buildWithRsbuild` builds fixture entries with Rsbuild 2 and the plugin in
 * one or more environments (each into its own directory of a temporary output directory, as ES
 * modules that export the entry's exports) and returns a {@link BuildResult} per environment.
 */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { EnvironmentConfig, RsbuildConfig } from '@rsbuild/core'
import { createRsbuild } from '@rsbuild/core'
import { vi } from 'vitest'
import type { Options } from '../../src/core/options.js'
import denoRsbuild from '../../src/rsbuild.js'
import type { BuildEntries, BuildLog, BuildResult } from './build.js'
import { denoDir } from './deno-dir.js'
import type { StatsJsonLike } from './webpack-stats.js'
import {
  buildResult,
  captureConsole,
  chunksFromStats,
  entryObject,
  HostBuildError,
  outputDir,
  STATS_OPTIONS,
} from './webpack-stats.js'

/** The result of {@link buildWithRsbuild}: one build per environment, sharing the logs. */
export interface RsbuildBuildResult extends AsyncDisposable {
  environments: Record<string, BuildResult>
  logs: BuildLog[]
  /** Removes the output directory. */
  dispose(): Promise<void>
}

/** Options of {@link buildWithRsbuild}. */
export interface RsbuildBuildOptions {
  /** The environments to build (default: one `web` environment). */
  environments?: Record<string, EnvironmentConfig>
  /** Rsbuild configuration merged over the helper's (not deeply; `plugins` follow the plugin). */
  config?: RsbuildConfig
}

/**
 * Builds `entries` of the fixture copy at `fixtureDir` with Rsbuild and the plugin: production
 * mode without minification, hashes, chunk splitting or HTML, source maps, ES module output
 * with `library.type: 'module'` (so tests can import the entry), each environment into
 * `<outDir>/<name>`. `DENO_DIR` is the shared test one. Rejects with a {@link HostBuildError}
 * when a build has errors.
 */
export async function buildWithRsbuild(
  fixtureDir: string,
  entries: BuildEntries,
  pluginOptions: Options = {},
  options: RsbuildBuildOptions = {},
): Promise<RsbuildBuildResult> {
  vi.stubEnv('DENO_DIR', await denoDir())
  const logs: BuildLog[] = []
  const outDir = await outputDir()
  const dispose = (): Promise<void> => rm(outDir, { recursive: true, force: true, maxRetries: 3 })
  const environments = options.environments ?? { web: {} }
  const { plugins = [], ...config } = options.config ?? {}
  const started = performance.now()
  const rsbuild = await createRsbuild({
    cwd: fixtureDir,
    config: {
      mode: 'production',
      logLevel: 'error',
      plugins: [denoRsbuild(pluginOptions), ...plugins],
      source: { entry: entryObject(fixtureDir, entries) },
      output: {
        filenameHash: false,
        minify: false,
        module: true,
        sourceMap: { js: 'source-map' },
      },
      splitChunks: false,
      performance: { printFileSize: false },
      tools: {
        htmlPlugin: false,
        rspack: {
          output: { library: { type: 'module' } },
          infrastructureLogging: { level: 'info', console: captureConsole(logs) },
        },
      },
      ...config,
      environments: Object.fromEntries(
        Object.entries(environments).map(([name, environment]) => [
          name,
          {
            ...environment,
            output: {
              ...environment.output,
              distPath: { root: join(outDir, name), js: '', jsAsync: 'async' },
            },
          },
        ]),
      ),
    },
  })
  try {
    const { stats, close } = await rsbuild.build()
    await close()
    if (stats === undefined) throw new Error('Rsbuild returned no stats')
    const list = 'stats' in stats ? stats.stats : [stats]
    const results: Record<string, BuildResult> = {}
    for (const item of list) {
      const name = item.compilation.name ?? Object.keys(environments)[0] ?? 'web'
      const json = item.toJson(STATS_OPTIONS) as StatsJsonLike
      for (const warning of json.warnings ?? []) {
        logs.push({ level: 'warn', message: warning.message })
      }
      if (item.hasErrors()) throw new HostBuildError(`Rsbuild (${name})`, json.errors ?? [])
      const dir = join(outDir, name)
      const chunks = await chunksFromStats(json, dir)
      results[name] = buildResult(dir, chunks, logs, performance.now() - started)
    }
    return { environments: results, logs, dispose, [Symbol.asyncDispose]: dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}
