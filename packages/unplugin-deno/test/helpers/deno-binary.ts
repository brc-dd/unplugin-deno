import { execFileSync } from 'node:child_process'
import {
  isSupportedDenoVersion,
  MIN_DENO_VERSION,
  parseDenoVersion,
} from '../../src/engine/deno-cli/process.js'

/** Environment variable that selects the Deno binary the tests use (default `deno`). */
export const TEST_DENO_BINARY_ENV = 'UNPLUGIN_DENO_TEST_DENO_BINARY'

/** The Deno binary the tests can use, detected once when this module loads. */
export interface DenoBinaryInfo {
  /** The command or path that was run. */
  binary: string
  /** Its version, when it ran. */
  version: string | undefined
  /** Why tests that need it are skipped (missing, too old), or `undefined` when it is usable. */
  skipReason: string | undefined
}

/**
 * Runs `<binary> --version` (synchronously: test modules decide at load time what to skip) and
 * checks it against the `deno` engine's minimum version.
 */
export function detectDenoBinary(
  binary: string = process.env[TEST_DENO_BINARY_ENV] || 'deno',
): DenoBinaryInfo {
  let output: string
  try {
    output = execFileSync(binary, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, NO_COLOR: '1', DENO_NO_UPDATE_CHECK: '1' },
    })
  } catch {
    return { binary, version: undefined, skipReason: `no \`${binary}\` binary on PATH` }
  }
  const version = parseDenoVersion(output)
  if (version === undefined) {
    return { binary, version, skipReason: `\`${binary} --version\` reported no Deno version` }
  }
  if (!isSupportedDenoVersion(version)) {
    return { binary, version, skipReason: `Deno ${version} is older than ${MIN_DENO_VERSION}` }
  }
  return { binary, version, skipReason: undefined }
}

/** The Deno binary of this test run (see {@link detectDenoBinary}). */
export const denoBinary: DenoBinaryInfo = detectDenoBinary()
