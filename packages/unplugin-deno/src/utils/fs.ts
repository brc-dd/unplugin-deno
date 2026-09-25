import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { ParseError } from 'jsonc-parser'
import { parse, printParseErrorCode } from 'jsonc-parser'
import type { ErrorCode } from '../diagnostics/errors.js'
import { DenoPluginError } from '../diagnostics/errors.js'

/** Creates `dir` and its missing parents; succeeds when it already exists. */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

/** Errors a rename may hit transiently on Windows (antivirus, indexers, concurrent readers). */
const RETRYABLE_RENAME_ERRORS: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RENAME_ATTEMPTS = 6

/**
 * Writes `data` to `file` atomically: to a unique temporary file in the same directory, then
 * renamed over `file`. Readers never see a partial file and concurrent writers (other processes
 * writing the same mirror file) do not corrupt each other; the last rename wins. Missing parent
 * directories are created.
 */
export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  const dir = dirname(file)
  await ensureDir(dir)
  const temp = join(dir, `.${basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeFile(temp, data)
    await renameWithRetry(temp, file)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      if (attempt >= RENAME_ATTEMPTS || !RETRYABLE_RENAME_ERRORS.has(errorCode(error))) throw error
      await delay(10 * 2 ** attempt)
    }
  }
}

function errorCode(error: unknown): string {
  const code: unknown =
    typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
  return typeof code === 'string' ? code : ''
}

/**
 * Parses JSON with comments and trailing commas (`deno.json(c)`, `deno.lock`, `package.json`).
 * A leading byte-order mark is ignored.
 *
 * @param file Shown in the error message.
 * @param code Error code used when parsing fails (default `CONFIG_INVALID`).
 * @throws {DenoPluginError} With the 1-based line and column of the first syntax error.
 */
export function parseJsonc(
  text: string,
  file: string,
  code: ErrorCode = 'CONFIG_INVALID',
): unknown {
  const source = text.startsWith('﻿') ? text.slice(1) : text
  const errors: ParseError[] = []
  const value: unknown = parse(source, errors, {
    allowTrailingComma: true,
    disallowComments: false,
    allowEmptyContent: false,
  })
  const [first] = errors
  if (first) {
    const { line, column } = lineAndColumn(source, first.offset)
    throw new DenoPluginError(
      code,
      `Cannot parse ${file}: ${printParseErrorCode(first.error)} at ${line}:${column}.`,
      { hint: `Fix the JSON syntax in ${file} (comments and trailing commas are allowed).` },
    )
  }
  return value
}

/**
 * Reads and parses a JSONC file with {@link parseJsonc}. File system errors (for example
 * `ENOENT`) are thrown as-is so callers can map them to their own error codes.
 */
export async function readJsonc(
  file: string,
  code: ErrorCode = 'CONFIG_INVALID',
): Promise<unknown> {
  return parseJsonc(await readFile(file, 'utf8'), file, code)
}

function lineAndColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset)
  const lines = before.split(/\r\n|\r|\n/)
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 }
}
