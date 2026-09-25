import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { emitLog, emitRustLog, fetchWithRetry } from '../../../vendor/deno-loader/hooks.js'
import type { Logger } from '../../diagnostics/logger.js'
import type { LoaderFetch } from '../../vendored-deno-loader.js'
import { setLoaderLogger } from '../../vendored-deno-loader.js'
import type { HookClient, HookRegistration } from './hooks.js'
import { attachedEngineCount, attachLoaderHooks } from './hooks.js'

interface RecordingLogger extends Logger {
  readonly lines: string[]
}

function recordingLogger(): RecordingLogger {
  const lines: string[] = []
  return {
    lines,
    debugEnabled: true,
    error: (message) => lines.push(`error ${message}`),
    warn: (message) => lines.push(`warn ${message}`),
    info: (message) => lines.push(`info ${message}`),
    debug: (message) => lines.push(`debug ${message}`),
    downloading: (url) => lines.push(`download ${url}`),
  }
}

interface TestClient extends HookClient {
  readonly logger: RecordingLogger
  readonly blocked: string[]
}

function attach(options: { fetch?: LoaderFetch; cachedOnly?: boolean } = {}): {
  client: TestClient
  hooks: HookRegistration
} {
  const blocked: string[] = []
  const client: TestClient = {
    logger: recordingLogger(),
    fetch: options.fetch,
    cachedOnly: options.cachedOnly ?? false,
    blocked,
    onBlockedDownload: (url) => blocked.push(url),
  }
  const hooks = attachLoaderHooks(client)
  onTestFinished(() => hooks.detach())
  return { client, hooks }
}

describe('attachLoaderHooks', () => {
  it('routes downloads, retries, Rust log lines and panics to the logger', () => {
    const { client } = attach()
    emitLog({ kind: 'download', url: 'https://jsr.io/@std/path/meta.json' })
    emitLog({
      kind: 'retry',
      url: 'https://jsr.io/x',
      attempt: 1,
      delayMs: 200,
      reason: 'HTTP 503',
    })
    emitRustLog('Initialize kleur@4.1.5')
    emitRustLog('WARN RS - something odd')
    emitRustLog('DEBUG RS - details')
    emitRustLog('ERROR RS - \u001b[31mbad\u001b[0m')
    emitLog({ kind: 'panic', message: 'panicked at lib.rs:1:1' })
    expect(client.logger.lines).toEqual([
      'download https://jsr.io/@std/path/meta.json',
      'debug [engine] Retrying https://jsr.io/x in 200 ms (attempt 1 failed: HTTP 503)',
      'debug [engine] Initialize kleur@4.1.5',
      'debug [engine] warn: something odd',
      'debug [engine] details',
      'debug [engine] error: bad',
      'error [engine] The Deno loader panicked: panicked at lib.rs:1:1',
    ])
  })

  it('routes to the most recent engine, or to the most recent one with an operation running', () => {
    const first = attach()
    const second = attach()
    emitLog({ kind: 'download', url: 'https://x.test/1' })
    const end = first.hooks.begin()
    emitLog({ kind: 'download', url: 'https://x.test/2' })
    const endSecond = second.hooks.begin()
    emitLog({ kind: 'download', url: 'https://x.test/3' })
    endSecond()
    endSecond()
    emitLog({ kind: 'download', url: 'https://x.test/4' })
    end()
    emitLog({ kind: 'download', url: 'https://x.test/5' })
    expect(first.client.logger.lines).toEqual([
      'download https://x.test/2',
      'download https://x.test/4',
    ])
    expect(second.client.logger.lines).toEqual([
      'download https://x.test/1',
      'download https://x.test/3',
      'download https://x.test/5',
    ])
    second.hooks.detach()
    emitLog({ kind: 'download', url: 'https://x.test/6' })
    expect(first.client.logger.lines.at(-1)).toBe('download https://x.test/6')
  })

  it('restores the defaults when the last engine detaches', async () => {
    const before = attachedEngineCount()
    const { client, hooks } = attach()
    expect(attachedEngineCount()).toBe(before + 1)
    hooks.detach()
    hooks.detach()
    expect(attachedEngineCount()).toBe(before)
    emitLog({ kind: 'download', url: 'https://x.test/after' })
    expect(client.logger.lines).toEqual([])
    const stub = vi.fn<typeof fetch>(async () => new Response('default'))
    vi.stubGlobal('fetch', stub)
    onTestFinished(() => {
      vi.unstubAllGlobals()
    })
    expect(await (await fetchWithRetry('https://x.test/default')).text()).toBe('default')
    expect(stub).toHaveBeenCalledOnce()
  })

  it("uses the owning engine's fetch, else globalThis.fetch at call time", async () => {
    const own = vi.fn<LoaderFetch>(async () => new Response('own'))
    const { hooks } = attach({ fetch: own })
    expect(await (await fetchWithRetry('https://x.test/a', { redirect: 'manual' })).text()).toBe(
      'own',
    )
    expect(own).toHaveBeenCalledWith('https://x.test/a', { redirect: 'manual' })
    hooks.detach()
    attach()
    const global = vi.fn<typeof fetch>(async () => new Response('global'))
    vi.stubGlobal('fetch', global)
    onTestFinished(() => {
      vi.unstubAllGlobals()
    })
    expect(await (await fetchWithRetry('https://x.test/b')).text()).toBe('global')
    expect(global).toHaveBeenCalledOnce()
  })

  it('refuses downloads for cachedOnly engines without retrying', async () => {
    const own = vi.fn<LoaderFetch>(async () => new Response('never'))
    const { client } = attach({ fetch: own, cachedOnly: true })
    const started = performance.now()
    const error = await fetchWithRetry('https://x.test/c').then(
      () => undefined,
      (reason: unknown) => reason,
    )
    expect(error).toMatchObject({ name: 'AbortError' })
    expect(String(error)).toContain('https://x.test/c is not in the Deno cache')
    expect(performance.now() - started).toBeLessThan(200)
    expect(own).not.toHaveBeenCalled()
    expect(client.blocked).toEqual(['https://x.test/c'])
  })

  it('reinstalls the router when another engine attaches', () => {
    const { client } = attach()
    setLoaderLogger(null)
    emitLog({ kind: 'download', url: 'https://x.test/lost' })
    const second = attach()
    emitLog({ kind: 'download', url: 'https://x.test/routed' })
    expect(client.logger.lines).toEqual([])
    expect(second.client.logger.lines).toEqual(['download https://x.test/routed'])
  })
})
