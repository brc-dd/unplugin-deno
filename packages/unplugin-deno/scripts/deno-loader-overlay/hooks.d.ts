// Added by unplugin-deno (not part of upstream @deno/loader); see NOTICE.md.

/** A log record from the vendored `@deno/loader`, routed here instead of `console.error`. */
export type LoaderLogEvent =
  | { kind: 'download'; url: string }
  | { kind: 'retry'; url: string; attempt: number; delayMs: number; reason: string }
  | { kind: 'log'; level: 'error' | 'warn' | 'info' | 'debug' | 'trace'; message: string }
  | { kind: 'panic'; message: string }

/** Receives every {@link LoaderLogEvent}. */
export type LoaderLogger = (event: LoaderLogEvent) => void

/** The subset of `fetch` the loader uses (`init` carries `headers` and `redirect: 'manual'`). */
export type LoaderFetch = (input: string, init?: RequestInit) => Promise<Response>

/** Number of retries after the first attempt for network errors, HTTP 429 and HTTP 5xx. */
export declare const RETRY_LIMIT: number

/** Sets the log sink; `null` restores the default (no output). */
export declare function setLogger(logger: LoaderLogger | null | undefined): void

/** Sets the fetch implementation; `null` restores the default (`globalThis.fetch` at call time). */
export declare function setFetch(fetch: LoaderFetch | null | undefined): void

/** Emits a structured log event. A throwing logger never breaks loading. */
export declare function emitLog(event: LoaderLogEvent): void

/** Emits a line printed by the Rust side (`<LEVEL> RS - …` log records and reporter lines). */
export declare function emitRustLog(message: unknown): void

/** Emits a debug line from `mod.js` (printed upstream when `debug: true`). */
export declare function emitDebug(message: unknown): void

/** `fetch` with up to `RETRY_LIMIT` jittered retries on network errors, HTTP 429 and HTTP 5xx. */
export declare function fetchWithRetry(input: string, init?: RequestInit): Promise<Response>
