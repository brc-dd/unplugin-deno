/**
 * Vite test helpers: `buildWithVite` (a library build for the browser or an SSR build of fixture
 * entries, returning the same {@link BuildResult} as `buildWithRolldown`) and `startViteDevServer`
 * (a dev server in middleware mode without a file watcher, with the hot channels spied on and the
 * optimizer runs counted).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, isAbsolute, join } from 'node:path'
import type * as ViteNamespace from 'vite'
import type {
  DevEnvironment,
  InlineConfig,
  Logger,
  PluginOption,
  Rolldown,
  ViteDevServer,
} from 'vite'
import { vi } from 'vitest'
import type { Options } from '../../src/core/options.js'
import deno from '../../src/vite.js'
import type { BuildChunk, BuildEntries, BuildLog, BuildResult } from './build.js'
import { denoDir } from './deno-dir.js'

/** The parts of a Vite module the helpers use: `vite` (8) or the `vite7` alias. */
export type ViteModule = Pick<typeof ViteNamespace, 'build' | 'createServer' | 'version'>

/** Loads Vite 8 (`vite`) or Vite 7 (the `vite7` devDependency alias). */
export async function loadVite(major: 7 | 8 = 8): Promise<ViteModule> {
  if (major === 7) return (await import('vite7')) as unknown as ViteModule
  return import('vite')
}

/** The major version of a Vite module. */
export function viteMajor(vite: ViteModule): number {
  return Number(vite.version.split('.')[0])
}

/** A logger that records warnings and errors as {@link BuildLog}s (and prints nothing). */
export function captureLogger(logs: BuildLog[]): Logger {
  const warned = new Set<string>()
  const logger: Logger = {
    hasWarned: false,
    info: () => {},
    warn(message) {
      logger.hasWarned = true
      logs.push({ level: 'warn', message })
    },
    warnOnce(message) {
      if (warned.has(message)) return
      warned.add(message)
      logger.warn(message)
    },
    error(message) {
      logs.push({ level: 'error', message })
    },
    clearScreen: () => {},
    hasErrorLogged: () => false,
  }
  return logger
}

/** Options of {@link buildWithVite}. */
export interface ViteBuildOptions {
  /**
   * `client` (default): a library build of the client environment (browser platform);
   * `ssr`: an SSR build (`build.ssr`) of the `ssr` server environment.
   */
  environment?: 'client' | 'ssr'
  /** Vite to build with (default: Vite 8). */
  vite?: ViteModule
  /** Plugins placed after unplugin-deno. */
  plugins?: PluginOption[]
  /** Inline config merged over the helper's (not deeply). */
  config?: InlineConfig
}

function namedEntries(root: string, entries: BuildEntries): Record<string, string> {
  const absolute = (entry: string): string => (isAbsolute(entry) ? entry : join(root, entry))
  if (typeof entries === 'string') entries = [entries]
  if (Array.isArray(entries)) {
    return Object.fromEntries(
      entries.map((entry) => [basename(entry, extname(entry)), absolute(entry)]),
    )
  }
  return Object.fromEntries(Object.entries(entries).map(([name, file]) => [name, absolute(file)]))
}

function chunksOf(output: Rolldown.RolldownOutput['output']): BuildChunk[] {
  return output.flatMap((item) =>
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
}

/**
 * Builds `entries` of the fixture copy at `root` with Vite and unplugin-deno (first), writing ES
 * modules named after the entries to a temporary directory. `DENO_DIR` is the shared test one.
 */
export async function buildWithVite(
  root: string,
  entries: BuildEntries,
  pluginOptions: Options = {},
  options: ViteBuildOptions = {},
): Promise<BuildResult> {
  vi.stubEnv('DENO_DIR', await denoDir())
  const vite = options.vite ?? (await loadVite())
  const logs: BuildLog[] = []
  const outDir = await mkdtemp(join(tmpdir(), 'unplugin-deno-out-'))
  const input = namedEntries(root, entries)
  const output = {
    format: 'es' as const,
    entryFileNames: '[name].js',
    chunkFileNames: 'chunk-[hash].js',
  }
  // Vite 8 builds with Rolldown (`rolldownOptions`), Vite 7 with Rollup (`rollupOptions`).
  const bundlerKey = viteMajor(vite) >= 8 ? 'rolldownOptions' : 'rollupOptions'
  const ssr = options.environment === 'ssr'
  const started = performance.now()
  const result = await vite.build({
    root,
    configFile: false,
    logLevel: 'warn',
    customLogger: captureLogger(logs),
    plugins: [deno(pluginOptions), ...(options.plugins ?? [])],
    build: {
      outDir,
      emptyOutDir: true,
      minify: false,
      copyPublicDir: false,
      reportCompressedSize: false,
      ...(ssr
        ? { ssr: true, [bundlerKey]: { input, output } }
        : {
            lib: {
              entry: input,
              formats: ['es'],
              fileName: (_format, name) => `${name}.js`,
              // Fixtures have no package.json name to derive a CSS file name from.
              cssFileName: 'style',
            },
            [bundlerKey]: { output },
          }),
    },
    ...options.config,
  })
  const outputs = (Array.isArray(result) ? result : [result]) as Rolldown.RolldownOutput[]
  const chunks = outputs.flatMap((item) => ('output' in item ? chunksOf(item.output) : []))
  const durationMs = performance.now() - started
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

/** Options of {@link startViteDevServer}. */
export interface ViteDevOptions {
  /** Vite to serve with (default: Vite 8). */
  vite?: ViteModule
  /** Plugins placed after unplugin-deno. */
  plugins?: PluginOption[]
  /** Inline config merged over the helper's (not deeply). */
  config?: InlineConfig
}

/** A running dev server (see {@link startViteDevServer}). */
export interface ViteDevServerHandle extends AsyncDisposable {
  server: ViteDevServer
  /** Payloads sent on each environment's hot channel, by environment name. */
  sent: Record<string, unknown[]>
  logs: BuildLog[]
  /** How often the client environment's dependency optimizer bundled. */
  optimizerRuns(): number
  /**
   * Requests `url` and, like a browser, every module it imports statically (prebundled
   * dependencies included), in the client environment; returns the code by URL.
   */
  crawl(url: string): Promise<Map<string, string>>
  /** Waits until the client environment's optimizer has committed what it discovered. */
  settle(): Promise<void>
  /** Closes the server once the optimizer has settled. */
  close(): Promise<void>
}

/** Whether a bundle's plugins are those of Vite's dependency scan (`vite:dep-scan*`). */
function isScan(plugins: readonly unknown[] | undefined): boolean {
  return (plugins ?? []).some(
    (plugin) =>
      typeof plugin === 'object' &&
      plugin !== null &&
      String((plugin as { name?: unknown }).name).startsWith('vite:dep-scan'),
  )
}

/**
 * Starts a dev server for the fixture copy at `root` in middleware mode, without a file watcher
 * (tests emit watcher events themselves) and without a WebSocket server. `DENO_DIR` is the
 * shared test one.
 */
export async function startViteDevServer(
  root: string,
  pluginOptions: Options = {},
  options: ViteDevOptions = {},
): Promise<ViteDevServerHandle> {
  vi.stubEnv('DENO_DIR', await denoDir())
  const vite = options.vite ?? (await loadVite())
  const logs: BuildLog[] = []
  let runs = 0
  // Counts optimizer bundles: a Rolldown plugin on Vite 8 (the dependency scan runs the
  // optimizer's plugins too, next to its own `vite:dep-scan:*` plugins), an esbuild plugin on
  // Vite 7 (whose scan has a `vite:dep-scan` plugin).
  const counter: Rolldown.Plugin = {
    name: 'test:optimizer-runs',
    buildStart(input) {
      if (!isScan(input.plugins)) runs += 1
    },
  }
  const optimizeDeps =
    viteMajor(vite) >= 8
      ? { rolldownOptions: { plugins: [counter] } }
      : {
          esbuildOptions: {
            plugins: [
              {
                name: 'test:optimizer-runs',
                setup(build: {
                  initialOptions: { plugins?: unknown[] }
                  onStart(callback: () => void): void
                }) {
                  if (isScan(build.initialOptions.plugins)) return
                  build.onStart(() => {
                    runs += 1
                  })
                },
              },
            ],
          },
        }
  const server = await vite.createServer({
    root,
    configFile: false,
    logLevel: 'warn',
    customLogger: captureLogger(logs),
    appType: 'custom',
    plugins: [deno(pluginOptions), ...(options.plugins ?? [])],
    server: { middlewareMode: true, watch: null, ws: false },
    optimizeDeps: optimizeDeps as InlineConfig['optimizeDeps'],
    ...options.config,
  })
  const sent: Record<string, unknown[]> = {}
  for (const [name, environment] of Object.entries(server.environments)) {
    const payloads: unknown[] = []
    sent[name] = payloads
    const send = environment.hot.send.bind(environment.hot)
    vi.spyOn(environment.hot, 'send').mockImplementation((...args: unknown[]) => {
      payloads.push(args[0])
      ;(send as (...rest: unknown[]) => void)(...args)
    })
  }
  const client = server.environments.client as DevEnvironment
  // Vite does not wait for a running optimizer bundle when it closes (it removes its output
  // directory, and the bundle then fails to write there): let the optimizer settle first.
  const close = async (): Promise<void> => {
    await settle(client)
    await server.close()
  }
  return {
    server,
    sent,
    logs,
    optimizerRuns: () => runs,
    crawl: (url) => crawl(client, url),
    settle: () => settle(client),
    close,
    [Symbol.asyncDispose]: close,
  }
}

/**
 * Waits (at most 30 s) until the optimizer of `environment` has committed every dependency it
 * discovered: after the scan, Vite commits the first run once no request has been pending for a
 * moment.
 */
async function settle(environment: DevEnvironment): Promise<void> {
  const optimizer = environment.depsOptimizer
  if (optimizer === undefined) return
  const deadline = Date.now() + 30_000
  await optimizer.scanProcessing
  while (Date.now() < deadline) {
    const pending = Object.values(optimizer.metadata.discovered).flatMap((info) =>
      info.processing === undefined ? [] : [info.processing],
    )
    if (pending.length === 0) return
    await Promise.race([Promise.all(pending), new Promise((resolve) => setTimeout(resolve, 1000))])
  }
}

async function crawl(environment: DevEnvironment, entry: string): Promise<Map<string, string>> {
  const codes = new Map<string, string>()
  const queue = [entry]
  while (queue.length > 0) {
    const url = queue.shift() ?? ''
    if (codes.has(url)) continue
    const result = await environment.transformRequest(url)
    codes.set(url, result?.code ?? '')
    const node = await environment.moduleGraph.getModuleByUrl(url)
    for (const imported of node?.importedModules ?? []) {
      if (!codes.has(imported.url)) queue.push(imported.url)
    }
  }
  return codes
}
