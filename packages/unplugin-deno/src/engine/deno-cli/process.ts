/**
 * Running the Deno CLI for the `deno` engine (docs/architecture.md §4.3): spawning with a timeout
 * and cancellation (never `spawnSync`), the version gate (Deno ≥ 2.8.3, probed once per binary and
 * process) and Deno's cache directories.
 *
 * @module
 */
import { spawn } from 'node:child_process'
import { stripVTControlCharacters } from 'node:util'
import { DenoPluginError } from '../../diagnostics/errors.js'

/**
 * The oldest Deno the `deno` engine supports: 2.8.3 added `npmPackages[*].localPath` to
 * `deno info --json` (denoland/deno#34806), and 2.8.0 added `deno transpile`.
 */
export const MIN_DENO_VERSION = '2.8.3'

/** The default `denoBinary`. */
export const DEFAULT_DENO_BINARY = 'deno'

/** Options of {@link runDeno}. */
export interface DenoRunOptions {
  /** Working directory of the subprocess. */
  cwd?: string | undefined
  /** Environment of the subprocess (default: `process.env`). */
  env?: NodeJS.ProcessEnv | undefined
  /** Kills the subprocess after this many milliseconds (default: no limit). */
  timeoutMs?: number | undefined
  /** Kills the subprocess when aborted. */
  signal?: AbortSignal | undefined
}

/** The outcome of a finished (or killed) subprocess. */
export interface DenoRunResult {
  /** Exit code; `null` when the process was killed by a signal. */
  exitCode: number | null
  /** stdout, as bytes (`deno info --json` output can be several megabytes). */
  stdout: Buffer
  /** stderr as text, without terminal colors. */
  stderr: string
  /** The subprocess was killed because {@link DenoRunOptions.timeoutMs} elapsed. */
  timedOut: boolean
  /** The subprocess was killed because {@link DenoRunOptions.signal} was aborted. */
  aborted: boolean
}

/** The Deno binary could not be started (`code` is the system error code, e.g. `ENOENT`). */
export class DenoSpawnError extends Error {
  override readonly name = 'DenoSpawnError'
  readonly code: string

  constructor(binary: string, code: string, cause: unknown) {
    super(`Cannot run ${binary}: ${code}`, { cause })
    this.code = code
  }
}

/** Grace period between SIGTERM and SIGKILL for a subprocess that must stop. */
const KILL_GRACE_MS = 2_000

/**
 * Runs `binary` with `args` and collects its output. Resolves when the process has exited and its
 * pipes are closed; a timeout or an abort kills it (SIGTERM, then SIGKILL) and still resolves, with
 * `timedOut`/`aborted` set, so no subprocess outlives its caller.
 *
 * On Windows a `.cmd`/`.bat` binary (the npm `deno` shim) runs through the shell, with every
 * argument quoted.
 *
 * @throws {DenoSpawnError} When the process cannot be started (missing binary, permissions).
 */
export function runDeno(
  binary: string,
  args: readonly string[],
  options: DenoRunOptions = {},
): Promise<DenoRunResult> {
  return new Promise((resolve, reject) => {
    const shell = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(binary)
    const command = shell ? quoteForCmd(binary) : binary
    const argv = shell ? args.map(quoteForCmd) : [...args]
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, argv, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell,
        windowsHide: true,
      })
    } catch (error) {
      reject(new DenoSpawnError(binary, errorCode(error), error))
      return
    }
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let timedOut = false
    let aborted = false
    let settled = false
    let killTimer: NodeJS.Timeout | undefined
    const stop = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      killTimer ??= setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, KILL_GRACE_MS)
      // Deno's global timers are numbers without `unref`.
      killTimer.unref?.()
    }
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            stop()
          }, options.timeoutMs)
    const onAbort = (): void => {
      aborted = true
      stop()
    }
    if (options.signal?.aborted === true) onAbort()
    else options.signal?.addEventListener('abort', onAbort, { once: true })
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      if (killTimer !== undefined) clearTimeout(killTimer)
      options.signal?.removeEventListener('abort', onAbort)
    }
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(new DenoSpawnError(binary, errorCode(error), error))
    })
    child.once('close', (exitCode) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout),
        stderr: stripVTControlCharacters(Buffer.concat(stderr).toString('utf8')),
        timedOut,
        aborted,
      })
    })
  })
}

/** Quotes an argument for `cmd.exe` (used only for `.cmd`/`.bat` binaries). */
function quoteForCmd(arg: string): string {
  if (arg !== '' && !/[\s"&|<>^%!()]/.test(arg)) return arg
  return `"${arg.replaceAll('"', '""')}"`
}

function errorCode(error: unknown): string {
  const code: unknown =
    typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
  return typeof code === 'string' ? code : 'UNKNOWN'
}

/**
 * The environment for Deno subprocesses: the current one without terminal colors, update checks
 * or prompts. `DENO_DIR`, `DENO_AUTH_TOKENS`, proxies and certificates pass through.
 */
export function denoEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    NO_COLOR: '1',
    DENO_NO_UPDATE_CHECK: '1',
    DENO_NO_PROMPT: '1',
  }
  delete env.FORCE_COLOR
  return env
}

/**
 * The version in `deno --version` output (`deno 2.9.7 (stable, release, …)`), or `undefined`.
 * Canary builds (`deno 2.9.7+abc1234`) report their base version.
 */
export function parseDenoVersion(output: string): string | undefined {
  return /^deno (\d+\.\d+\.\d+)/m.exec(output)?.[1]
}

/** Compares two `major.minor.patch` versions numerically (`-1`, `0` or `1`). */
export function compareVersions(a: string, b: string): number {
  const left = versionParts(a)
  const right = versionParts(b)
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference < 0 ? -1 : 1
  }
  return 0
}

function versionParts(version: string): number[] {
  return version.split('.').map((part) => Number.parseInt(part, 10) || 0)
}

/** Whether the `deno` engine supports this Deno version (≥ {@link MIN_DENO_VERSION}). */
export function isSupportedDenoVersion(version: string): boolean {
  return compareVersions(version, MIN_DENO_VERSION) >= 0
}

/** The result of {@link probeDeno}. */
export type DenoProbe =
  | { readonly ok: true; readonly binary: string; readonly version: string }
  | {
      readonly ok: false
      readonly binary: string
      /** `missing`: not installed or not on `PATH`; `too-old`: below 2.8.3; `failed`: other. */
      readonly problem: 'missing' | 'too-old' | 'failed'
      readonly version?: string | undefined
      /** One sentence explaining the problem. */
      readonly message: string
    }

/** Timeout of `deno --version` and `deno info --json` without a module. */
const PROBE_TIMEOUT_MS = 30_000

const probes = new Map<string, Promise<DenoProbe>>()

/**
 * Checks that `binary` runs and is recent enough, once per binary and process (the result is
 * cached, also when the binary is missing). Never rejects.
 */
export function probeDeno(
  binary: string = DEFAULT_DENO_BINARY,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DenoProbe> {
  let probe = probes.get(binary)
  if (probe === undefined) {
    probe = runProbe(binary, env)
    probes.set(binary, probe)
  }
  return probe
}

/** Forgets the cached {@link probeDeno} results (tests). */
export function clearDenoProbes(): void {
  probes.clear()
}

async function runProbe(binary: string, env: NodeJS.ProcessEnv): Promise<DenoProbe> {
  let result: DenoRunResult
  try {
    result = await runDeno(binary, ['--version'], {
      env: denoEnv(env),
      timeoutMs: PROBE_TIMEOUT_MS,
    })
  } catch (error) {
    const missing = error instanceof DenoSpawnError && error.code === 'ENOENT'
    return {
      ok: false,
      binary,
      problem: missing ? 'missing' : 'failed',
      message: missing
        ? `The Deno CLI (\`${binary}\`) was not found.`
        : `The Deno CLI (\`${binary}\`) cannot be run: ${error instanceof Error ? error.message : String(error)}.`,
    }
  }
  const version = parseDenoVersion(result.stdout.toString('utf8'))
  if (result.exitCode !== 0 || version === undefined) {
    return {
      ok: false,
      binary,
      problem: 'failed',
      message: `\`${binary} --version\` did not report a Deno version (exit code ${String(result.exitCode)}${result.timedOut ? ', timed out' : ''}).`,
    }
  }
  if (!isSupportedDenoVersion(version)) {
    return {
      ok: false,
      binary,
      problem: 'too-old',
      version,
      message: `Deno ${version} (\`${binary}\`) is too old for the \`deno\` engine, which needs Deno ${MIN_DENO_VERSION} or later.`,
    }
  }
  return { ok: true, binary, version }
}

/**
 * The Deno binary to use, checked with {@link probeDeno}.
 *
 * @throws {DenoPluginError} `ENGINE_UNAVAILABLE` when it is missing, too old or broken.
 */
export async function requireDeno(
  binary: string = DEFAULT_DENO_BINARY,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ binary: string; version: string }> {
  const probe = await probeDeno(binary, env)
  if (probe.ok) return { binary: probe.binary, version: probe.version }
  const hint =
    probe.problem === 'too-old'
      ? "Upgrade Deno (`deno upgrade`), or use `engine: 'loader'`."
      : `Install Deno ${MIN_DENO_VERSION} or later (https://docs.deno.com/runtime/getting_started/installation/), set \`denoBinary\` to its path, or use \`engine: 'loader'\`.`
  throw new DenoPluginError('ENGINE_UNAVAILABLE', probe.message, { hint })
}

/** Deno's cache directories, from `deno info --json` without a module. */
export interface DenoCacheDirs {
  /** `DENO_DIR` as Deno resolves it. */
  denoDir: string | undefined
  /** The global npm cache (`DENO_DIR/npm`). */
  npmCache: string | undefined
}

const cacheDirs = new Map<string, Promise<DenoCacheDirs>>()

/**
 * Asks Deno where its caches are (`deno info --json --no-config`), once per binary and cache
 * environment (`DENO_DIR`, `XDG_CACHE_HOME`, home directory). The Deno CLI resolves the default
 * `DENO_DIR` slightly differently from the vendored loader (on macOS it ignores `XDG_CACHE_HOME`),
 * so the `deno` engine asks instead of computing it. Fields are `undefined` when Deno does not
 * report them.
 */
export function denoCacheDirs(
  binary: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<DenoCacheDirs> {
  const key = [binary, env.DENO_DIR, env.XDG_CACHE_HOME, env.HOME, env.USERPROFILE].join('\0')
  let dirs = cacheDirs.get(key)
  if (dirs === undefined) {
    dirs = readCacheDirs(binary, env, cwd)
    cacheDirs.set(key, dirs)
    dirs.catch(() => cacheDirs.delete(key))
  }
  return dirs
}

async function readCacheDirs(
  binary: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<DenoCacheDirs> {
  const result = await runDeno(binary, ['info', '--json', '--no-config'], {
    cwd,
    env: denoEnv(env),
    timeoutMs: PROBE_TIMEOUT_MS,
  })
  let value: unknown
  try {
    value = JSON.parse(result.stdout.toString('utf8'))
  } catch {
    value = undefined
  }
  const record =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  return {
    denoDir: typeof record.denoDir === 'string' ? record.denoDir : undefined,
    npmCache: typeof record.npmCache === 'string' ? record.npmCache : undefined,
  }
}
