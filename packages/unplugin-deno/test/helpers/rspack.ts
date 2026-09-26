/**
 * Rspack test helpers: `buildWithRspack` builds fixture entries with Rspack 2 and the plugin
 * (placed first) into ES modules in a temporary directory and returns the same
 * {@link BuildResult} as `buildWithRolldown`; `rspackConfig` returns the configuration it uses.
 */
import type { Configuration, RuleSetRule, Stats } from '@rspack/core'
import { rspack } from '@rspack/core'
import { vi } from 'vitest'
import type { Options } from '../../src/core/options.js'
import denoRspack from '../../src/rspack.js'
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

/** TypeScript through Rspack's built-in SWC loader (what Rspack users configure). */
export const SWC_RULE: RuleSetRule = {
  test: /\.[cm]?tsx?$/,
  loader: 'builtin:swc-loader',
  options: {
    jsc: {
      parser: { syntax: 'typescript', tsx: true },
      // SWC drops import attributes unless told to keep them.
      experimental: { keepImportAttributes: true, emitAssertForImportAttributes: false },
    },
  },
}

/**
 * Options of {@link buildWithRspack}: Rspack configuration merged over the helper's, and the
 * TypeScript rule to use instead of {@link SWC_RULE} (`false`: none).
 */
export type RspackBuildOptions = Configuration & { typescriptRule?: RuleSetRule | false }

/**
 * The configuration of {@link buildWithRspack}: production mode without minification, source
 * maps, ES module output (`output.module`, `library.type: 'module'`, `[name].js`), the SWC
 * TypeScript rule, the plugin first, the `[unplugin-deno]` infrastructure log lines recorded into
 * `logs`. `extra` is merged over it (`output`, `module.rules`, `plugins` and `optimization` are
 * combined).
 */
export function rspackConfig(
  fixtureDir: string,
  entries: BuildEntries,
  outDir: string,
  logs: BuildLog[],
  pluginOptions: Options = {},
  extra: RspackBuildOptions = {},
): Configuration {
  const { output, module, plugins = [], optimization, typescriptRule = SWC_RULE, ...rest } = extra
  const typescript = typescriptRule === false ? [] : [typescriptRule]
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
    module: { ...module, rules: [...typescript, ...(module?.rules ?? [])] },
    plugins: [denoRspack(pluginOptions), ...plugins],
    infrastructureLogging: { level: 'info', console: captureConsole(logs) },
  }
}

/** Runs an Rspack compiler once and closes it. */
export async function runRspack(config: Configuration): Promise<Stats> {
  const compiler = rspack(config)
  try {
    return await new Promise<Stats>((resolve, reject) => {
      compiler.run((error, stats) => {
        if (error) reject(error)
        else if (stats === undefined) reject(new Error('Rspack returned no stats'))
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
 * Builds `entries` of the fixture copy at `fixtureDir` with Rspack and the plugin, the Rspack
 * counterpart of `buildWithRolldown`. `DENO_DIR` is the shared test one. Rejects with a
 * {@link HostBuildError} (the error messages) when the build has errors.
 */
export async function buildWithRspack(
  fixtureDir: string,
  entries: BuildEntries,
  pluginOptions: Options = {},
  extra: RspackBuildOptions = {},
): Promise<BuildResult> {
  vi.stubEnv('DENO_DIR', await denoDir())
  const logs: BuildLog[] = []
  const outDir = await outputDir()
  const started = performance.now()
  const stats = await runRspack(
    rspackConfig(fixtureDir, entries, outDir, logs, pluginOptions, extra),
  )
  const json = stats.toJson(STATS_OPTIONS) as StatsJsonLike
  for (const warning of json.warnings ?? []) logs.push({ level: 'warn', message: warning.message })
  if (stats.hasErrors()) {
    throw new HostBuildError('Rspack', json.errors ?? [])
  }
  const chunks = await chunksFromStats(json, outDir)
  return buildResult(outDir, chunks, logs, performance.now() - started)
}
