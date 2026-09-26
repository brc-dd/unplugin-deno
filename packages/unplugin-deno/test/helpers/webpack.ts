/**
 * webpack test helpers: `buildWithWebpack` builds fixture entries with webpack 5 and the plugin
 * (placed first) into ES modules in a temporary directory and returns the same
 * {@link BuildResult} as `buildWithRolldown`; `webpackConfig` returns the configuration it uses.
 */
import { createRequire } from 'node:module'
import type { Configuration, RuleSetRule, Stats } from 'webpack'
import webpack from 'webpack'
import { vi } from 'vitest'
import type { Options } from '../../src/core/options.js'
import denoWebpack from '../../src/webpack.js'
import type { BuildEntries, BuildLog, BuildResult } from './build.js'
import { denoDir } from './deno-dir.js'
import {
  buildResult,
  captureConsole,
  chunksFromStats,
  entryObject,
  HostBuildError,
  outputDir,
  STATS_OPTIONS,
} from './webpack-stats.js'
import type { StatsJsonLike } from './webpack-stats.js'

const require = createRequire(import.meta.url)

/** esbuild-loader, by path: fixture copies live outside the repository (no `node_modules`). */
export const ESBUILD_LOADER: string = require.resolve('esbuild-loader')

/** The TypeScript rule of the test builds (webpack has no TypeScript support of its own on Bun). */
export const TYPESCRIPT_RULE: RuleSetRule = {
  test: /\.[cm]?tsx?$/,
  loader: ESBUILD_LOADER,
  options: { target: 'esnext' },
}

/** Options of {@link buildWithWebpack}: webpack configuration merged over the helper's. */
export type WebpackBuildOptions = Configuration

/**
 * The configuration of {@link buildWithWebpack}: production mode without minification, source
 * maps, ES module output (`output.module`, `library.type: 'module'`, `[name].js`), the TypeScript
 * rule, the plugin first, the `[unplugin-deno]` infrastructure log lines recorded into `logs`.
 * `extra` is merged over it (`output`, `module.rules`, `plugins` and `optimization` are combined).
 */
export function webpackConfig(
  fixtureDir: string,
  entries: BuildEntries,
  outDir: string,
  logs: BuildLog[],
  pluginOptions: Options = {},
  extra: WebpackBuildOptions = {},
): Configuration {
  const { output, module, plugins = [], optimization, ...rest } = extra
  return {
    mode: 'production',
    context: fixtureDir,
    devtool: 'source-map',
    cache: false,
    ...rest,
    entry: rest.entry ?? entryObject(fixtureDir, entries),
    output: {
      path: outDir,
      filename: '[name].js',
      chunkFilename: 'chunk-[contenthash:8].js',
      module: true,
      library: { type: 'module' },
      ...output,
    },
    optimization: { minimize: false, ...optimization },
    module: { ...module, rules: [TYPESCRIPT_RULE, ...(module?.rules ?? [])] },
    plugins: [denoWebpack(pluginOptions), ...plugins],
    infrastructureLogging: { level: 'info', console: captureConsole(logs) },
  }
}

/** Runs a webpack compiler once and closes it. */
export async function runWebpack(config: Configuration): Promise<Stats> {
  const compiler = webpack(config)
  try {
    return await new Promise<Stats>((resolve, reject) => {
      compiler.run((error, stats) => {
        if (error) reject(error)
        else if (stats === undefined) reject(new Error('webpack returned no stats'))
        else resolve(stats)
      })
    })
  } finally {
    await new Promise<void>((resolve) => {
      compiler.close(() => resolve())
    })
  }
}

/**
 * Builds `entries` of the fixture copy at `fixtureDir` with webpack and the plugin, the webpack
 * counterpart of `buildWithRolldown`. `DENO_DIR` is the shared test one. Rejects with a
 * {@link HostBuildError} (the error messages) when the build has errors.
 */
export async function buildWithWebpack(
  fixtureDir: string,
  entries: BuildEntries,
  pluginOptions: Options = {},
  extra: WebpackBuildOptions = {},
): Promise<BuildResult> {
  vi.stubEnv('DENO_DIR', await denoDir())
  const logs: BuildLog[] = []
  const outDir = await outputDir()
  const started = performance.now()
  const stats = await runWebpack(
    webpackConfig(fixtureDir, entries, outDir, logs, pluginOptions, extra),
  )
  const json = stats.toJson(STATS_OPTIONS) as StatsJsonLike
  for (const warning of json.warnings ?? []) logs.push({ level: 'warn', message: warning.message })
  if (stats.hasErrors()) {
    throw new HostBuildError('webpack', json.errors ?? [])
  }
  const chunks = await chunksFromStats(json, outDir)
  return buildResult(outDir, chunks, logs, performance.now() - started)
}
