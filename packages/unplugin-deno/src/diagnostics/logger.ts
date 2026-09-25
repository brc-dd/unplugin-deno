/** Log levels of a {@link Logger}. */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

/**
 * The logging interface every subsystem uses. Host adapters supply implementations backed by the
 * host's logger (Vite `config.logger`, Rollup `this.warn`, esbuild warnings); debug messages are
 * prefixed with the subsystem, e.g. `[config]`, `[engine]`, `[vite]`.
 */
export interface Logger {
  /** Whether `debug` output is emitted; lets callers skip building expensive messages. */
  readonly debugEnabled: boolean
  error(message: string): void
  warn(message: string): void
  info(message: string): void
  /** Only emitted when debugging is enabled (`debug: true` or `DEBUG=unplugin-deno`). */
  debug(message: string): void
  /** A remote module or package download started (quiet unless debugging). */
  downloading(url: string): void
}

/** Receives formatted lines from {@link createConsoleLogger}. */
export type LogSink = (level: LogLevel, line: string) => void

/** Options of {@link createConsoleLogger}. */
export interface ConsoleLoggerOptions {
  /** Emit `debug` and `downloading` lines. Default: {@link isDebugEnabled}. */
  debug?: boolean | undefined
  /** Where lines go. Default: stderr (`console.error` for errors, `console.warn` otherwise). */
  sink?: LogSink | undefined
}

/** The namespace matched against `DEBUG`. */
export const DEBUG_NAMESPACE = 'unplugin-deno'

const LINE_PREFIX = `[${DEBUG_NAMESPACE}]`

/**
 * Whether the `DEBUG` environment variable enables unplugin-deno's debug output. Follows the
 * `debug` package conventions: comma- or space-separated namespaces, `*` wildcards and `-`
 * exclusions, so `unplugin-deno`, `unplugin-deno:*`, `unplugin-*` and `*` all enable it.
 */
export function isDebugEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const value = env.DEBUG
  if (!value) return false
  let enabled = false
  for (const raw of value.split(/[\s,]+/)) {
    if (raw === '') continue
    const excluded = raw.startsWith('-')
    const pattern = excluded ? raw.slice(1) : raw
    if (!matchesNamespace(pattern)) continue
    if (excluded) return false
    enabled = true
  }
  return enabled
}

function matchesNamespace(pattern: string): boolean {
  const source = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')
  const regex = new RegExp(`^${source}$`)
  // `unplugin-deno:*` should enable the top-level namespace as well.
  return regex.test(DEBUG_NAMESPACE) || regex.test(`${DEBUG_NAMESPACE}:`)
}

/** A {@link Logger} that writes `[unplugin-deno] …` lines to stderr (or to `options.sink`). */
export function createConsoleLogger(options: ConsoleLoggerOptions = {}): Logger {
  const debugEnabled = options.debug ?? isDebugEnabled()
  const sink = options.sink ?? consoleSink
  const emit = (level: LogLevel, message: string): void => sink(level, `${LINE_PREFIX} ${message}`)
  return {
    debugEnabled,
    error: (message) => emit('error', message),
    warn: (message) => emit('warn', message),
    info: (message) => emit('info', message),
    debug: (message) => {
      if (debugEnabled) emit('debug', message)
    },
    downloading: (url) => {
      if (debugEnabled) emit('debug', `[engine] Downloading ${url}`)
    },
  }
}

/** A {@link Logger} that discards everything. */
export function createSilentLogger(): Logger {
  return {
    debugEnabled: false,
    error: ignore,
    warn: ignore,
    info: ignore,
    debug: ignore,
    downloading: ignore,
  }
}

function ignore(): void {}

function consoleSink(level: LogLevel, line: string): void {
  if (level === 'error') console.error(line)
  else console.warn(line)
}
