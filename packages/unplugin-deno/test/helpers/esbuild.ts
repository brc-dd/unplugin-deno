import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { BuildOptions, BuildResult as EsbuildResult, Message, Metafile, Plugin } from 'esbuild'
import { build, context } from 'esbuild'
import type { MockInstance } from 'vitest'
import { vi } from 'vitest'
import type { Options } from '../../src/core/options.js'
import denoEsbuild from '../../src/esbuild.js'
import type { BuildChunk, BuildEntries, BuildLog, BuildResult } from './build.js'
import { denoDir } from './deno-dir.js'

/** The result of {@link buildWithEsbuild}: the shared shape plus esbuild's own output. */
export interface EsbuildBuildResult extends BuildResult {
  metafile: Metafile
  /** esbuild's warnings (the plugin's included). */
  warnings: Message[]
}

/** esbuild options for {@link buildWithEsbuild}; `entryPoints` come from the entries argument. */
export type EsbuildBuildOptions = Omit<BuildOptions, 'entryPoints'> & { plugins?: Plugin[] }

/** Records what the plugin prints on stderr (debug lines) instead of printing it. */
export interface CapturedLogs {
  /** The lines printed since the last call. */
  take(): BuildLog[]
  restore(): void
}

/** Starts recording the plugin's stderr lines (`[unplugin-deno] …`, printed with `console.warn`). */
export function captureLogs(): CapturedLogs {
  let lines: BuildLog[] = []
  const record = (level: string) => (message: unknown) => {
    lines.push({ level, message: String(message) })
  }
  const spies: MockInstance[] = [
    vi.spyOn(console, 'warn').mockImplementation(record('stderr')),
    vi.spyOn(console, 'error').mockImplementation(record('stderr')),
  ]
  return {
    take() {
      const taken = lines
      lines = []
      return taken
    },
    restore() {
      for (const spy of spies) spy.mockRestore()
    },
  }
}

function absoluteEntries(root: string, entries: BuildEntries): string[] | Record<string, string> {
  const absolute = (entry: string): string => (isAbsolute(entry) ? entry : join(root, entry))
  if (typeof entries === 'string') return [absolute(entries)]
  if (Array.isArray(entries)) return entries.map(absolute)
  return Object.fromEntries(Object.entries(entries).map(([name, file]) => [name, absolute(file)]))
}

/**
 * The esbuild options {@link buildWithEsbuild} uses: the plugin first, `absWorkingDir` the fixture
 * copy, ES module output with source maps and a metafile in a new temporary directory.
 */
export async function esbuildOptions(
  fixtureDir: string,
  entries: BuildEntries,
  pluginOptions: Options = {},
  extra: EsbuildBuildOptions = {},
): Promise<BuildOptions & { outdir: string; absWorkingDir: string; metafile: true }> {
  vi.stubEnv('DENO_DIR', await denoDir())
  const { plugins = [], ...rest } = extra
  const outdir = await mkdtemp(join(tmpdir(), 'unplugin-deno-out-'))
  return {
    absWorkingDir: fixtureDir,
    bundle: true,
    format: 'esm',
    entryNames: '[name]',
    chunkNames: 'chunk-[hash]',
    sourcemap: true,
    logLevel: 'silent',
    ...rest,
    outdir,
    metafile: true,
    entryPoints: absoluteEntries(fixtureDir, entries),
    plugins: [denoEsbuild(pluginOptions), ...plugins],
  }
}

/** A module id from a metafile input: absolute for files, `namespace:path` otherwise. */
function moduleId(root: string, input: string): string {
  return /^[a-zA-Z][\w-]+:/.test(input) ? input : resolve(root, input)
}

/** The shared build result from an esbuild result (chunks from the metafile). */
export async function collectResult(
  result: EsbuildResult<{ metafile: true }>,
  options: { outdir: string; absWorkingDir: string },
  logs: BuildLog[],
  durationMs: number,
): Promise<EsbuildBuildResult> {
  const { outdir, absWorkingDir } = options
  const chunks: BuildChunk[] = []
  for (const [file, output] of Object.entries(result.metafile.outputs)) {
    if (!file.endsWith('.js')) continue
    const path = resolve(absWorkingDir, file)
    const inputs = Object.entries(output.inputs)
    chunks.push({
      fileName: relative(outdir, path).replaceAll('\\', '/'),
      code: await readFile(path, 'utf8'),
      isEntry: output.entryPoint !== undefined,
      moduleIds: inputs.map(([input]) => moduleId(absWorkingDir, input)),
      moduleSizes: Object.fromEntries(
        inputs.map(([input, { bytesInOutput }]) => [moduleId(absWorkingDir, input), bytesInOutput]),
      ),
      imports: output.imports.map((item) =>
        item.external ? item.path : relative(outdir, resolve(absWorkingDir, item.path)),
      ),
    })
  }
  const warnings = result.warnings
  const first = chunks.find((chunk) => chunk.isEntry) ?? chunks[0]
  const dispose = (): Promise<void> => rm(outdir, { recursive: true, force: true, maxRetries: 3 })
  return {
    outDir: outdir,
    chunks,
    entry: join(outdir, first?.fileName ?? 'main.js'),
    logs: [
      ...logs,
      ...warnings.map((warning) => ({
        level: 'warn',
        message: warning.text,
        plugin: warning.pluginName,
      })),
    ],
    durationMs,
    metafile: result.metafile,
    warnings,
    dispose,
    [Symbol.asyncDispose]: dispose,
  }
}

/**
 * Builds `entries` of the fixture copy at `fixtureDir` with esbuild and the plugin (placed first),
 * writing ES modules to a temporary directory; the esbuild counterpart of `buildWithRolldown`.
 * `DENO_DIR` is the shared test one; the plugin's stderr lines are captured into `logs`.
 */
export async function buildWithEsbuild(
  fixtureDir: string,
  entries: BuildEntries,
  pluginOptions: Options = {},
  extra: EsbuildBuildOptions = {},
): Promise<EsbuildBuildResult> {
  const options = await esbuildOptions(fixtureDir, entries, pluginOptions, extra)
  const logs = captureLogs()
  const started = performance.now()
  try {
    const result = await build(options)
    return await collectResult(result, options, logs.take(), performance.now() - started)
  } catch (error) {
    await rm(options.outdir, { recursive: true, force: true, maxRetries: 3 })
    throw error
  } finally {
    logs.restore()
  }
}

/** An esbuild context over a fixture copy; each `rebuild()` returns the shared build result. */
export interface EsbuildContextRun extends AsyncDisposable {
  rebuild(): Promise<EsbuildBuildResult>
  /** Disposes the context and removes the output directory. */
  dispose(): Promise<void>
}

/** Creates an esbuild context (`esbuild.context()`) with the options of {@link buildWithEsbuild}. */
export async function contextWithEsbuild(
  fixtureDir: string,
  entries: BuildEntries,
  pluginOptions: Options = {},
  extra: EsbuildBuildOptions = {},
): Promise<EsbuildContextRun> {
  const options = await esbuildOptions(fixtureDir, entries, pluginOptions, extra)
  const logs = captureLogs()
  const ctx = await context(options)
  const dispose = async (): Promise<void> => {
    await ctx.dispose()
    logs.restore()
    await rm(options.outdir, { recursive: true, force: true, maxRetries: 3 })
  }
  return {
    async rebuild() {
      logs.take()
      const started = performance.now()
      const result = await ctx.rebuild()
      return collectResult(result, options, logs.take(), performance.now() - started)
    },
    dispose,
    [Symbol.asyncDispose]: dispose,
  }
}
