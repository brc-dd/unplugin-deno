/**
 * What the webpack-family builders (`buildWithWebpack`, `buildWithRspack`, `buildWithRsbuild`)
 * share: the {@link BuildResult} from webpack-compatible stats (webpack and Rspack both produce
 * them), the builders' output settings, and the capture of infrastructure log lines.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, isAbsolute, join } from 'node:path'
import type { BuildChunk, BuildEntries, BuildLog, BuildResult } from './build.js'

/** The parts of a stats module the helpers read (webpack's `StatsModule`, Rspack's). */
export interface StatsModuleLike {
  identifier?: string | undefined
  name?: string | undefined
  nameForCondition?: string | undefined
  size?: number | undefined
  moduleType?: string | undefined
  /** Modules concatenated into this one (`nestedModules: true`). */
  modules?: StatsModuleLike[] | undefined
}

/** The parts of a stats chunk the helpers read. */
export interface StatsChunkLike {
  files?: string[] | undefined
  entry?: boolean | undefined
  initial?: boolean | undefined
  modules?: StatsModuleLike[] | undefined
}

/** A stats message (webpack: `{ message }`; Rspack: the same). */
export interface StatsErrorLike {
  message: string
  moduleName?: string | undefined
}

/** The stats JSON the helpers read (`stats.toJson(STATS_OPTIONS)`). */
export interface StatsJsonLike {
  chunks?: StatsChunkLike[] | undefined
  errors?: StatsErrorLike[] | undefined
  warnings?: StatsErrorLike[] | undefined
}

/** The `toJson` options that produce {@link StatsJsonLike}. */
export const STATS_OPTIONS = {
  all: false,
  chunks: true,
  chunkModules: true,
  nestedModules: true,
  ids: true,
  errors: true,
  warnings: true,
  moduleTrace: false,
  errorDetails: false,
  // Every module on its own: by default all but a few are grouped into summaries without ids.
  chunkModulesSpace: Number.POSITIVE_INFINITY,
  nestedModulesSpace: Number.POSITIVE_INFINITY,
  groupModulesByAttributes: false,
  groupModulesByCacheStatus: false,
  groupModulesByLayer: false,
  groupModulesByPath: false,
  groupModulesByType: false,
  groupModulesByExtension: false,
  excludeModules: false,
  runtimeModules: true,
  dependentModules: true,
  orphanModules: true,
  cachedModules: true,
} as const

/** A webpack external's module identifier: `external <type> "<request>"`. */
const EXTERNAL = /^external (?:[\w-]+ )?("(?:[^"\\]|\\.)*")/

/** The request an external module keeps, or `undefined` for other modules. */
export function externalRequest(module: StatsModuleLike): string | undefined {
  const match = EXTERNAL.exec(module.identifier ?? '')
  return match?.[1] === undefined ? undefined : (JSON.parse(match[1]) as string)
}

function flatten(modules: readonly StatsModuleLike[]): StatsModuleLike[] {
  return modules.flatMap((module) =>
    module.modules === undefined || module.modules.length === 0
      ? [module]
      : flatten(module.modules),
  )
}

/**
 * The chunks of a build from its stats: the chunk's JavaScript file, the modules bundled into it
 * (`nameForCondition`: absolute paths for files, the resource for synthesised modules) with their
 * source sizes, and the requests of its externals as `imports`.
 */
export async function chunksFromStats(json: StatsJsonLike, outDir: string): Promise<BuildChunk[]> {
  const chunks: BuildChunk[] = []
  for (const chunk of json.chunks ?? []) {
    const fileName = (chunk.files ?? []).find((file) => /\.[cm]?js$/.test(file))
    if (fileName === undefined) continue
    const modules = flatten(chunk.modules ?? []).filter(
      (module) =>
        module.moduleType !== 'runtime' && !module.identifier?.startsWith('webpack/runtime'),
    )
    const imports: string[] = []
    const moduleIds: string[] = []
    const moduleSizes: Record<string, number> = {}
    for (const module of modules) {
      const external = externalRequest(module)
      if (external !== undefined) {
        imports.push(external)
        continue
      }
      const id = module.nameForCondition ?? module.identifier ?? module.name ?? ''
      moduleIds.push(id)
      moduleSizes[id] = (moduleSizes[id] ?? 0) + (module.size ?? 0)
    }
    chunks.push({
      fileName,
      code: await readFile(join(outDir, fileName), 'utf8'),
      isEntry: chunk.entry === true,
      moduleIds,
      moduleSizes,
      imports,
    })
  }
  return chunks
}

/** A build that failed: the host's error messages and the modules they were reported for. */
export class HostBuildError extends Error {
  readonly errors: string[]
  /** The readable name of the module of each error (`./src/main.ts`), when there is one. */
  readonly modules: string[]
  constructor(host: string, errors: readonly StatsErrorLike[]) {
    super(`${host} build failed:\n${errors.map((error) => error.message).join('\n')}`)
    this.name = 'HostBuildError'
    this.errors = errors.map((error) => error.message)
    this.modules = errors.flatMap((error) =>
      error.moduleName === undefined ? [] : [error.moduleName],
    )
  }
}

/** The shared result from the chunks of a finished build (removes `outDir` on dispose). */
export function buildResult(
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

/** A new temporary output directory. */
export function outputDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'unplugin-deno-out-'))
}

/**
 * Entry modules as a webpack `entry` object: absolute paths named after the file
 * (`src/main.ts` → `main`), or the given names.
 */
export function entryObject(root: string, entries: BuildEntries): Record<string, string> {
  const absolute = (entry: string): string => (isAbsolute(entry) ? entry : join(root, entry))
  if (typeof entries === 'string') entries = [entries]
  if (Array.isArray(entries)) {
    return Object.fromEntries(
      entries.map((entry) => [basename(entry, extname(entry)), absolute(entry)]),
    )
  }
  return Object.fromEntries(Object.entries(entries).map(([name, file]) => [name, absolute(file)]))
}

/** Discards a console call. */
function ignore(): void {}

/**
 * A console for webpack's and Rspack's `infrastructureLogging.console` that records the lines of
 * the `[unplugin-deno]` infrastructure logger (`<level> [unplugin-deno] <message>`).
 */
export function captureConsole(logs: BuildLog[]): Console {
  const record =
    (level: string) =>
    (...args: unknown[]): void => {
      const message = args.map(String).join(' ')
      if (message.includes('unplugin-deno')) logs.push({ level, message })
    }
  const target = {
    log: record('log'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug'),
    trace: ignore,
    group: record('info'),
    groupCollapsed: record('info'),
    groupEnd: ignore,
    profile: ignore,
    profileEnd: ignore,
    clear: ignore,
    status: record('info'),
  }
  return target as unknown as Console
}
