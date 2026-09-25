/**
 * Routes the vendored loader's process-global hooks (log sink and fetch, see
 * `vendored-deno-loader.ts`) to the live loader engines.
 *
 * Limitation: the wasm module is instantiated once per process (realm), so its output and its
 * downloads cannot be attributed to the `Workspace` that caused them. They go to one engine: the
 * most recently created live engine that has an operation in flight, else the most recently
 * created live engine. That engine's logger receives the "Downloading …" and Rust log lines, and
 * its `fetch` and `cachedOnly` apply to every download while it owns the hooks. With identical
 * options per engine (the plugin's case) this only affects which logger prints a line. When the
 * last engine is disposed the defaults come back (no output, `globalThis.fetch`). Calling
 * `setLoaderLogger`/`setLoaderFetch` directly overrides the routing until the next engine is
 * created.
 *
 * @module
 */
import { stripVTControlCharacters } from 'node:util'
import type { Logger } from '../../diagnostics/logger.js'
import type { LoaderFetch, LoaderLogEvent } from '../../vendored-deno-loader.js'
import { setLoaderFetch, setLoaderLogger } from '../../vendored-deno-loader.js'

/** One engine's side of the hooks. */
export interface HookClient {
  readonly logger: Logger
  /** The engine's fetch; `undefined` uses `globalThis.fetch` at call time. */
  readonly fetch: LoaderFetch | undefined
  /** Refuse every download (the loader itself only blocks npm downloads, not remote modules). */
  readonly cachedOnly: boolean
  /** Called with the URL of each download refused because of `cachedOnly`. */
  onBlockedDownload(url: string): void
}

/** An attached {@link HookClient}. */
export interface HookRegistration {
  /**
   * Marks an operation of this engine as running, so hook calls are attributed to it; call the
   * returned function when the operation settles.
   */
  begin(): () => void
  /** Stops routing to this engine; restores the defaults when no engine is left. Idempotent. */
  detach(): void
}

interface Entry {
  readonly client: HookClient
  active: number
}

const entries: Entry[] = []

/**
 * Attaches an engine to the loader hooks and installs the router (again, in case something else
 * replaced it).
 */
export function attachLoaderHooks(client: HookClient): HookRegistration {
  const entry: Entry = { client, active: 0 }
  entries.push(entry)
  setLoaderLogger(routeLog)
  setLoaderFetch(routeFetch)
  let attached = true
  return {
    begin() {
      entry.active++
      let ended = false
      return () => {
        if (ended) return
        ended = true
        entry.active--
      }
    },
    detach() {
      if (!attached) return
      attached = false
      const index = entries.indexOf(entry)
      if (index !== -1) entries.splice(index, 1)
      if (entries.length === 0) {
        setLoaderLogger(null)
        setLoaderFetch(null)
      }
    },
  }
}

/** The number of attached engines (for tests and debug output). */
export function attachedEngineCount(): number {
  return entries.length
}

/** The client that owns the hooks right now; see the module documentation. */
function owner(): HookClient | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (entry !== undefined && entry.active > 0) return entry.client
  }
  return entries.at(-1)?.client
}

function routeLog(event: LoaderLogEvent): void {
  const client = owner()
  if (client === undefined) return
  const { logger } = client
  switch (event.kind) {
    case 'download':
      logger.downloading(event.url)
      return
    case 'retry':
      logger.debug(
        `[engine] Retrying ${event.url} in ${event.delayMs} ms (attempt ${event.attempt} failed: ${event.reason})`,
      )
      return
    case 'log': {
      const level = event.level === 'info' || event.level === 'debug' ? '' : `${event.level}: `
      logger.debug(`[engine] ${level}${stripVTControlCharacters(event.message)}`)
      return
    }
    case 'panic':
      logger.error(`[engine] The Deno loader panicked: ${stripVTControlCharacters(event.message)}`)
      return
  }
}

async function routeFetch(input: string, init?: RequestInit): Promise<Response> {
  const client = owner()
  if (client?.cachedOnly === true) {
    client.onBlockedDownload(input)
    // `AbortError` so the retry wrapper gives up at once.
    throw new DOMException(`${input} is not in the Deno cache and cachedOnly is set`, 'AbortError')
  }
  const fetchImpl: LoaderFetch = client?.fetch ?? globalThis.fetch
  return fetchImpl(input, init)
}
