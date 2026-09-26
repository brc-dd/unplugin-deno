/**
 * Environment variables inlined into bundles (docs/architecture.md §5.10, L9): which variables may
 * be inlined (the `env` option's `prefix` and `allow`) and their values, from `process.env` over
 * the `.env` files (`env.files`, by default `.env` and `.env.local` where they exist; a later file
 * wins over an earlier one, and a variable set in the process wins over every file, as in Vite and
 * Deno's `--env-file`). Files are parsed with `node:util`'s `parseEnv` (Node.js, Deno and Bun).
 *
 * @module
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'
import type { Logger } from '../diagnostics/logger.js'
import type { Platform, ResolvedOptions } from './options.js'

/** The `.env` files read when `env.files` is not set (those that exist). */
export const DEFAULT_ENV_FILES: readonly string[] = Object.freeze(['.env', '.env.local'])

/** The resolved `env` option (see `Options.env`). */
export type ResolvedEnvOptions = Exclude<ResolvedOptions['env'], false>

/** The variables of one build that may be inlined, and their values. */
export interface EnvInlining {
  /** Whether a read of `key` is inlined (its name has an allowed prefix or is listed). */
  allowed(key: string): boolean
  /**
   * The value inlined for `key`: its string value, `undefined` for an allowed variable that is not
   * set, or `null` for a variable that is not inlined (the read stays in the code).
   */
  value(key: string): string | undefined | null
  /**
   * The allowed variables that have a value, sorted by name (for hosts that inline through a
   * `define` table, such as esbuild).
   */
  entries(): Array<[string, string]>
  /** The `.env` files read (absolute), in order. */
  readonly files: readonly string[]
}

/** Whether variables are inlined into code built for `platform` (browser, unless `server`). */
export function inlinesEnv(options: Pick<ResolvedOptions, 'env'>, platform: Platform): boolean {
  const { env } = options
  return env !== false && (platform === 'browser' || env.server)
}

/**
 * Reads the `.env` files of `options` (relative to `cwd`) and combines them with `processEnv`.
 * Missing default files are skipped; a missing file listed in `env.files` is reported as a
 * warning.
 */
export async function loadEnv(
  options: ResolvedEnvOptions,
  cwd: string,
  processEnv: Readonly<Record<string, string | undefined>>,
  logger: Pick<Logger, 'warn' | 'debug'>,
): Promise<EnvInlining> {
  const listed = options.files !== null
  const names = options.files ?? DEFAULT_ENV_FILES
  const fileValues: Record<string, string> = {}
  const files: string[] = []
  for (const name of names) {
    const file = resolve(cwd, name)
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      if (listed)
        logger.warn(`The env file ${file} (from the \`env.files\` option) does not exist.`)
      continue
    }
    Object.assign(fileValues, parseEnv(text))
    files.push(file)
  }
  if (files.length > 0) logger.debug(`[env] read ${files.join(', ')}`)
  const allowed = (key: string): boolean =>
    options.allow.includes(key) || options.prefix.some((prefix) => key.startsWith(prefix))
  const value = (key: string): string | undefined | null => {
    if (!allowed(key)) return null
    return processEnv[key] ?? fileValues[key]
  }
  return {
    allowed,
    value,
    entries() {
      const keys = new Set([...Object.keys(fileValues), ...Object.keys(processEnv)])
      return [...keys]
        .filter(allowed)
        .toSorted()
        .flatMap((key): Array<[string, string]> => {
          const current = value(key)
          return typeof current === 'string' ? [[key, current]] : []
        })
    },
    files,
  }
}
