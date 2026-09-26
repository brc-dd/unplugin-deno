import { readFile, rm, stat, utimes } from 'node:fs/promises'
import { join, posix, win32 } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { denoDir } from '../../test/helpers/deno-dir.js'
import { tempDir } from '../../test/helpers/temp-dir.js'
import type { TempDir } from '../../test/helpers/temp-dir.js'
import { tempProject } from '../../test/helpers/temp-project.js'
import { readLockfile } from '../config/lockfile.js'
import type { Lockfile } from '../config/lockfile.js'
import { DenoPluginError, isDenoPluginError } from '../diagnostics/errors.js'
import type { Logger } from '../diagnostics/logger.js'
import { createSilentLogger } from '../diagnostics/logger.js'
import { loaderEngineFactory } from '../engine/loader/engine.js'
import { mediaTypeFromUrl } from '../engine/media-type.js'
import type {
  EncodedSourceMap,
  Engine,
  LoadedModule,
  LoadType,
  MediaType,
  ResolvedModule,
} from '../engine/types.js'
import { sha256Hex } from '../utils/hash.js'
import type { Mirror } from './mirror.js'
import {
  createMirror,
  hostMirrorMap,
  isCodeMediaType,
  mirrorGeneration,
  mirrorMapSources,
  mirrorSegments,
  mirrorSourceName,
  relativeSpecifier,
  sanitizeSegment,
  stripSourceMappingComment,
} from './mirror.js'

// ---------------------------------------------------------------------------------------------
// Layout

function hash(query: string): string {
  return sha256Hex(query).slice(0, 8)
}

function lockfileOf(entries: Record<string, string>): MirrorLockfile {
  return { pin: () => null, remoteIntegrity: (value) => entries[value] ?? null }
}

describe('mirrorSegments', () => {
  it.each<[string, MediaType, 'module' | 'asset', string]>([
    [
      'https://jsr.io/@std/path/1.1.6/mod.ts',
      'TypeScript',
      'module',
      'https/jsr.io/@std/path/1.1.6/mod.ts.js',
    ],
    ['https://deno.land/x/app/x.tsx', 'Tsx', 'module', 'https/deno.land/x/app/x.tsx.js'],
    ['https://deno.land/x/app/util.mjs', 'Mjs', 'module', 'https/deno.land/x/app/util.mjs'],
    ['https://deno.land/x/app/util.cjs', 'Cjs', 'module', 'https/deno.land/x/app/util.cjs'],
    ['https://deno.land/x/app/util.js', 'JavaScript', 'module', 'https/deno.land/x/app/util.js'],
    ['https://deno.land/x/app/types.d.ts', 'Dts', 'module', 'https/deno.land/x/app/types.d.ts.js'],
    ['https://esm.sh/react', 'JavaScript', 'module', 'https/esm.sh/react.js'],
    ['https://esm.sh/react@19.2.0', 'JavaScript', 'module', 'https/esm.sh/react@19.2.0.js'],
    ['http://localhost:8080/a/b.ts', 'TypeScript', 'module', 'http/localhost%3A8080/a/b.ts.js'],
    ['https://x.test/dir/', 'JavaScript', 'module', 'https/x.test/dir/~e.js'],
    ['https://x.test/a//b.ts', 'TypeScript', 'module', 'https/x.test/a/~e/b.ts.js'],
    ['https://x.test', 'JavaScript', 'module', 'https/x.test/~e.js'],
    ['https://x.test/data.json', 'Json', 'asset', 'https/x.test/data.json'],
    ['https://x.test/README', 'Unknown', 'asset', 'https/x.test/README'],
    ['https://x.test/mod.ts', 'TypeScript', 'asset', 'https/x.test/mod.ts'],
    ['https://x.test/worker.js', 'JavaScript', 'asset', 'https/x.test/worker~raw.js'],
    ['https://x.test/worker.mjs', 'Mjs', 'asset', 'https/x.test/worker~raw.mjs'],
  ])('%s (%s, %s) → %s', (url, mediaType, kind, expected) => {
    expect(mirrorSegments(url, mediaType, kind).join('/')).toBe(expected)
  })

  it('replaces a query with ~q<hash> before the extension', () => {
    expect(
      mirrorSegments('https://esm.sh/preact@10.19.0?target=esnext', 'JavaScript', 'module').at(-1),
    ).toBe(`preact@10.19.0~q${hash('?target=esnext')}.js`)
    expect(mirrorSegments('https://x.test/mod.ts?v=1', 'TypeScript', 'module').at(-1)).toBe(
      `mod~q${hash('?v=1')}.ts.js`,
    )
    expect(mirrorSegments('https://x.test/data.json?v=2', 'Json', 'asset').at(-1)).toBe(
      `data~q${hash('?v=2')}.json`,
    )
    expect(mirrorSegments('https://x.test/mod.ts?v=1', 'TypeScript', 'module')).not.toEqual(
      mirrorSegments('https://x.test/mod.ts?v=2', 'TypeScript', 'module'),
    )
    // A fragment is not part of the resource.
    expect(mirrorSegments('https://x.test/mod.ts#x', 'TypeScript', 'module').at(-1)).toBe(
      'mod.ts.js',
    )
  })

  it('names data: URLs by the hash of the URL', () => {
    const url = 'data:application/typescript,export const x: number = 1'
    const name = sha256Hex(url).slice(0, 16)
    expect(mirrorSegments(url, 'TypeScript', 'module')).toEqual(['data', `${name}.ts.js`])
    const js = 'data:text/javascript,export default 1'
    expect(mirrorSegments(js, 'JavaScript', 'module')).toEqual([
      'data',
      `${sha256Hex(js).slice(0, 16)}.js`,
    ])
    const text = 'data:text/plain,hello'
    expect(mirrorSegments(text, 'Unknown', 'asset')).toEqual(['data', sha256Hex(text).slice(0, 16)])
    const json = 'data:application/json,{}'
    expect(mirrorSegments(json, 'Json', 'asset')).toEqual([
      'data',
      `${sha256Hex(json).slice(0, 16)}.json`,
    ])
  })

  it('makes every segment a valid Windows file name', () => {
    expect(mirrorSegments('https://x.test/a:b/c*d|e/f.ts', 'TypeScript', 'module')).toEqual([
      'https',
      'x.test',
      'a%3Ab',
      'c%2Ad%7Ce',
      'f.ts.js',
    ])
    expect(mirrorSegments('https://x.test/con/nul.js', 'JavaScript', 'module')).toEqual([
      'https',
      'x.test',
      '%63on',
      '%6Eul.js',
    ])
    // The URL parser percent-encodes `"`, `<` and `>`; `%` stays as it is.
    expect(mirrorSegments('https://x.test/a"b<c>.ts', 'TypeScript', 'module').at(-1)).toBe(
      'a%22b%3Cc%3E.ts.js',
    )
  })

  it('keeps names within file-system limits', () => {
    const long = 'a'.repeat(300)
    const [, , directory, file] = mirrorSegments(
      `https://x.test/${long}/${long}.ts`,
      'TypeScript',
      'module',
    )
    expect(directory?.length).toBeLessThanOrEqual(200)
    expect(file).toMatch(/^a{150}~h[0-9a-f]{8}\.ts\.js$/)
  })
})

describe('sanitizeSegment', () => {
  it.each([
    ['plain', 'plain'],
    ['', '~e'],
    ['a:b', 'a%3Ab'],
    ['a\\b', 'a%5Cb'],
    ['tab\there', 'tab%09here'],
    ['trailing.', 'trailing%2E'],
    ['dots...', 'dots%2E%2E%2E'],
    ['space ', 'space%20'],
    ['AUX', '%41UX'],
    ['com1.txt', '%63om1.txt'],
    ['lpt9', '%6Cpt9'],
    ['console', 'console'],
    ['@std', '@std'],
    ['path@1.1.6', 'path@1.1.6'],
    ['a%20b', 'a%20b'],
  ])('%j → %j', (segment, expected) => {
    expect(sanitizeSegment(segment)).toBe(expected)
  })
})

describe('relativeSpecifier', () => {
  it.each<[string, string, 'posix' | 'win32', string]>([
    [
      '/m/g/https/jsr.io/@std/path/1.1.6/mod.ts.js',
      '/m/g/https/jsr.io/@std/path/1.1.6/join.ts.js',
      'posix',
      './join.ts.js',
    ],
    [
      '/m/g/https/jsr.io/@std/path/1.1.6/mod.ts.js',
      '/m/g/https/jsr.io/@std/path/1.1.6/posix/join.ts.js',
      'posix',
      './posix/join.ts.js',
    ],
    [
      '/m/g/https/jsr.io/@std/path/1.1.6/posix/join.ts.js',
      '/m/g/https/jsr.io/@std/path/1.1.6/_common/x.ts.js',
      'posix',
      '../_common/x.ts.js',
    ],
    [
      '/m/g/https/jsr.io/@std/path/1.1.6/join.ts.js',
      '/m/g/https/jsr.io/@std/internal/1.0.14/os.ts.js',
      'posix',
      '../../internal/1.0.14/os.ts.js',
    ],
    [
      '/m/g/https/jsr.io/a/mod.ts.js',
      '/m/g/data/0123456789abcdef.js',
      'posix',
      '../../../data/0123456789abcdef.js',
    ],
    [
      '/m/g/https/x.test/a%3Ab/mod.ts.js',
      '/m/g/https/x.test/a%3Ab/..dots.js',
      'posix',
      './..dots.js',
    ],
    [
      'C:\\m\\g\\https\\jsr.io\\a\\mod.ts.js',
      'C:\\m\\g\\https\\jsr.io\\b\\x.ts.js',
      'win32',
      '../b/x.ts.js',
    ],
    [
      'C:\\m\\g\\https\\jsr.io\\a\\mod.ts.js',
      'C:\\m\\g\\https\\jsr.io\\a\\x.ts.js',
      'win32',
      './x.ts.js',
    ],
    ['C:\\m\\g\\https\\jsr.io\\a\\mod.ts.js', 'D:\\src\\x.ts', 'win32', 'D:/src/x.ts'],
  ])('%s → %s (%s): %s', (from, to, flavor, expected) => {
    expect(relativeSpecifier(from, to, flavor)).toBe(expected)
  })
})

describe('mirrorGeneration', () => {
  it('is 8 hex characters and changes with each input', () => {
    const base = mirrorGeneration('config', '1.0.0', 'browser', [])
    expect(base).toMatch(/^[0-9a-f]{8}$/)
    expect(mirrorGeneration('config', '1.0.0', 'browser', [])).toBe(base)
    for (const other of [
      mirrorGeneration('config2', '1.0.0', 'browser', []),
      mirrorGeneration('config', '1.0.1', 'browser', []),
      mirrorGeneration('config', '1.0.0', 'deno', []),
      mirrorGeneration('config', '1.0.0', 'browser', ['deno']),
    ]) {
      expect(other).not.toBe(base)
    }
  })
})

describe('isCodeMediaType / stripSourceMappingComment', () => {
  it('treats JavaScript and TypeScript (and unknown) media types as code', () => {
    expect(
      ['JavaScript', 'Mjs', 'TypeScript', 'Tsx', 'Unknown'].every((type) =>
        isCodeMediaType(type as MediaType),
      ),
    ).toBe(true)
    expect(
      ['Json', 'Wasm', 'Css', 'Markdown'].some((type) => isCodeMediaType(type as MediaType)),
    ).toBe(false)
  })

  it('removes the trailing sourceMappingURL line only', () => {
    expect(stripSourceMappingComment('code\n//# sourceMappingURL=a.js.map\n')).toBe('code')
    expect(stripSourceMappingComment('code\n//# sourceMappingURL=a.js.map')).toBe('code')
    expect(stripSourceMappingComment('code\n')).toBe('code\n')
    expect(stripSourceMappingComment('//# sourceMappingURL=x.map\ncode\n')).toBe(
      '//# sourceMappingURL=x.map\ncode\n',
    )
  })
})

describe('source map sources (L2, L11)', () => {
  it('names a remote module as sourceRoot + sources = its URL', () => {
    expect(mirrorMapSources('https://jsr.io/@std/path/1.1.6/posix/join.ts')).toEqual({
      sourceRoot: 'https://jsr.io/@std/path/1.1.6/posix/',
      sources: ['join.ts'],
    })
    // A query stays with the name, even when it contains slashes; the fragment is dropped.
    expect(mirrorMapSources('https://esm.sh/react@19?target=es2022&deps=a/b#x')).toEqual({
      sourceRoot: 'https://esm.sh/',
      sources: ['react@19?target=es2022&deps=a/b'],
    })
    expect(mirrorMapSources('http://localhost:8000/mod.ts')).toEqual({
      sourceRoot: 'http://localhost:8000/',
      sources: ['mod.ts'],
    })
  })

  it('keeps data: URLs and URLs without a file name as they are', () => {
    expect(mirrorMapSources('data:text/javascript,export default 1')).toEqual({
      sources: ['data:text/javascript,export default 1'],
    })
    expect(mirrorMapSources('https://x.test/dir/')).toEqual({ sources: ['https://x.test/dir/'] })
  })

  it('gives Rollup-family hosts the name next to the mirror file', () => {
    expect(mirrorSourceName('/m/https/jsr.io/@std/path/1.1.6/posix/join.ts.js', 'posix')).toBe(
      'join.ts',
    )
    expect(mirrorSourceName('C:\\m\\https\\x.test\\App.tsx.js', 'win32')).toBe('App.tsx')
    expect(mirrorSourceName('/m/https/esm.sh/react.js', 'posix')).toBe('react.js')
    expect(mirrorSourceName('/m/https/x.test/util.mjs?v=1', 'posix')).toBe('util.mjs')
    const map: EncodedSourceMap = {
      version: 3,
      file: 'join.ts.js',
      sourceRoot: 'https://jsr.io/@std/path/1.1.6/posix/',
      sources: ['join.ts'],
      sourcesContent: ['export function join() {}'],
      names: [],
      mappings: 'AAAA',
    }
    expect(hostMirrorMap(map, '/m/https/jsr.io/@std/path/1.1.6/posix/join.ts.js', 'posix')).toEqual(
      {
        version: 3,
        file: 'join.ts.js',
        sources: ['join.ts'],
        sourcesContent: ['export function join() {}'],
        names: [],
        mappings: 'AAAA',
      },
    )
    const data = { ...map, sourceRoot: undefined, sources: ['data:text/javascript,1'] }
    expect(hostMirrorMap(data, '/m/data/0123456789abcdef.js', 'posix').sources).toEqual([
      '0123456789abcdef.js',
    ])
  })
})

// ---------------------------------------------------------------------------------------------
// A fake engine

interface FakeModule {
  code: string
  mediaType?: MediaType
  /** The final URL (redirect). */
  url?: string
  map?: EncodedSourceMap
  bytes?: Uint8Array
}

class FakeEngine implements Engine {
  readonly kind = 'loader'
  readonly loads: string[] = []
  readonly resolutions = new Map<string, ResolvedModule | Error>()
  /** URLs whose `load` fails (like the loader for `css` graph errors). */
  readonly failingLoads = new Set<string>()
  readonly modules: Record<string, FakeModule>
  #delay = 0

  constructor(modules: Record<string, FakeModule>) {
    this.modules = modules
  }

  slow(ms: number): this {
    this.#delay = ms
    return this
  }

  addEntrypoints(): Promise<[]> {
    return Promise.resolve([])
  }

  async resolve(specifier: string, referrer: string | undefined): Promise<ResolvedModule> {
    const known =
      this.resolutions.get(specifier) ?? this.resolutions.get(`${referrer} ${specifier}`)
    if (known instanceof Error) throw known
    if (known !== undefined) return known
    if (specifier.startsWith('node:')) return { kind: 'node', url: specifier, mediaType: 'Unknown' }
    if (/^(?:bun|cloudflare):/.test(specifier))
      return { kind: 'external', url: specifier, mediaType: 'Unknown' }
    const url = new URL(specifier, referrer).href
    if (url.startsWith('data:')) return { kind: 'data', url, mediaType: mediaTypeFromUrl(url) }
    return { kind: 'remote', url, mediaType: mediaTypeFromUrl(url) }
  }

  async load(url: string, type: LoadType): Promise<LoadedModule> {
    this.loads.push(`${type} ${url}`)
    if (this.#delay > 0) await new Promise((resolve) => setTimeout(resolve, this.#delay))
    if (this.failingLoads.has(url)) {
      throw new DenoPluginError(
        'RESOLVE_FAILED',
        `Cannot load "${url}": refused by the fake engine.`,
      )
    }
    const module = this.modules[url]
    if (module === undefined) throw new DenoPluginError('RESOLVE_NOT_FOUND', `Not found: ${url}`)
    const bytes = module.bytes ?? new TextEncoder().encode(module.code)
    const loaded: LoadedModule = {
      kind: 'module',
      url: module.url ?? url,
      mediaType: module.mediaType ?? mediaTypeFromUrl(module.url ?? url),
      code: module.code,
      bytes,
    }
    return module.map === undefined || type !== 'default' ? loaded : { ...loaded, map: module.map }
  }

  graph(): unknown {
    return {}
  }

  dispose(): Promise<void> {
    return Promise.resolve()
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.dispose()
  }
}

/** A loader-style source map: the transpiled code line by line from the original source. */
function transpileMap(url: string, source: string, lines: number): EncodedSourceMap {
  return {
    version: 3,
    sources: [url],
    sourcesContent: [source],
    names: [],
    mappings: Array.from({ length: lines }, (_, index) => (index === 0 ? 'AAAA' : 'AACA')).join(
      ';',
    ),
  }
}

interface MirrorSetup {
  dir: TempDir
  engine: FakeEngine
  mirror: Mirror
  logs: string[]
  /** Creates another mirror over the same directory (a second build or process). */
  again(engine?: FakeEngine, lockfile?: MirrorLockfile | null): Mirror
}

type MirrorLockfile = Pick<Lockfile, 'pin' | 'remoteIntegrity'>

function recordingLogger(logs: string[]): Logger {
  return { ...createSilentLogger(), debugEnabled: true, debug: (message) => logs.push(message) }
}

async function setup(
  modules: Record<string, FakeModule>,
  options: { lockfile?: MirrorLockfile | null; rawEngine?: FakeEngine } = {},
): Promise<MirrorSetup> {
  const dir = await tempDir()
  onTestFinished(() => dir.dispose())
  const engine = new FakeEngine(modules)
  const logs: string[] = []
  const make = (engineToUse: FakeEngine, lockfile: MirrorLockfile | null): Mirror =>
    createMirror({
      cacheDir: dir.path('cache'),
      generation: 'abcdef12',
      engine: () => Promise.resolve(engineToUse),
      ...(options.rawEngine === undefined
        ? {}
        : { rawEngine: () => Promise.resolve(options.rawEngine as FakeEngine) }),
      lockfile,
      logger: recordingLogger(logs),
    })
  return {
    dir,
    engine,
    logs,
    mirror: make(engine, options.lockfile ?? null),
    again: (other = new FakeEngine(modules), lockfile = options.lockfile ?? null) =>
      make(other, lockfile),
  }
}

const JSR = 'https://jsr.io/@std/path/1.1.6'

describe('ensureMirrored', () => {
  it('writes the module and its imports with rewritten specifiers (§5.3)', async () => {
    const { mirror, engine } = await setup({
      [`${JSR}/mod.ts`]: { code: 'export * from "./join.ts";\nexport * from "./posix/mod.ts";\n' },
      [`${JSR}/join.ts`]: {
        code: [
          'import { isWindows } from "jsr:@std/internal@^1.0.14/os";',
          'import kleur from "npm:kleur@^4/colors";',
          'import { readFileSync } from "fs";',
          'import db from "bun:sqlite";',
          'import data from "data:text/javascript,export default 1";',
          'export const join = () => isWindows;',
        ].join('\n'),
      },
      [`${JSR}/posix/mod.ts`]: {
        code: 'export * from "../join.ts";\nexport * from "https://deno.land/std@0.224.0/fmt/colors.ts";\n',
      },
      'https://jsr.io/@std/internal/1.0.14/os.ts': { code: 'export const isWindows = false;\n' },
      'https://deno.land/std@0.224.0/fmt/colors.ts': { code: 'export const red = (s) => s;\n' },
      'data:text/javascript,export default 1': {
        code: 'export default 1',
        mediaType: 'JavaScript',
      },
    })
    engine.resolutions.set('jsr:@std/internal@^1.0.14/os', {
      kind: 'remote',
      url: 'https://jsr.io/@std/internal/1.0.14/os.ts',
      mediaType: 'TypeScript',
    })
    engine.resolutions.set('npm:kleur@^4/colors', {
      kind: 'npm',
      url: 'file:///p/node_modules/kleur/colors.mjs',
      path: '/p/node_modules/kleur/colors.mjs',
      mediaType: 'Mjs',
      npm: {
        name: 'kleur',
        version: '4.1.5',
        subpath: '/colors',
        packageDir: '/p/node_modules/kleur',
        packageJsonPath: '/p/node_modules/kleur/package.json',
      },
    })
    engine.resolutions.set('fs', { kind: 'node', url: 'node:fs', mediaType: 'Unknown' })

    const file = await mirror.ensureMirrored(`${JSR}/mod.ts`)
    expect(file).toEqual({
      path: join(mirror.root, 'https', 'jsr.io', '@std', 'path', '1.1.6', 'mod.ts.js'),
      url: `${JSR}/mod.ts`,
      kind: 'module',
    })
    expect(mirror.root).toBe(join(mirror.cacheDir, 'abcdef12'))
    const read = (relative: string): Promise<string> =>
      readFile(join(mirror.root, ...relative.split('/')), 'utf8')
    expect(await read('https/jsr.io/@std/path/1.1.6/mod.ts.js')).toBe(
      'export * from "./join.ts.js";\nexport * from "./posix/mod.ts.js";\n\n//# sourceMappingURL=mod.ts.js.map\n',
    )
    const joined = await read('https/jsr.io/@std/path/1.1.6/join.ts.js')
    expect(joined).toContain('import { isWindows } from "../../internal/1.0.14/os.ts.js";')
    expect(joined).toContain('import kleur from "npm:kleur@4.1.5/colors";')
    expect(joined).toContain('import { readFileSync } from "node:fs";')
    expect(joined).toContain('import db from "bun:sqlite";')
    expect(joined).toMatch(
      /import data from "\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/data\/[0-9a-f]{16}\.js";/,
    )
    expect(await read('https/jsr.io/@std/path/1.1.6/posix/mod.ts.js')).toContain(
      'export * from "../join.ts.js";\nexport * from "../../../../../deno.land/std@0.224.0/fmt/colors.ts.js";',
    )
    expect(await read('https/deno.land/std@0.224.0/fmt/colors.ts.js')).toContain('export const red')
  })

  it('writes a composed source map next to each module', async () => {
    const url = `${JSR}/a.ts`
    const source = 'import { b } from "./b.ts";\nexport const a: number = b;\n'
    const { mirror } = await setup({
      [url]: {
        code: 'import { b } from "./b.ts";\nexport const a = b;\n',
        map: transpileMap(url, source, 2),
        mediaType: 'TypeScript',
      },
      [`${JSR}/b.ts`]: { code: 'export const b = 1;\n' },
      'https://x.test/plain.js': { code: 'export const plain = 1;\n', mediaType: 'JavaScript' },
    })
    const file = await mirror.ensureMirrored(url)
    const map = JSON.parse(await readFile(`${file.path}.map`, 'utf8')) as EncodedSourceMap
    // The URL as sourceRoot + sources: readers that apply sourceRoot (esbuild) see the URL.
    expect(map).toMatchObject({
      version: 3,
      file: 'a.ts.js',
      sourceRoot: `${JSR}/`,
      sources: ['a.ts'],
      sourcesContent: [source],
    })
    expect(`${map.sourceRoot}${map.sources[0]}`).toBe(url)
    expect(map.mappings.split(';').length).toBeGreaterThanOrEqual(2)
    const plain = await mirror.ensureMirrored('https://x.test/plain.js')
    const plainMap = JSON.parse(await readFile(`${plain.path}.map`, 'utf8')) as EncodedSourceMap
    expect(plainMap).toMatchObject({
      sourceRoot: 'https://x.test/',
      sources: ['plain.js'],
      sourcesContent: ['export const plain = 1;\n'],
    })
    expect(await mirror.readModule(file.path)).toEqual({
      code: 'import { b } from "./b.ts.js";\nexport const a = b;\n',
      map,
    })
  })

  it('turns text, bytes and css imports into markers and mirrors json and marker targets raw', async () => {
    const url = 'https://x.test/lib/mod.js'
    const { mirror, engine } = await setup({
      [url]: {
        code: [
          'import t from "./a.txt" with { type: "text" };',
          'import b from "./a.bin" with { type: "bytes" };',
          'import c from "./a.css" with { type: "css" };',
          'import j from "./a.json" with { type: "json" };',
          'const d = () => import("./d.txt", { with: { type: "text" } });',
          'export { t, b, c, j, d };',
        ].join('\n'),
        mediaType: 'JavaScript',
      },
      'https://x.test/lib/a.txt': { code: 'text' },
      'https://x.test/lib/a.bin': { code: '', bytes: new Uint8Array([1, 2, 3]) },
      'https://x.test/lib/a.css': { code: 'a{}' },
      'https://x.test/lib/a.json': { code: '{"a":1}', mediaType: 'Json' },
      'https://x.test/lib/d.txt': { code: 'dynamic' },
    })
    engine.resolutions.set(
      './a.css',
      new DenoPluginError('RESOLVE_FAILED', 'The import attribute type of "css" is unsupported.'),
    )
    const file = await mirror.ensureMirrored(url)
    expect(await readFile(file.path, 'utf8')).toBe(
      [
        'import t from "./a.txt?deno-type=text";',
        'import b from "./a.bin?deno-type=bytes";',
        'import c from "./a.css?deno-type=css";',
        'import j from "./a.json" with { type: "json" };',
        'const d = () => import("./d.txt?deno-type=text");',
        'export { t, b, c, j, d };',
        '//# sourceMappingURL=mod.js.map\n',
      ].join('\n'),
    )
    const dir = join(mirror.root, 'https', 'x.test', 'lib')
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('text')
    expect([...(await readFile(join(dir, 'a.bin')))]).toEqual([1, 2, 3])
    expect(await readFile(join(dir, 'a.json'), 'utf8')).toBe('{"a":1}')
    expect(engine.loads.filter((load) => load.startsWith('bytes '))).toHaveLength(5)
    expect(await mirror.readModule(join(dir, 'a.json'))).toBeNull()
    expect(await mirror.urlForMirrorPath(join(dir, 'a.txt'))).toBe('https://x.test/lib/a.txt')
  })

  it('leaves non-literal dynamic imports and unresolvable dynamic imports alone', async () => {
    const url = 'https://x.test/dyn.js'
    const { mirror, engine, logs } = await setup({
      [url]: {
        code: 'export const a = (n) => import(`./locale/${n}.js`);\nexport const b = () => import("npm:optional-dep");\n',
        mediaType: 'JavaScript',
      },
    })
    engine.resolutions.set(
      'npm:optional-dep',
      new DenoPluginError('RESOLVE_NOT_FOUND', 'not found'),
    )
    const file = await mirror.ensureMirrored(url)
    expect(await readFile(file.path, 'utf8')).toContain('import(`./locale/${n}.js`)')
    expect(await readFile(file.path, 'utf8')).toContain('import("npm:optional-dep")')
    expect(logs.some((line) => line.includes('non-literal import()'))).toBe(true)
  })

  it('fails for a static import the engine cannot resolve', async () => {
    const url = 'https://x.test/static.js'
    const { mirror, engine } = await setup({
      [url]: { code: 'import x from "npm:missing@1";\n', mediaType: 'JavaScript' },
    })
    engine.resolutions.set('npm:missing@1', new DenoPluginError('RESOLVE_NOT_FOUND', 'not found'))
    await expect(mirror.ensureMirrored(url)).rejects.toMatchObject({ code: 'RESOLVE_NOT_FOUND' })
  })

  it('loads each module once, also for concurrent calls and cycles', async () => {
    const { mirror, engine } = await setup({
      'https://x.test/a.js': {
        code: 'import "./b.js";\nexport const a = 1;\n',
        mediaType: 'JavaScript',
      },
      'https://x.test/b.js': {
        code: 'import "./a.js";\nimport "./c.js";\nexport const b = 1;\n',
        mediaType: 'JavaScript',
      },
      'https://x.test/c.js': { code: 'import "./a.js";\n', mediaType: 'JavaScript' },
    })
    engine.slow(5)
    const [first, second, third] = await Promise.all([
      mirror.ensureMirrored('https://x.test/a.js'),
      mirror.ensureMirrored('https://x.test/a.js'),
      mirror.ensureMirrored('https://x.test/b.js'),
    ])
    expect(second).toEqual(first)
    expect(third.url).toBe('https://x.test/b.js')
    expect(engine.loads.toSorted()).toEqual([
      'default https://x.test/a.js',
      'default https://x.test/b.js',
      'default https://x.test/c.js',
    ])
    expect(await readFile(join(mirror.root, 'https', 'x.test', 'c.js'), 'utf8')).toContain(
      'import "./a.js";',
    )
  })

  it('names redirected modules by their final URL and records the redirect', async () => {
    const { mirror, engine, again } = await setup({
      'https://deno.land/x/foo/mod.ts': {
        code: 'import "./dep.ts";\n',
        url: 'https://deno.land/x/foo@1.0.0/mod.ts',
        mediaType: 'TypeScript',
      },
      'https://deno.land/x/foo@1.0.0/mod.ts': {
        code: 'import "./dep.ts";\n',
        mediaType: 'TypeScript',
      },
      'https://deno.land/x/foo@1.0.0/dep.ts': { code: 'export {};\n', mediaType: 'TypeScript' },
    })
    const file = await mirror.ensureMirrored('https://deno.land/x/foo/mod.ts')
    expect(file.url).toBe('https://deno.land/x/foo@1.0.0/mod.ts')
    expect(file.path).toBe(join(mirror.root, 'https', 'deno.land', 'x', 'foo@1.0.0', 'mod.ts.js'))
    expect(await readFile(file.path, 'utf8')).toContain('import "./dep.ts.js";')
    expect((await mirror.ensureMirrored('https://deno.land/x/foo@1.0.0/mod.ts')).path).toBe(
      file.path,
    )
    expect(engine.loads).toEqual([
      'default https://deno.land/x/foo/mod.ts',
      'default https://deno.land/x/foo@1.0.0/dep.ts',
    ])
    await mirror.flush()
    const manifest = JSON.parse(await readFile(join(mirror.root, 'manifest.json'), 'utf8')) as {
      redirects: Record<string, string>
    }
    expect(manifest.redirects).toEqual({
      'https://deno.land/x/foo/mod.ts': 'https://deno.land/x/foo@1.0.0/mod.ts',
    })
    // Another build resolves the redirect from the manifest without loading anything.
    const engine2 = new FakeEngine({})
    const next = again(engine2)
    expect((await next.ensureMirrored('https://deno.land/x/foo/mod.ts')).path).toBe(file.path)
    expect(engine2.loads).toEqual([])
  })

  it('reuses the manifest and files of the generation, rewriting missing files', async () => {
    const modules = {
      'https://x.test/a.js': { code: 'import "./b.js";\n', mediaType: 'JavaScript' as const },
      'https://x.test/b.js': { code: 'export {};\n', mediaType: 'JavaScript' as const },
    }
    const { mirror, again, logs } = await setup(modules)
    await mirror.ensureMirrored('https://x.test/a.js')
    await mirror.flush()
    const reused = new FakeEngine(modules)
    const second = again(reused)
    const file = await second.ensureMirrored('https://x.test/a.js')
    expect(reused.loads).toEqual([])
    expect(await second.urlForMirrorPath(file.path)).toBe('https://x.test/a.js')
    expect(await second.urlForMirrorPath(`${file.path}?raw`)).toBe('https://x.test/a.js')
    // A deleted dependency is written again.
    await rm(join(mirror.root, 'https', 'x.test', 'b.js'))
    const third = again(reused)
    await third.ensureMirrored('https://x.test/a.js')
    expect(reused.loads).toEqual(['default https://x.test/b.js'])
    expect(logs.filter((line) => line.startsWith('[mirror] loading'))).toHaveLength(3)
  })

  it('rebuilds an invalid manifest', async () => {
    const { mirror, dir, engine } = await setup({
      'https://x.test/a.js': { code: 'export {};\n', mediaType: 'JavaScript' },
    })
    await dir.write({ 'cache/abcdef12/manifest.json': '{ not json' })
    await mirror.ensureMirrored('https://x.test/a.js')
    await mirror.flush()
    expect(engine.loads).toHaveLength(1)
    const manifest = JSON.parse(await readFile(join(mirror.root, 'manifest.json'), 'utf8')) as {
      version: number
      generation: string
      modules: Record<string, { file: string; deps: string[]; assets: string[]; mediaType: string }>
    }
    expect(manifest).toMatchObject({
      version: 1,
      generation: 'abcdef12',
      modules: {
        'https://x.test/a.js': {
          file: 'https/x.test/a.js',
          deps: [],
          assets: [],
          mediaType: 'JavaScript',
        },
      },
    })
  })

  it('merges its manifest with entries another process wrote', async () => {
    const { mirror, again } = await setup({
      'https://x.test/a.js': { code: 'export {};\n', mediaType: 'JavaScript' },
      'https://x.test/b.js': { code: 'export {};\n', mediaType: 'JavaScript' },
    })
    const other = again()
    await mirror.ensureMirrored('https://x.test/a.js')
    await other.ensureMirrored('https://x.test/b.js')
    await other.flush()
    await mirror.flush()
    const manifest = JSON.parse(await readFile(join(mirror.root, 'manifest.json'), 'utf8')) as {
      modules: Record<string, unknown>
    }
    expect(Object.keys(manifest.modules).toSorted()).toEqual([
      'https://x.test/a.js',
      'https://x.test/b.js',
    ])
  })

  it('checks the source against deno.lock remote integrity', async () => {
    const url = 'https://deno.land/std@0.224.0/x.ts'
    const source = 'export const x: number = 1;\n'
    const modules = {
      [url]: {
        code: 'export const x = 1;\n',
        map: transpileMap(url, source, 1),
        mediaType: 'TypeScript' as const,
      },
      'https://x.test/plain.js': { code: 'export {};\n', mediaType: 'JavaScript' as const },
    }
    const good = await setup(modules, {
      lockfile: lockfileOf({
        [url]: sha256Hex(source),
        'https://x.test/plain.js': sha256Hex('export {};\n'),
      }),
    })
    await expect(good.mirror.ensureMirrored(url)).resolves.toMatchObject({ url })
    await expect(good.mirror.ensureMirrored('https://x.test/plain.js')).resolves.toMatchObject({
      kind: 'module',
    })
    const bad = await setup(modules, {
      lockfile: lockfileOf({ [url]: sha256Hex('something else') }),
    })
    const error: unknown = await bad.mirror.ensureMirrored(url).catch((caught: unknown) => caught)
    expect(isDenoPluginError(error)).toBe(true)
    expect(error).toMatchObject({ code: 'INTEGRITY_MISMATCH', specifier: url })
    expect((error as DenoPluginError).hint).toContain('deno.lock')
  })

  it('mirrors non-code modules as assets', async () => {
    const { mirror, engine } = await setup({
      'https://x.test/add.wasm': {
        code: '',
        bytes: new Uint8Array([0, 97, 115, 109]),
        mediaType: 'Wasm',
      },
    })
    const file = await mirror.ensureMirrored('https://x.test/add.wasm')
    expect(file).toMatchObject({
      kind: 'asset',
      path: join(mirror.root, 'https', 'x.test', 'add.wasm'),
    })
    expect([...(await readFile(file.path))]).toEqual([0, 97, 115, 109])
    expect(engine.loads).toEqual([
      'default https://x.test/add.wasm',
      'bytes https://x.test/add.wasm',
    ])
    expect(await mirror.readModule(file.path)).toBeNull()
  })

  it('loads raw assets with the separate engine when the main one refuses', async () => {
    const modules = { 'https://x.test/a.css': { code: 'a{}' } }
    const raw = new FakeEngine(modules)
    const { mirror, engine } = await setup(modules, { rawEngine: raw })
    engine.failingLoads.add('https://x.test/a.css')
    const file = await mirror.ensureMirrored('https://x.test/a.css', 'asset')
    expect(await readFile(file.path, 'utf8')).toBe('a{}')
    expect(raw.loads).toEqual(['bytes https://x.test/a.css'])
  })

  it('reports code the lexer cannot read', async () => {
    const { mirror } = await setup({
      'https://x.test/a.jsx': {
        code: 'export const a = <div>{x}</div>;\n',
        mediaType: 'JavaScript',
      },
    })
    await expect(mirror.ensureMirrored('https://x.test/a.jsx')).rejects.toMatchObject({
      code: 'UNSUPPORTED_MEDIA_TYPE',
    })
  })

  it('fails with MIRROR_WRITE_FAILED and a cacheDir hint when it cannot write', async () => {
    const dir = await tempDir({ blocked: 'a file where the mirror should be' })
    onTestFinished(() => dir.dispose())
    const mirror = createMirror({
      cacheDir: dir.path('blocked'),
      generation: 'abcdef12',
      engine: () =>
        Promise.resolve(
          new FakeEngine({
            'https://x.test/a.js': { code: 'export {};\n', mediaType: 'JavaScript' },
          }),
        ),
      lockfile: null,
      logger: createSilentLogger(),
    })
    await expect(mirror.ensureMirrored('https://x.test/a.js')).rejects.toMatchObject({
      code: 'MIRROR_WRITE_FAILED',
      hint: expect.stringContaining('cacheDir'),
    })
  })
})

describe('mirror paths', () => {
  it('recognises mirror paths of any generation and maps them back through the manifest', async () => {
    const { mirror, dir } = await setup({
      'https://x.test/a.js': { code: 'export {};\n', mediaType: 'JavaScript' },
    })
    await dir.write({
      'cache/00000000/manifest.json': {
        version: 1,
        generation: '00000000',
        modules: {
          'https://old.test/x.js': {
            file: 'https/old.test/x.js',
            mediaType: 'JavaScript',
            integrity: '',
            deps: [],
            assets: [],
          },
        },
        assets: {},
        redirects: {},
      },
    })
    expect(mirror.isMirrorPath(dir.path('cache/00000000/https/old.test/x.js'))).toBe(true)
    expect(mirror.isMirrorPath(dir.path('elsewhere/x.js'))).toBe(false)
    expect(await mirror.urlForMirrorPath(dir.path('cache/00000000/https/old.test/x.js'))).toBe(
      'https://old.test/x.js',
    )
    expect(
      await mirror.urlForMirrorPath(dir.path('cache/abcdef12/https/unknown.test/x.js')),
    ).toBeUndefined()
    expect(await mirror.urlForMirrorPath(dir.path('elsewhere/x.js'))).toBeUndefined()
    expect(await mirror.readModule(dir.path('elsewhere/x.js'))).toBeNull()
  })

  it('computes Windows paths with the win32 flavour', () => {
    const mirror = createMirror({
      cacheDir: 'C:\\proj\\node_modules\\.unplugin-deno',
      generation: 'abcdef12',
      engine: () => Promise.resolve(new FakeEngine({})),
      lockfile: null,
      logger: createSilentLogger(),
      flavor: 'win32',
    })
    expect(mirror.root).toBe('C:\\proj\\node_modules\\.unplugin-deno\\abcdef12')
    expect(mirror.mirrorPathFor(`${JSR}/mod.ts`, 'TypeScript')).toBe(
      win32.join(
        'C:\\proj\\node_modules\\.unplugin-deno\\abcdef12',
        'https',
        'jsr.io',
        '@std',
        'path',
        '1.1.6',
        'mod.ts.js',
      ),
    )
    expect(mirror.mirrorPathFor('http://localhost:8000/a:b.ts', 'TypeScript')).toBe(
      'C:\\proj\\node_modules\\.unplugin-deno\\abcdef12\\http\\localhost%3A8000\\a%3Ab.ts.js',
    )
    expect(mirror.isMirrorPath('c:\\PROJ\\node_modules\\.unplugin-deno\\abcdef12\\x.js')).toBe(true)
    expect(mirror.isMirrorPath('C:/proj/node_modules/.unplugin-deno/abcdef12/x.js?raw')).toBe(true)
    expect(mirror.isMirrorPath('D:\\proj\\node_modules\\.unplugin-deno\\x.js')).toBe(false)
  })

  it('computes POSIX paths with the posix flavour', () => {
    const mirror = createMirror({
      cacheDir: '/proj/node_modules/.unplugin-deno',
      generation: 'abcdef12',
      engine: () => Promise.resolve(new FakeEngine({})),
      lockfile: null,
      logger: createSilentLogger(),
      flavor: 'posix',
    })
    expect(mirror.mirrorPathFor('data:text/javascript,1', 'JavaScript')).toBe(
      posix.join(
        '/proj/node_modules/.unplugin-deno/abcdef12/data',
        `${sha256Hex('data:text/javascript,1').slice(0, 16)}.js`,
      ),
    )
  })
})

describe('collectGarbage', () => {
  it('keeps the current generation and the most recently used other one', async () => {
    const { mirror, dir } = await setup({})
    await dir.write({
      'cache/abcdef12/manifest.json': '{}',
      'cache/11111111/manifest.json': '{}',
      'cache/22222222/manifest.json': '{}',
      'cache/33333333/manifest.json': '{}',
      'cache/not-a-generation/keep.txt': 'x',
      'cache/44444444': 'a file, not a generation',
    })
    const times: Record<string, number> = {
      '11111111': 1_000,
      '22222222': 3_000,
      '33333333': 2_000,
    }
    for (const [name, seconds] of Object.entries(times)) {
      await utimes(dir.path('cache', name), seconds, seconds)
    }
    expect((await mirror.collectGarbage()).toSorted()).toEqual(['11111111', '33333333'])
    const exists = (name: string): Promise<boolean> =>
      stat(dir.path('cache', name)).then(
        () => true,
        () => false,
      )
    expect(await exists('abcdef12')).toBe(true)
    expect(await exists('22222222')).toBe(true)
    expect(await exists('11111111')).toBe(false)
    expect(await exists('33333333')).toBe(false)
    expect(await exists('not-a-generation')).toBe(true)
    expect(await exists('44444444')).toBe(true)
  })

  it('does nothing without a cache directory', async () => {
    const { mirror } = await setup({})
    expect(await mirror.collectGarbage()).toEqual([])
  })
})

describe('ensureMirrored with the loader engine', () => {
  it(
    'mirrors a pinned deno.land module tree and matches deno.lock',
    { timeout: 120_000 },
    async () => {
      vi.stubEnv('DENO_DIR', await denoDir())
      const project = await tempProject('core-remote-mirror')
      onTestFinished(() => project.dispose())
      const lockfile = await readLockfile(project.path('deno.lock'))
      if (lockfile === null || lockfile.unsupported) throw new Error('expected a v5 lockfile')
      const engine = await loaderEngineFactory.create({
        project: {
          root: project.root,
          workspaceRoot: project.root,
          configPath: project.path('deno.json'),
          lockfilePath: project.path('deno.lock'),
          nodeModulesDir: 'none',
        },
        platform: 'browser',
        conditions: [],
        cachedOnly: false,
        logger: createSilentLogger(),
      })
      onTestFinished(() => engine.dispose())
      const mirror = createMirror({
        cacheDir: project.path('mirror'),
        generation: '0123abcd',
        engine: () => Promise.resolve(engine),
        lockfile,
        logger: createSilentLogger(),
      })
      const url = 'https://deno.land/std@0.224.0/text/closest_string.ts'
      const file = await mirror.ensureMirrored(url)
      const code = await readFile(file.path, 'utf8')
      expect(code).toContain('from "./levenshtein_distance.ts.js"')
      expect(code).toContain('from "../assert/assert.ts.js"')
      expect(code).not.toContain('sourceMappingURL=data:')
      const map = JSON.parse(await readFile(`${file.path}.map`, 'utf8')) as EncodedSourceMap
      expect(map.sourceRoot).toBe('https://deno.land/std@0.224.0/text/')
      expect(map.sources).toEqual(['closest_string.ts'])
      await mirror.flush()
      const manifest = JSON.parse(await readFile(join(mirror.root, 'manifest.json'), 'utf8')) as {
        modules: Record<string, { integrity: string }>
      }
      for (const [remote, integrity] of Object.entries(lockfile.remote)) {
        expect(manifest.modules[remote]?.integrity).toBe(integrity)
      }
    },
  )
})
