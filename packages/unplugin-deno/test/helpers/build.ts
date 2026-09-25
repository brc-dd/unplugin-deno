import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  InputOptions as RolldownInputOptions,
  OutputOptions as RolldownOutputOptions,
} from 'rolldown'
import { rolldown } from 'rolldown'
import type {
  InputOptions as RollupInputOptions,
  OutputOptions as RollupOutputOptions,
  Plugin as RollupPlugin,
} from 'rollup'
import { rollup } from 'rollup'
import { vi } from 'vitest'
import type { Options } from '../../src/core/options.js'
import denoRolldown from '../../src/rolldown.js'
import denoRollup from '../../src/rollup.js'
import { denoDir } from './deno-dir.js'
import { rollupJson, rollupTypeScript } from './rollup-ts.js'

/** A log line a host reported (`onLog`). */
export interface BuildLog {
  level: string
  message: string
  code?: string | undefined
  plugin?: string | undefined
}

/** One output chunk. */
export interface BuildChunk {
  fileName: string
  code: string
  isEntry: boolean
  /** Ids of the modules bundled into the chunk. */
  moduleIds: string[]
  /** Rendered size of each module in the chunk, in characters. */
  moduleSizes: Record<string, number>
  /** Imports the chunk keeps (externals and other chunks). */
  imports: string[]
}

/** The result of {@link buildWithRolldown} and {@link buildWithRollup}. */
export interface BuildResult extends AsyncDisposable {
  /** Temporary output directory (outside the fixture). */
  outDir: string
  chunks: BuildChunk[]
  /** Absolute path of the first entry chunk. */
  entry: string
  logs: BuildLog[]
  /** Wall-clock time of the build, in milliseconds. */
  durationMs: number
  /** Removes {@link BuildResult.outDir}. */
  dispose(): Promise<void>
}

/** Entry modules, relative to the fixture root (or absolute). */
export type BuildEntries = string | string[] | Record<string, string>

function absoluteEntries(root: string, entries: BuildEntries): string[] | Record<string, string> {
  const absolute = (entry: string): string => (isAbsolute(entry) ? entry : join(root, entry))
  if (typeof entries === 'string') return [absolute(entries)]
  if (Array.isArray(entries)) return entries.map(absolute)
  return Object.fromEntries(Object.entries(entries).map(([name, file]) => [name, absolute(file)]))
}

async function outputDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'unplugin-deno-out-'))
}

function result(
  outDir: string,
  chunks: BuildChunk[],
  logs: BuildLog[],
  durationMs: number,
): BuildResult {
  const first = chunks.find((chunk) => chunk.isEntry) ?? chunks[0]
  const dispose = (): Promise<void> => rm(outDir, { recursive: true, force: true, maxRetries: 3 })
  return {
    outDir,
    chunks,
    entry: join(outDir, first?.fileName ?? 'main.js'),
    logs,
    durationMs,
    dispose,
    [Symbol.asyncDispose]: dispose,
  }
}

/** Rolldown options for {@link buildWithRolldown}, plus output options. */
export type RolldownBuildOptions = Omit<RolldownInputOptions, 'input'> & {
  output?: RolldownOutputOptions
}

/**
 * Builds `entries` of the fixture copy at `fixtureDir` with Rolldown and the plugin (placed first),
 * writing ES modules to a temporary directory. `DENO_DIR` is the shared test one; the mirror uses
 * its default location in the fixture copy (`node_modules/.unplugin-deno`), so every copy starts
 * with an empty mirror. Rolldown's `cwd` is the fixture copy.
 */
export async function buildWithRolldown(
  fixtureDir: string,
  entries: BuildEntries,
  pluginOptions: Options = {},
  rolldownOptions: RolldownBuildOptions = {},
): Promise<BuildResult> {
  vi.stubEnv('DENO_DIR', await denoDir())
  const { output: outputOptions, plugins = [], ...inputOptions } = rolldownOptions
  const logs: BuildLog[] = []
  const outDir = await outputDir()
  const started = performance.now()
  const bundle = await rolldown({
    cwd: fixtureDir,
    ...inputOptions,
    input: absoluteEntries(fixtureDir, entries),
    plugins: [denoRolldown(pluginOptions), plugins],
    onLog(level, log) {
      logs.push({ level, message: log.message, code: log.code, plugin: log.plugin })
    },
  })
  try {
    const { output } = await bundle.write({
      dir: outDir,
      format: 'esm',
      entryFileNames: '[name].js',
      chunkFileNames: 'chunk-[hash].js',
      ...outputOptions,
    })
    const chunks = output.flatMap((item) =>
      item.type === 'chunk'
        ? [
            {
              fileName: item.fileName,
              code: item.code,
              isEntry: item.isEntry,
              moduleIds: [...item.moduleIds],
              moduleSizes: Object.fromEntries(
                Object.entries(item.modules).map(([id, module]) => [id, module.renderedLength]),
              ),
              imports: [...item.imports, ...item.dynamicImports],
            },
          ]
        : [],
    )
    return result(outDir, chunks, logs, performance.now() - started)
  } finally {
    await bundle.close()
  }
}

/** Rollup options for {@link buildWithRollup}, plus output options. */
export type RollupBuildOptions = Omit<RollupInputOptions, 'input'> & {
  output?: RollupOutputOptions
}

/**
 * Builds `entries` of the fixture copy at `fixtureDir` with Rollup: the plugin first (with `cwd`
 * set to the fixture copy, as Rollup has no root), then the test TypeScript and JSON plugins
 * (`rollup-ts.ts`), then `rollupOptions.plugins`. Otherwise like {@link buildWithRolldown}.
 */
export async function buildWithRollup(
  fixtureDir: string,
  entries: BuildEntries,
  pluginOptions: Options = {},
  rollupOptions: RollupBuildOptions = {},
): Promise<BuildResult> {
  vi.stubEnv('DENO_DIR', await denoDir())
  const { output: outputOptions, plugins = [], ...inputOptions } = rollupOptions
  const logs: BuildLog[] = []
  const outDir = await outputDir()
  const started = performance.now()
  const bundle = await rollup({
    ...inputOptions,
    input: absoluteEntries(fixtureDir, entries),
    plugins: [
      denoRollup({ cwd: fixtureDir, ...pluginOptions }) as RollupPlugin,
      rollupTypeScript(),
      rollupJson(),
      plugins,
    ],
    onLog(level, log) {
      logs.push({ level, message: log.message, code: log.code, plugin: log.plugin })
    },
  })
  try {
    const { output } = await bundle.write({
      dir: outDir,
      format: 'es',
      entryFileNames: '[name].js',
      chunkFileNames: 'chunk-[hash].js',
      ...outputOptions,
    })
    const chunks = output.flatMap((item) =>
      item.type === 'chunk'
        ? [
            {
              fileName: item.fileName,
              code: item.code,
              isEntry: item.isEntry,
              moduleIds: [...item.moduleIds],
              moduleSizes: Object.fromEntries(
                Object.entries(item.modules).map(([id, module]) => [id, module.renderedLength]),
              ),
              imports: [...item.imports, ...item.dynamicImports],
            },
          ]
        : [],
    )
    return result(outDir, chunks, logs, performance.now() - started)
  } finally {
    await bundle.close()
  }
}

/** Imports a built module in the current runtime and returns its namespace. */
export async function evaluateModule<T = Record<string, unknown>>(outFile: string): Promise<T> {
  return (await import(pathToFileURL(outFile).href)) as T
}

/**
 * Makes `CSSStyleSheet` available for evaluating CSS marker modules on runtimes without one (Node,
 * Deno and Bun lack the constructor): a minimal stand-in that keeps the text. Returns a function
 * that restores the previous state.
 */
export function installCssStyleSheet(): () => void {
  const target = globalThis as { CSSStyleSheet?: unknown }
  if (target.CSSStyleSheet !== undefined) return () => {}
  class CSSStyleSheet {
    text = ''
    replaceSync(text: string): void {
      this.text = text
    }
  }
  target.CSSStyleSheet = CSSStyleSheet
  return () => {
    delete target.CSSStyleSheet
  }
}
