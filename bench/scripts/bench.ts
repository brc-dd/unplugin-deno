/**
 * Builds a ~50-module Vite 8 app that imports JSR and npm packages, in three setups, and prints
 * Markdown tables of the medians (see README.md):
 *
 * - (a) npm: the packages installed in node_modules (JSR ones from npm.jsr.io), no plugin;
 * - (b) unplugin-deno with a cold mirror (the mirror directory is removed before each run);
 * - (c) unplugin-deno with a warm mirror.
 *
 * Then the dev server's first request and full page load, for (a) and (c), with Vite's
 * dependency cache removed before each run. Every run is a fresh process (scripts/vite.ts).
 * Downloads are not measured: a warm-up build fills `DENO_DIR` first.
 *
 * Usage: `pnpm bench` (repository root) or `pnpm --filter bench run bench`; `BENCH_RUNS=10` for
 * more runs, `DENO_DIR` to use another Deno cache.
 */
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { version as viteVersion } from 'vite'
import { FEATURES, writeProject } from './project.ts'

// The plugin is a workspace package: build it once after a fresh clone (`pnpm bench` at the
// repository root always builds it first).
const plugin = dirname(fileURLToPath(import.meta.resolve('unplugin-deno/package.json')))
if (!existsSync(join(plugin, 'dist'))) {
  execSync('pnpm --filter unplugin-deno build', { stdio: 'inherit' })
}

const RUNS = Number(process.env.BENCH_RUNS ?? 5)
const work = join(tmpdir(), 'unplugin-deno-bench')
const roots = { npm: join(work, 'npm'), deno: join(work, 'deno') }
const env = { ...process.env, DENO_DIR: process.env.DENO_DIR || join(work, 'deno-dir') }
const runner = fileURLToPath(new URL('vite.ts', import.meta.url))

type Variant = keyof typeof roots
interface BuildRun {
  ms: number
  bytes: number
}
interface DevRun {
  first: number
  page: number
  modules: number
}

/** Runs scripts/vite.ts in a new process of the current runtime. */
function run<T>(mode: 'build' | 'dev', variant: Variant): T {
  const args = [runner, mode, roots[variant], variant]
  const argv = process.versions.deno ? ['run', '-A', ...args] : args
  const output = execFileSync(process.execPath, argv, { env, encoding: 'utf8' })
  return JSON.parse(output.trim().split('\n').at(-1) ?? '') as T
}

/** What {@link clean} removes: build output, Vite's cache, the plugin's mirror. */
const outputs = { dist: 'dist', '.vite': '.vite', mirror: join('node_modules', '.unplugin-deno') }

function clean(variant: Variant, ...names: Array<keyof typeof outputs>): void {
  for (const name of names) {
    rmSync(join(roots[variant], outputs[name]), { recursive: true, force: true, maxRetries: 3 })
  }
}

function median(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

/** `median ms (min–max)`. */
function ms(values: number[]): string {
  const [low, mid, high] = [Math.min(...values), median(values), Math.max(...values)].map(
    Math.round,
  )
  return `${mid} ms (${low}–${high})`
}

function progress(text: string): void {
  process.stderr.write(`${text}\n`)
}

writeProject(roots.npm, 'npm')
writeProject(roots.deno, 'deno')

progress(`warming up (DENO_DIR ${env.DENO_DIR})`)
clean('npm', 'dist', '.vite')
run('build', 'npm')
clean('deno', 'dist', '.vite', 'mirror')
run('build', 'deno')

const builds: Record<'npm' | 'cold' | 'warm', BuildRun[]> = { npm: [], cold: [], warm: [] }
for (let index = 1; index <= RUNS; index++) {
  progress(`build run ${index}/${RUNS}`)
  clean('npm', 'dist')
  builds.npm.push(run('build', 'npm'))
  clean('deno', 'dist', 'mirror')
  builds.cold.push(run('build', 'deno'))
  clean('deno', 'dist')
  builds.warm.push(run('build', 'deno'))
}

const dev: Record<Variant, DevRun[]> = { npm: [], deno: [] }
for (let index = 1; index <= RUNS; index++) {
  progress(`dev server run ${index}/${RUNS}`)
  for (const variant of ['npm', 'deno'] as const) {
    clean(variant, '.vite')
    dev[variant].push(run('dev', variant))
  }
}

const cpu = cpus()[0]?.model ?? 'unknown CPU'
const runtime = process.versions.deno
  ? `Deno ${process.versions.deno}`
  : process.versions.bun
    ? `Bun ${process.versions.bun}`
    : `Node.js ${process.versions.node}`
const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KiB`
const lines = [
  `${FEATURES + 1} modules, Vite ${viteVersion}, ${runtime}, ${platform()} ${release()} ${arch()}, ` +
    `${cpu} (${cpus().length} threads), ${Math.round(totalmem() / 2 ** 30)} GiB; ` +
    `median of ${RUNS} runs (min–max)`,
  '',
  '| `vite build` | Time | JS output |',
  '| --- | --- | --- |',
  `| (a) npm packages in node_modules, no plugin | ${ms(builds.npm.map((r) => r.ms))} | ${kb(builds.npm[0]!.bytes)} |`,
  `| (b) unplugin-deno, cold mirror | ${ms(builds.cold.map((r) => r.ms))} | ${kb(builds.cold[0]!.bytes)} |`,
  `| (c) unplugin-deno, warm mirror | ${ms(builds.warm.map((r) => r.ms))} | ${kb(builds.warm[0]!.bytes)} |`,
  '',
  '| Dev server, cold dependency cache | First request (`/src/main.ts`) | Full page | Modules |',
  '| --- | --- | --- | --- |',
  `| (a) npm packages in node_modules, no plugin | ${ms(dev.npm.map((r) => r.first))} | ${ms(dev.npm.map((r) => r.page))} | ${dev.npm[0]!.modules} |`,
  `| (c) unplugin-deno, warm mirror | ${ms(dev.deno.map((r) => r.first))} | ${ms(dev.deno.map((r) => r.page))} | ${dev.deno[0]!.modules} |`,
]
process.stdout.write(`${lines.join('\n')}\n`)
