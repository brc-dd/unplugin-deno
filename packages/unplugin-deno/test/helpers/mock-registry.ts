import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import { gzipSync } from 'node:zlib'

/** A request the mock registry received. */
export interface MockRequest {
  /** The path and query. */
  path: string
  /** The `authorization` header, if any. */
  authorization: string | undefined
}

/**
 * A local npm and JSR registry on `127.0.0.1` for private-registry tests: the npm package
 * `mock-pkg@1.0.0` (packument at `/mock-pkg`, tarball at `/mock-pkg/-/mock-pkg-1.0.0.tgz`) and the
 * JSR package `@mock/pkg@1.0.0` (`/@mock/pkg/meta.json`, `/@mock/pkg/1.0.0_meta.json`,
 * `/@mock/pkg/1.0.0/mod.ts`). Both were published in 2024, so the minimum dependency age allows
 * them.
 */
export interface MockRegistry extends AsyncDisposable {
  /** `http://127.0.0.1:<port>/` */
  readonly url: string
  readonly port: number
  /** Every request so far, in order. */
  readonly requests: MockRequest[]
  close(): Promise<void>
}

/** The code of `mock-pkg`'s entry point. */
export const MOCK_NPM_CODE = 'export const greeting = "hello from the mock npm registry"\n'
/** The code of `@mock/pkg`'s `mod.ts`. */
export const MOCK_JSR_CODE = 'export const answer: number = 42\n'

/** A ustar header for a regular file. */
function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write('0000644\0', 100)
  header.write('0000000\0', 108)
  header.write('0000000\0', 116)
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124)
  header.write('00000000000\0', 136)
  header.write('        ', 148)
  header.write('0', 156)
  header.write('ustar\0', 257)
  header.write('00', 263)
  let checksum = 0
  for (const byte of header) checksum += byte
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148)
  return header
}

/** A gzipped tarball of `files` (path → text), as npm registries serve packages. */
export function tarball(files: Record<string, string>): Buffer {
  const parts: Buffer[] = []
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text)
    parts.push(tarHeader(name, body.length), body, Buffer.alloc((512 - (body.length % 512)) % 512))
  }
  parts.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(parts))
}

/** Starts the mock registry on a free port. */
export async function startMockRegistry(): Promise<MockRegistry> {
  const tgz = tarball({
    'package/package.json': JSON.stringify({
      name: 'mock-pkg',
      version: '1.0.0',
      type: 'module',
      exports: './index.js',
    }),
    'package/index.js': MOCK_NPM_CODE,
  })
  const integrity = `sha512-${createHash('sha512').update(tgz).digest('base64')}`
  const versionMeta = JSON.stringify({
    manifest: {
      '/mod.ts': {
        size: Buffer.byteLength(MOCK_JSR_CODE),
        checksum: `sha256-${createHash('sha256').update(MOCK_JSR_CODE).digest('hex')}`,
      },
    },
    exports: { '.': './mod.ts' },
  })
  const requests: MockRequest[] = []
  let base = ''
  const routes = (): Record<string, [string, string | Buffer]> => ({
    '/mock-pkg': [
      'application/json',
      JSON.stringify({
        name: 'mock-pkg',
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            name: 'mock-pkg',
            version: '1.0.0',
            dist: { tarball: `${base}mock-pkg/-/mock-pkg-1.0.0.tgz`, integrity },
          },
        },
        time: { '1.0.0': '2024-01-01T00:00:00.000Z' },
      }),
    ],
    '/mock-pkg/-/mock-pkg-1.0.0.tgz': ['application/octet-stream', tgz],
    '/@mock/pkg/meta.json': [
      'application/json',
      JSON.stringify({
        scope: 'mock',
        name: 'pkg',
        latest: '1.0.0',
        versions: { '1.0.0': { createdAt: '2024-01-01T00:00:00Z' } },
      }),
    ],
    '/@mock/pkg/1.0.0_meta.json': ['application/json', versionMeta],
    '/@mock/pkg/1.0.0/mod.ts': ['application/typescript', MOCK_JSR_CODE],
  })
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = request.url ?? '/'
    requests.push({ path, authorization: request.headers.authorization })
    const route = routes()[path.split('?')[0] ?? path]
    if (route === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('not found')
      return
    }
    response.writeHead(200, { 'content-type': route[0] })
    response.end(route[1])
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  base = `http://127.0.0.1:${port}/`
  const close = (): Promise<void> =>
    new Promise((resolve) => {
      // Keep-alive connections of the engine's fetch would hold `close` open.
      ;(server as { closeAllConnections?: () => void }).closeAllConnections?.()
      server.close(() => resolve())
    })
  return { url: base, port, requests, close, [Symbol.asyncDispose]: close }
}
