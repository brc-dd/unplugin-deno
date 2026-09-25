// @ts-self-types="./hooks.d.ts"
// Added by unplugin-deno (not part of upstream @deno/loader); see NOTICE.md.
// The patched glue calls these functions instead of `console.error` and `fetch`, so the plugin
// can route loader output through its logger and inject a fetch implementation.

const RUST_LOG_PREFIX = /^(ERROR|WARN|INFO|DEBUG|TRACE) RS - /
const RETRY_BASE_DELAY_MS = 250

/** Number of retries after the first attempt for network errors, HTTP 429 and HTTP 5xx. */
export const RETRY_LIMIT = 3

let logger = noop
let customFetch

function noop() {}

/** Sets the log sink; `null` restores the default (no output). */
export function setLogger(fn) {
  logger = typeof fn === 'function' ? fn : noop
}

/** Sets the fetch implementation; `null` restores the default (`globalThis.fetch` at call time). */
export function setFetch(fn) {
  customFetch = typeof fn === 'function' ? fn : undefined
}

/** Emits a structured log event. A throwing logger never breaks loading. */
export function emitLog(event) {
  try {
    logger(event)
  } catch {
    // ignored on purpose
  }
}

/** Emits a line printed by the Rust side (`<LEVEL> RS - …` log records and reporter lines). */
export function emitRustLog(value) {
  const message = String(value)
  const match = RUST_LOG_PREFIX.exec(message)
  if (match) {
    const level = match[1].toLowerCase()
    emitLog({ kind: 'log', level, message: message.slice(match[0].length) })
  } else {
    emitLog({ kind: 'log', level: 'info', message })
  }
}

/** Emits a debug line from `mod.js` (printed upstream when `debug: true`). */
export function emitDebug(message) {
  emitLog({ kind: 'log', level: 'debug', message: String(message) })
}

/** `fetch` with up to `RETRY_LIMIT` jittered retries on network errors, HTTP 429 and HTTP 5xx. */
export async function fetchWithRetry(input, init) {
  for (let attempt = 1; ; attempt++) {
    const fetchImpl = customFetch ?? globalThis.fetch
    let response
    try {
      response = await fetchImpl(input, init)
    } catch (error) {
      if (attempt > RETRY_LIMIT || isAbortError(error)) throw error
      await waitBeforeRetry(input, attempt, describeError(error))
      continue
    }
    if (attempt <= RETRY_LIMIT && isRetryableStatus(response.status)) {
      await discardBody(response)
      await waitBeforeRetry(input, attempt, `HTTP ${response.status}`)
      continue
    }
    return response
  }
}

function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599)
}

function isAbortError(error) {
  return typeof error === 'object' && error !== null && error.name === 'AbortError'
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}

async function discardBody(response) {
  try {
    await response.body?.cancel()
  } catch {
    // ignored on purpose
  }
}

function waitBeforeRetry(input, attempt, reason) {
  const ceiling = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)
  const delayMs = Math.round(ceiling / 2 + (Math.random() * ceiling) / 2)
  emitLog({ kind: 'retry', url: String(input), attempt, delayMs, reason })
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}
