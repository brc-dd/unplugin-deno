import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { denoDir, freshDenoDir } from '../test/helpers/deno-dir.js'
import { normalize } from '../test/helpers/normalize.js'
import { runtime } from '../test/helpers/runtime.js'
import { tempProject } from '../test/helpers/temp-project.js'
import {
  emitDebug,
  emitLog,
  emitRustLog,
  fetchWithRetry,
  RETRY_LIMIT,
} from '../vendor/deno-loader/hooks.js'
import type { LoaderLogEvent } from './vendored-deno-loader.js'
import { loadVendoredDenoLoader, setLoaderFetch, setLoaderLogger } from './vendored-deno-loader.js'

const decoder = new TextDecoder()

function recordEvents(): LoaderLogEvent[] {
  const events: LoaderLogEvent[] = []
  setLoaderLogger((event) => events.push(event))
  return events
}

afterEach(() => {
  setLoaderLogger(null)
  setLoaderFetch(null)
})

describe(`vendored @deno/loader on ${runtime}`, () => {
  it('returns the same module on every call', async () => {
    const first = await loadVendoredDenoLoader()
    expect(await loadVendoredDenoLoader()).toBe(first)
    expect(typeof first.Workspace).toBe('function')
    expect(first.ResolutionMode.Import).toBe(0)
  })

  it(
    'resolves and loads jsr: and npm: dependencies of a deno.json project',
    { timeout: 120_000 },
    async () => {
      const project = await tempProject('smoke-jsr-npm')
      onTestFinished(() => project.dispose())
      vi.stubEnv('DENO_DIR', await denoDir())
      const events = recordEvents()
      const consoleError = vi.spyOn(console, 'error')
      const expected = project.manifest.expect as { resolve: Record<string, string> }

      const { MediaType, RequestedModuleType, ResolutionMode, Workspace } =
        await loadVendoredDenoLoader()
      const workspace = new Workspace({
        configPath: project.path('deno.json'),
        platform: 'browser',
      })
      const loader = await workspace.createLoader()
      const main = project.url('src/main.ts')
      expect(await loader.addEntrypoints([main])).toEqual([])

      const stdPath = loader.resolveSync('@std/path', main, ResolutionMode.Import)
      expect(stdPath).toBe(expected.resolve['@std/path'])
      const kleur = loader.resolveSync('kleur', main, ResolutionMode.Import)
      expect(normalize(kleur)).toBe(expected.resolve.kleur)

      const loaded = await loader.load(stdPath, RequestedModuleType.Default)
      if (loaded.kind !== 'module') throw new Error(`expected a module, got ${loaded.kind}`)
      expect(loaded.specifier).toBe(stdPath)
      expect(loaded.mediaType).toBe(MediaType.TypeScript)
      const code = decoder.decode(loaded.code)
      expect(code).toContain('export * from "./join.ts"')
      // The loader leaves an inline source map comment in `code` (the engine strips it in M1).
      expect(code).toMatch(/\/\/# sourceMappingURL=data:application\/json;base64,/)
      expect(loaded.sourceMap).toBeInstanceOf(Uint8Array)
      const map = JSON.parse(decoder.decode(loaded.sourceMap)) as {
        sources: string[]
        sourcesContent?: string[]
      }
      expect(map.sources).toEqual([stdPath])
      expect(map.sourcesContent?.[0]).toContain('export * from "./join.ts"')

      expect(consoleError).not.toHaveBeenCalled()
      for (const event of events) expect(['download', 'log', 'retry']).toContain(event.kind)
    },
  )

  it('fetches through the injected fetch and retries transient failures', async () => {
    const cache = await freshDenoDir()
    onTestFinished(() => cache.dispose())
    vi.stubEnv('DENO_DIR', cache.path)
    const events = recordEvents()
    const consoleError = vi.spyOn(console, 'error')
    const url = 'https://example.test/answer.ts'
    const requests: string[] = []
    setLoaderFetch(async (input) => {
      requests.push(input)
      if (requests.length === 1) return new Response('busy', { status: 503 })
      return new Response('export const answer: number = 42\n', {
        headers: { 'content-type': 'application/typescript' },
      })
    })

    const { RequestedModuleType, Workspace } = await loadVendoredDenoLoader()
    const workspace = new Workspace({ noConfig: true, noLock: true })
    const loader = await workspace.createLoader()
    expect(await loader.addEntrypoints([url])).toEqual([])
    const loaded = await loader.load(url, RequestedModuleType.Default)
    if (loaded.kind !== 'module') throw new Error(`expected a module, got ${loaded.kind}`)
    expect(decoder.decode(loaded.code)).toContain('export const answer = 42')

    expect(requests).toEqual([url, url])
    expect(events).toContainEqual({ kind: 'download', url })
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'retry', url, attempt: 1, reason: 'HTTP 503' }),
    )
    expect(consoleError).not.toHaveBeenCalled()
  })
})

describe('vendor/deno-loader/hooks.js', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('parses Rust log levels and reporter lines', () => {
    const events = recordEvents()
    emitRustLog('WARN RS - something odd')
    emitRustLog('DEBUG RS - details')
    emitRustLog('Blocking waiting for file lock')
    emitDebug("DEBUG - Resolving 'x'")
    expect(events).toEqual([
      { kind: 'log', level: 'warn', message: 'something odd' },
      { kind: 'log', level: 'debug', message: 'details' },
      { kind: 'log', level: 'info', message: 'Blocking waiting for file lock' },
      { kind: 'log', level: 'debug', message: "DEBUG - Resolving 'x'" },
    ])
  })

  it('prints nothing by default and survives a throwing logger', () => {
    const consoleError = vi.spyOn(console, 'error')
    emitLog({ kind: 'panic', message: 'boom' })
    setLoaderLogger(() => {
      throw new Error('logger failed')
    })
    expect(() => emitLog({ kind: 'download', url: 'https://jsr.io/x' })).not.toThrow()
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('uses globalThis.fetch at call time by default', async () => {
    const stub = vi.fn<typeof fetch>(async () => new Response('ok'))
    vi.stubGlobal('fetch', stub)
    try {
      expect(await (await fetchWithRetry('https://jsr.io/x')).text()).toBe('ok')
      expect(stub).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('retries network errors, 429 and 5xx with growing jittered delays, then gives up', async () => {
    vi.useFakeTimers()
    const events = recordEvents()
    const failures: Array<() => Response> = [
      () => {
        throw new TypeError('fetch failed')
      },
      () => new Response('', { status: 429 }),
      () => new Response('', { status: 502 }),
      () => new Response('', { status: 500 }),
    ]
    let calls = 0
    setLoaderFetch(async () => {
      const respond = failures[Math.min(calls++, failures.length - 1)]
      if (!respond) throw new Error('no response configured')
      return respond()
    })
    const pending = fetchWithRetry('https://registry.npmjs.org/x')
    await vi.runAllTimersAsync()
    const response = await pending
    expect(response.status).toBe(500)
    expect(calls).toBe(RETRY_LIMIT + 1)
    const retries = events.filter((event) => event.kind === 'retry')
    expect(retries.map((event) => [event.attempt, event.reason])).toEqual([
      [1, 'fetch failed'],
      [2, 'HTTP 429'],
      [3, 'HTTP 502'],
    ])
    const delays = retries.map((event) => event.delayMs)
    expect(delays[0]).toBeGreaterThanOrEqual(125)
    expect(delays[0]).toBeLessThanOrEqual(250)
    expect(delays[2]).toBeGreaterThanOrEqual(500)
    expect(delays[2]).toBeLessThanOrEqual(1000)
  })

  it('rethrows the last network error and does not retry client errors', async () => {
    vi.useFakeTimers()
    setLoaderFetch(async () => {
      throw new TypeError('offline')
    })
    const failing = fetchWithRetry('https://jsr.io/x').catch((error: unknown) => error)
    await vi.runAllTimersAsync()
    expect(await failing).toMatchObject({ name: 'TypeError', message: 'offline' })

    let calls = 0
    setLoaderFetch(async () => {
      calls++
      return new Response('', { status: 404 })
    })
    expect((await fetchWithRetry('https://jsr.io/missing')).status).toBe(404)
    expect(calls).toBe(1)
  })
})
