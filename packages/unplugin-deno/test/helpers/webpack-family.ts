/**
 * Assertions and runners shared by the webpack, Rspack and Rsbuild integration tests: the entry
 * chunk, expected values, mirror generations and engine loads (debug lines), the infrastructure
 * log lines, running Deno-platform output under `deno run --cached-only`, and watch-mode builds.
 */
import { execFile } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { copyFile, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify, stripVTControlCharacters } from 'node:util'
import { expect } from 'vitest'
import type { BuildLog, BuildResult } from './build.js'
import { testDenoDirPath } from './deno-dir.js'
import type { TempProject } from './temp-project.js'

const execFileAsync = promisify(execFile)

/** The entry chunk of a build. */
export function entryChunk(out: BuildResult): BuildResult['chunks'][number] {
  const chunk = out.chunks.find((item) => item.isEntry)
  if (chunk === undefined) throw new Error('no entry chunk')
  return chunk
}

/** The `expect.values` of a fixture. */
export function expectedValues(project: TempProject): Record<string, unknown> {
  return (project.manifest.expect?.values ?? {}) as Record<string, unknown>
}

/** Paths with `/` separators, for assertions that hold on Windows too. */
export function slashed(ids: readonly string[]): string[] {
  return ids.map((id) => id.replaceAll('\\', '/'))
}

/** The single mirror generation directory of a project (default `cacheDir`). */
export function generationDir(root: string): string {
  const cacheDir = join(root, 'node_modules', '.unplugin-deno')
  const generations = readdirSync(cacheDir).filter((name) => /^[0-9a-f]{8}$/.test(name))
  expect(generations).toHaveLength(1)
  return join(cacheDir, generations[0] ?? '')
}

/** The engine loads of the mirror (`debug: true` output). */
export function mirrorLoads(out: BuildResult): string[] {
  return out.logs
    .map((log) => log.message)
    .filter((message) => message.includes('[mirror] loading '))
}

/** The recorded log lines without terminal colours. */
export function infoLines(logs: readonly BuildLog[]): string[] {
  return logs.map((log) => stripVTControlCharacters(log.message))
}

/** Imports an output file under a new name, so rebuilt output is not served from the cache. */
export async function evaluateCopy<T>(file: string, name: string): Promise<T> {
  const copy = join(dirname(file), `${name}.mjs`)
  await copyFile(file, copy)
  return (await import(pathToFileURL(copy).href)) as T
}

/**
 * Runs the `values` export of a Deno-platform build's `entry` (a file name in the output
 * directory) under `deno run --cached-only`, after `deno cache` fetched its externals into the
 * test `DENO_DIR`.
 */
export async function runUnderDeno(out: BuildResult, entry: string): Promise<unknown> {
  const runner = join(out.outDir, 'run.mjs')
  await writeFile(
    runner,
    `import { values } from './${entry}'\nconsole.log(JSON.stringify(values))\n`,
  )
  const env = { ...process.env, DENO_DIR: testDenoDirPath(), NO_COLOR: '1' }
  await execFileAsync('deno', ['cache', '--quiet', 'run.mjs'], { cwd: out.outDir, env })
  const { stdout } = await execFileAsync('deno', ['run', '-A', '--cached-only', 'run.mjs'], {
    cwd: out.outDir,
    env,
  })
  return JSON.parse(stdout) as unknown
}

/** The text of the CSS files a build emitted. */
export async function emittedCss(out: BuildResult): Promise<string> {
  const files = (await readdir(out.outDir)).filter((file) => file.endsWith('.css')).toSorted()
  const texts = await Promise.all(files.map((file) => readFile(join(out.outDir, file), 'utf8')))
  return texts.join('\n')
}

/** Called by a watching compiler after each build: the error, or the stats' errors as text. */
export type WatchHandler = (error: Error | undefined, errors: string | undefined) => void

/** The values of the builds of a watching compiler (see {@link watchBuilds}). */
export interface WatchBuilds {
  /** Waits for a build whose `values` satisfy `predicate` and returns them. */
  next(predicate: (values: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>
  /**
   * Makes a change with `write` and waits for a build whose `values` satisfy `predicate`, making
   * it again (a new modification time) when no such build came within `retryMs`: a watcher can
   * miss a file written right after a build, before it watches again (seen with Bun).
   */
  after(
    write: () => Promise<void>,
    predicate: (values: Record<string, unknown>) => boolean,
    retryMs?: number,
  ): Promise<Record<string, unknown>>
  /** Stops watching and closes the compiler. */
  close(): Promise<void>
}

/**
 * Records the `values` export of `main.js` in `outDir` after each build of a watching compiler.
 * `start` starts watching with the handler to call after each build and returns the function
 * that stops watching.
 */
export function watchBuilds(
  outDir: string,
  start: (handler: WatchHandler) => () => Promise<void>,
): WatchBuilds {
  const results: Array<{ error?: string; values?: Record<string, unknown> }> = []
  let wake: (() => void) | undefined
  let count = 0
  let queue: Promise<void> = Promise.resolve()
  const stop = start((error, errors) => {
    const build = ++count
    queue = queue.then(async () => {
      if (error !== undefined || errors !== undefined) {
        results.push({ error: error?.message ?? errors })
      } else {
        try {
          const { values } = await evaluateCopy<{ values: Record<string, unknown> }>(
            join(outDir, 'main.js'),
            `build-${build}`,
          )
          results.push({ values })
        } catch (evaluation) {
          results.push({ error: `build ${build} failed to run: ${String(evaluation)}` })
        }
      }
      wake?.()
    })
  })
  /** The values of a build satisfying `predicate`, or `undefined` when none came within `ms`. */
  const waitFor = async (
    predicate: (values: Record<string, unknown>) => boolean,
    ms: number,
  ): Promise<Record<string, unknown> | undefined> => {
    const deadline = performance.now() + ms
    for (;;) {
      const found = results.find(
        (result) => result.values !== undefined && predicate(result.values),
      )
      if (found?.values !== undefined) return found.values
      const failed = results.find((result) => result.error !== undefined)
      if (failed !== undefined) throw new Error(failed.error)
      const remaining = deadline - performance.now()
      if (remaining <= 0) return undefined
      await new Promise<void>((resolve) => {
        // No timer without a deadline (an infinite delay would fire after 1 ms).
        const timer = Number.isFinite(remaining) ? setTimeout(resolve, remaining) : undefined
        wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
    }
  }
  return {
    async next(predicate) {
      const values = await waitFor(predicate, Number.POSITIVE_INFINITY)
      if (values === undefined) throw new Error('unreachable: no deadline')
      return values
    },
    async after(write, predicate, retryMs = 3000) {
      for (let attempt = 1; ; attempt++) {
        await write()
        const values = await waitFor(predicate, retryMs)
        if (values !== undefined) return values
        if (attempt === 20) throw new Error(`no build after ${attempt} attempts to make the change`)
      }
    },
    close: stop,
  }
}
