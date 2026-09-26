/**
 * Transpiling TypeScript and JSX for the `deno` engine with `deno transpile` (Deno 2.8+, still
 * marked experimental; docs/architecture.md §4.3). It only accepts local files, so each batch
 * writes the sources to a private directory next to a `deno.json` holding the project's root
 * `compilerOptions` (Deno applies a config's JSX settings only to files inside its directory),
 * runs one `deno transpile --outdir … --source-map separate` for the whole batch and reads the
 * results back. Verified with Deno 2.9.7: the code and source maps equal the vendored loader's
 * emit (same `deno_ast` transform), without the inline `sourceMappingURL` comment.
 *
 * One file with a syntax error fails the whole call, so a failed batch is split in halves until
 * the failing modules are isolated.
 *
 * @module
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Logger } from '../../diagnostics/logger.js'
import { toFileUrl } from '../../utils/path.js'
import type { EncodedSourceMap, MediaType } from '../types.js'
import { parseDenoStderr } from './info.js'
import { denoEnv, runDeno } from './process.js'

/** Media types `deno transpile` turns into JavaScript, with the input and output extensions. */
const EXTENSIONS: Readonly<Partial<Record<MediaType, readonly [input: string, output: string]>>> = {
  TypeScript: ['.ts', '.js'],
  Tsx: ['.tsx', '.js'],
  Jsx: ['.jsx', '.js'],
  Mts: ['.mts', '.mjs'],
  Cts: ['.cts', '.cjs'],
}

/** Whether modules of `mediaType` are transpiled before bundlers get them. */
export function needsTranspile(mediaType: MediaType): boolean {
  return EXTENSIONS[mediaType] !== undefined
}

/** A module to transpile. */
export interface TranspileItem {
  /** The module URL (becomes `sources[0]` of the source map). */
  url: string
  mediaType: MediaType
  /** The source, exactly as Deno hashes it for `deno.lock`. */
  source: Uint8Array
}

/** A transpiled module. */
export interface TranspileOutput {
  /** JavaScript, without a `sourceMappingURL` comment. */
  code: string
  /** `sources: [url]`, with `sourcesContent`. */
  map: EncodedSourceMap
}

/** `deno transpile` failed for one module; `message` is Deno's explanation. */
export class TranspileError extends Error {
  override readonly name = 'TranspileError'
  readonly url: string

  constructor(url: string, message: string) {
    super(message)
    this.url = url
  }
}

/** Options of {@link Transpiler}. */
export interface TranspilerOptions {
  binary: string
  /** The environment of each run (read at run time, so `DENO_DIR` changes apply). */
  env: () => NodeJS.ProcessEnv
  /** A private directory for inputs and outputs (the engine removes it on dispose). */
  workDir: () => Promise<string>
  /** The project's root `compilerOptions`, or `undefined` for Deno's defaults. */
  compilerOptions: () => Promise<Record<string, unknown> | undefined>
  logger: Logger
  /** Wait before a batch runs, to collect concurrent requests (ms). */
  batchDelayMs: number
  /** Kills a `deno transpile` that runs longer (ms). */
  timeoutMs: number
}

/** Files per `deno transpile` call (short relative names keep the command line small). */
const MAX_BATCH = 400
/**
 * Failed `deno transpile` runs an engine splits batches for (about `2 × log2(n)` per syntax error)
 * before it stops splitting and rejects whole batches.
 */
const MAX_FAILED_RUNS = 32

interface Pending {
  item: TranspileItem
  resolve: (output: TranspileOutput) => void
  reject: (error: unknown) => void
}

/** Batches and caches `deno transpile` runs for one engine. */
export class Transpiler {
  readonly #options: TranspilerOptions
  readonly #results = new Map<string, Promise<TranspileOutput>>()
  #queue: Pending[] = []
  #timer: NodeJS.Timeout | undefined
  #chain: Promise<void> = Promise.resolve()
  #runs = 0
  #failedRuns = 0

  constructor(options: TranspilerOptions) {
    this.#options = options
  }

  /** Whether `url` was transpiled or is queued. */
  has(url: string): boolean {
    return this.#results.has(url)
  }

  /** Transpiles `item`, batched with the other requests of the next few milliseconds. */
  transpile(item: TranspileItem): Promise<TranspileOutput> {
    this.queue([item])
    return this.#results.get(item.url) ?? Promise.reject(new TranspileError(item.url, 'lost'))
  }

  /** Queues modules that will be needed soon (their failures surface when they are requested). */
  queue(items: readonly TranspileItem[]): void {
    for (const item of items) {
      if (this.#results.has(item.url)) continue
      const result = new Promise<TranspileOutput>((resolve, reject) => {
        this.#queue.push({ item, resolve, reject })
      })
      result.catch(() => {})
      this.#results.set(item.url, result)
    }
    if (this.#queue.length > 0)
      this.#timer ??= setTimeout(() => this.#flush(), this.#options.batchDelayMs)
  }

  /** Waits until every queued run has finished. */
  async idle(): Promise<void> {
    while (this.#queue.length > 0 || this.#timer !== undefined) {
      if (this.#timer !== undefined) {
        clearTimeout(this.#timer)
        this.#flush()
      }
      await this.#chain
    }
    await this.#chain
  }

  #flush(): void {
    this.#timer = undefined
    const pending = this.#queue
    this.#queue = []
    for (let start = 0; start < pending.length; start += MAX_BATCH) {
      const batch = pending.slice(start, start + MAX_BATCH)
      this.#chain = this.#chain.then(() => this.#run(batch)).catch(() => {})
    }
  }

  /**
   * Runs one batch; on failure splits it until each failing module is known. After
   * {@link MAX_FAILED_RUNS} failed runs (every module failing: `deno transpile` itself is broken)
   * whole batches are rejected instead of split.
   */
  async #run(batch: readonly Pending[]): Promise<void> {
    let outputs: Map<string, TranspileOutput> | TranspileError
    try {
      outputs = await this.#transpile(batch.map((pending) => pending.item))
    } catch (error) {
      for (const pending of batch) pending.reject(error)
      return
    }
    if (outputs instanceof TranspileError) {
      this.#failedRuns++
      if (batch.length === 1 || this.#failedRuns > MAX_FAILED_RUNS) {
        for (const pending of batch) {
          pending.reject(
            batch.length === 1 ? outputs : new TranspileError(pending.item.url, outputs.message),
          )
        }
        return
      }
      const middle = Math.ceil(batch.length / 2)
      await this.#run(batch.slice(0, middle))
      await this.#run(batch.slice(middle))
      return
    }
    for (const pending of batch) {
      const output = outputs.get(pending.item.url)
      if (output === undefined) {
        pending.reject(
          new TranspileError(pending.item.url, 'deno transpile produced no output for it.'),
        )
      } else {
        pending.resolve(output)
      }
    }
  }

  /**
   * One `deno transpile` call. Resolves to the outputs by URL, or to a {@link TranspileError}
   * (for the first item) when Deno failed.
   */
  async #transpile(
    items: readonly TranspileItem[],
  ): Promise<Map<string, TranspileOutput> | TranspileError> {
    const started = performance.now()
    const dir = join(await this.#options.workDir(), `transpile-${++this.#runs}`)
    const input = join(dir, 'in')
    const output = join(dir, 'out')
    try {
      await mkdir(input, { recursive: true })
      const compilerOptions = await this.#options.compilerOptions()
      await writeFile(
        join(input, 'deno.json'),
        JSON.stringify(compilerOptions === undefined ? {} : { compilerOptions }),
      )
      const names = items.map(
        (item, index) => `m${index}${EXTENSIONS[item.mediaType]?.[0] ?? '.ts'}`,
      )
      await Promise.all(
        items.map((item, index) => writeFile(join(input, names[index] ?? ''), item.source)),
      )
      const result = await runDeno(
        this.#options.binary,
        [
          'transpile',
          '--config',
          join(input, 'deno.json'),
          '--outdir',
          output,
          '--source-map',
          'separate',
          ...names,
        ],
        { cwd: input, env: denoEnv(this.#options.env()), timeoutMs: this.#options.timeoutMs },
      )
      if (result.exitCode !== 0) {
        const first = items[0]
        const stderr = parseDenoStderr(result.stderr)
        let message = result.timedOut
          ? `deno transpile did not finish within ${Math.round(this.#options.timeoutMs / 1000)} s.`
          : stderr.error || `deno transpile exited with code ${String(result.exitCode)}.`
        if (items.length === 1 && first !== undefined) {
          const file = join(input, names[0] ?? '')
          message = message.replaceAll(toFileUrl(file), first.url).replaceAll(file, first.url)
        }
        return new TranspileError(first?.url ?? '', message)
      }
      const outputs = new Map<string, TranspileOutput>()
      await Promise.all(
        items.map(async (item, index) => {
          const name = names[index] ?? ''
          const outName = `${name.slice(0, name.lastIndexOf('.'))}${EXTENSIONS[item.mediaType]?.[1] ?? '.js'}`
          let code: string
          let mapText: string
          try {
            code = await readFile(join(output, outName), 'utf8')
            mapText = await readFile(join(output, `${outName}.map`), 'utf8')
          } catch {
            return
          }
          const map = toSourceMap(mapText, item.url)
          if (map !== undefined) outputs.set(item.url, { code: stripMapComment(code), map })
        }),
      )
      this.#options.logger.debug(
        `[engine] deno transpile: ${items.length} module(s) in ${Math.round(performance.now() - started)} ms`,
      )
      return outputs
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
    }
  }
}

/** Parses a `deno transpile` source map and points it at the module URL. */
function toSourceMap(text: string, url: string): EncodedSourceMap | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (raw.version !== 3 || typeof raw.mappings !== 'string' || !Array.isArray(raw.names)) {
    return undefined
  }
  const sourcesContent = Array.isArray(raw.sourcesContent)
    ? raw.sourcesContent.map((entry) => (typeof entry === 'string' ? entry : null))
    : undefined
  const names = raw.names.filter((entry): entry is string => typeof entry === 'string')
  return sourcesContent === undefined
    ? { version: 3, sources: [url], names, mappings: raw.mappings }
    : { version: 3, sources: [url], sourcesContent, names, mappings: raw.mappings }
}

/** Removes a trailing `//# sourceMappingURL=` line (separate maps get none today). */
function stripMapComment(code: string): string {
  const index = code.lastIndexOf('//# sourceMappingURL=')
  if (index === -1 || (index > 0 && code[index - 1] !== '\n')) return code
  if (code.slice(index).trimEnd().includes('\n')) return code
  return code.slice(0, index)
}
