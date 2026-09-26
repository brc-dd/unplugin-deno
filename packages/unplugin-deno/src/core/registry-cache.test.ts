import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tempDir } from '../../test/helpers/temp-dir.js'
import { sha256Hex } from '../utils/hash.js'
import {
  cachedJsrIntegrity,
  cachedJsrMeta,
  cachedPackument,
  readCachedRemote,
  remoteCacheFile,
} from './registry-cache.js'

/** A Deno cache file: the content, then Deno's metadata line. */
function cacheFile(content: string, url: string): string {
  return `${content}\n// denoCacheMetadata={"headers":{"content-type":"application/json"},"url":"${url}","time":1}`
}

describe('remoteCacheFile', () => {
  it('names files like deno_cache_dir: scheme, host (with _PORT), sha256 of path and query', () => {
    expect(remoteCacheFile('/d', 'https://jsr.io/@std/path/meta.json')).toBe(
      join('/d', 'remote', 'https', 'jsr.io', sha256Hex('/@std/path/meta.json')),
    )
    expect(remoteCacheFile('/d', 'http://127.0.0.1:4507/@a/b/meta.json?x=1#frag')).toBe(
      join('/d', 'remote', 'http', '127.0.0.1_PORT4507', sha256Hex('/@a/b/meta.json?x=1')),
    )
    expect(remoteCacheFile('/d', 'data:text/plain,x')).toBeUndefined()
  })
})

describe('registry metadata in the Deno cache', () => {
  it('reads JSR metadata, the version metadata integrity and npm packuments', async () => {
    const meta = JSON.stringify({
      scope: 'std',
      name: 'path',
      versions: {
        '1.1.5': { createdAt: '2026-05-26T09:57:13Z' },
        '1.1.6': { createdAt: '2026-06-30T10:24:29Z' },
        '1.1.7': { createdAt: '2026-09-26T00:00:00Z', yanked: true },
      },
    })
    const versionMeta = '{"manifest":{},"exports":{".":"./mod.ts"}}'
    const metaUrl = 'https://jsr.io/@std/path/meta.json'
    const versionUrl = 'https://jsr.io/@std/path/1.1.6_meta.json'
    await using dir = await tempDir({
      [`remote/https/jsr.io/${sha256Hex('/@std/path/meta.json')}`]: cacheFile(meta, metaUrl),
      [`remote/https/jsr.io/${sha256Hex('/@std/path/1.1.6_meta.json')}`]: cacheFile(
        versionMeta,
        versionUrl,
      ),
      'npm/registry.npmjs.org/@scope/pkg/registry.json': {
        name: '@scope/pkg',
        versions: {
          '1.0.0': {
            version: '1.0.0',
            dependencies: { dep: '^2' },
            peerDependencies: { peer: '*' },
            peerDependenciesMeta: { peer: { optional: true } },
            dist: {
              integrity: 'sha512-abc',
              tarball: 'https://registry.npmjs.org/@scope/pkg/-/pkg-1.0.0.tgz',
            },
          },
        },
        time: { '1.0.0': '2024-01-01T00:00:00.000Z' },
      },
    })
    const dirs = [join(dir.root, 'missing'), dir.root]
    expect(new TextDecoder().decode(readCachedRemote(dir.root, metaUrl))).toBe(meta)
    expect(cachedJsrMeta(dirs, 'https://jsr.io/', '@std/path')?.versions).toEqual({
      '1.1.5': { createdAt: '2026-05-26T09:57:13Z', yanked: false },
      '1.1.6': { createdAt: '2026-06-30T10:24:29Z', yanked: false },
      '1.1.7': { createdAt: '2026-09-26T00:00:00Z', yanked: true },
    })
    expect(cachedJsrIntegrity(dirs, 'https://jsr.io/', '@std/path', '1.1.6')).toBe(
      sha256Hex(versionMeta),
    )
    expect(cachedJsrIntegrity(dirs, 'https://jsr.io/', '@std/path', '1.1.5')).toBeUndefined()
    const packument = cachedPackument(dirs, '@scope/pkg')
    expect(packument?.versions['1.0.0']).toEqual({
      dependencies: { dep: '^2' },
      optionalDependencies: {},
      peerDependencies: { peer: '*' },
      optionalPeers: ['peer'],
      integrity: 'sha512-abc',
      tarball: 'https://registry.npmjs.org/@scope/pkg/-/pkg-1.0.0.tgz',
    })
    expect(packument?.time).toEqual({ '1.0.0': '2024-01-01T00:00:00.000Z' })
    expect(cachedPackument(dirs, 'not-cached')).toBeUndefined()
  })
})
