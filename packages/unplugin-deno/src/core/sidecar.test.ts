import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tempDir } from '../../test/helpers/temp-dir.js'
import { tempProject } from '../../test/helpers/temp-project.js'
import type { Lockfile } from '../config/lockfile.js'
import { parseLockfile } from '../config/lockfile.js'
import { createSilentLogger } from '../diagnostics/logger.js'
import type { Engine, ResolvedModule } from '../engine/types.js'
import { sha256Hex } from '../utils/hash.js'
import type { ExternalRecord } from './sidecar.js'
import { buildSidecar, ExternalRecorder } from './sidecar.js'

const context = { denoDirs: [], jsrRegistries: ['https://jsr.io/'], logger: createSilentLogger() }

/** The metadata line Deno appends to the files of its remote cache. */
const metadata = (url: string): string =>
  `\n// denoCacheMetadata={"headers":{},"url":"${url}","time":1}`

async function fixtureLockfile(name: string): Promise<Lockfile> {
  await using project = await tempProject(name)
  return parseLockfile(
    await readFile(project.path('deno.lock'), 'utf8'),
    project.path('deno.lock'),
  ) as Lockfile
}

function npmResolution(root: string, name: string, version: string): ResolvedModule {
  const packageDir = join(root, 'npm', 'registry.npmjs.org', name, version)
  return {
    kind: 'npm',
    url: `file://${packageDir}/index.js`,
    path: join(packageDir, 'index.js'),
    mediaType: 'JavaScript',
    npm: {
      name,
      version,
      subpath: '',
      packageDir,
      packageJsonPath: join(packageDir, 'package.json'),
    },
  }
}

/** An engine that answers `resolve` from a table (for packages the lockfile lacks). */
function tableEngine(table: Record<string, ResolvedModule>): Engine {
  return {
    kind: 'loader',
    addEntrypoints: async () => [],
    resolve: async (specifier) => {
      const answer = table[specifier]
      if (answer === undefined) throw new Error(`unexpected resolution of ${specifier}`)
      return answer
    },
    load: async () => {
      throw new Error('not used')
    },
    graph: () => ({}),
    dispose: async () => {},
    [Symbol.asyncDispose]: async () => {},
  }
}

describe('ExternalRecorder', () => {
  it('keeps one record per id and platform, preferring one with a resolution', () => {
    const recorder = new ExternalRecorder()
    const resolved: ResolvedModule = {
      kind: 'remote',
      url: 'https://jsr.io/@std/path/1.1.6/mod.ts',
      mediaType: 'TypeScript',
    }
    recorder.record('deno', { id: 'node:fs' })
    recorder.record('deno', { id: 'jsr:@std/path@1.1.6' })
    recorder.record('deno', { id: 'jsr:@std/path@1.1.6', resolved })
    recorder.record('browser', { id: 'npm:kleur@4.1.5' })
    expect(recorder.list('deno')).toEqual([
      { id: 'jsr:@std/path@1.1.6', resolved },
      { id: 'node:fs' },
    ])
    expect(recorder.list('node')).toEqual([])
    recorder.clear()
    expect(recorder.list('deno')).toEqual([])
  })
})

describe('buildSidecar', () => {
  it("copies the externals and their dependencies from the project's lockfile", async () => {
    const lockfile = await fixtureLockfile('core-platform-deno')
    const externals: ExternalRecord[] = [
      { id: 'jsr:@std/path@1.1.6/posix' },
      { id: 'node:fs' },
      { id: 'npm:kleur@4.1.5' },
    ]
    const sidecar = await buildSidecar(externals, { ...context, lockfile })
    expect(sidecar.denoJson).toEqual({ lock: './deno.lock', nodeModulesDir: 'none' })
    expect(sidecar.lockfile).toEqual({
      version: '5',
      specifiers: {
        'jsr:@std/internal@^1.0.14': '1.0.14',
        'jsr:@std/path@1': '1.1.6',
        'jsr:@std/path@1.1.6': '1.1.6',
        'npm:kleur@4': '4.1.5',
        'npm:kleur@4.1.5': '4.1.5',
      },
      jsr: {
        '@std/internal@1.0.14': {
          integrity: '291516b3d4c35024d6ffbc0a9df5bf4c64116e05b50012cf846710152d2ffdf7',
        },
        '@std/path@1.1.6': {
          integrity: 'c68485c2a4dfbb5ae3cc74fae4e8c4e5d874cf8a8ed12927917235c758b46cbe',
          dependencies: ['jsr:@std/internal'],
        },
      },
      npm: {
        'kleur@4.1.5': {
          integrity:
            'sha512-o+NO+8WrRiQEE4/7nwRJhN1HWpVmJm511pBHUxPLtp0BUISzlBplORYSmTclCnJvQq2tKu/sgl3xVpkc7ZWuQQ==',
        },
      },
    })
    expect(sidecar.missing).toEqual([])
    expect(sidecar.fromCache).toEqual([])
    // Ranges (`pinExternals: false`) are recorded the way Deno writes them.
    const ranges = await buildSidecar([{ id: 'npm:kleur@^4' }], { ...context, lockfile })
    expect(ranges.lockfile.specifiers).toEqual({ 'npm:kleur@4': '4.1.5' })
  })

  it('follows npm dependencies, peer-dependency suffixes and optional dependencies', async () => {
    const lockfile = parseLockfile(
      JSON.stringify({
        version: '5',
        specifiers: {
          'npm:preact-render-to-string@6': '6.5.11_preact@10.24.3',
          'npm:preact@10': '10.24.3',
        },
        npm: {
          'preact@10.24.3': { integrity: 'sha512-preact' },
          'preact-render-to-string@6.5.11_preact@10.24.3': {
            integrity: 'sha512-prts',
            dependencies: ['preact'],
            optionalDependencies: ['fsevents'],
          },
          'fsevents@2.3.3': {
            integrity: 'sha512-fsevents',
            tarball: 'https://example.com/fsevents.tgz',
          },
          'unrelated@1.0.0': { integrity: 'sha512-unrelated' },
        },
      }),
      '/p/deno.lock',
    ) as Lockfile
    const sidecar = await buildSidecar([{ id: 'npm:preact-render-to-string@6.5.11' }], {
      ...context,
      lockfile,
    })
    expect(sidecar.lockfile).toEqual({
      version: '5',
      specifiers: {
        'npm:preact-render-to-string@6': '6.5.11_preact@10.24.3',
        'npm:preact-render-to-string@6.5.11': '6.5.11_preact@10.24.3',
        'npm:preact@10': '10.24.3',
      },
      npm: {
        'fsevents@2.3.3': {
          integrity: 'sha512-fsevents',
          tarball: 'https://example.com/fsevents.tgz',
        },
        'preact@10.24.3': { integrity: 'sha512-preact' },
        'preact-render-to-string@6.5.11_preact@10.24.3': {
          integrity: 'sha512-prts',
          dependencies: ['preact'],
          optionalDependencies: ['fsevents'],
        },
      },
    })
  })

  it('copies remote entries for remote externals and lists what it cannot describe', async () => {
    const lockfile = await fixtureLockfile('core-platform-deno')
    const sidecar = await buildSidecar(
      [
        { id: 'https://deno.land/std@0.224.0/text/closest_string.ts' },
        { id: 'npm:not-locked@1.0.0' },
        { id: 'fsevents' },
      ],
      { ...context, lockfile },
    )
    expect(Object.keys(sidecar.lockfile.remote ?? {})).toEqual(Object.keys(lockfile.remote))
    expect(sidecar.missing).toEqual(['npm:not-locked@1.0.0'])
    expect(sidecar.bare).toEqual(['fsevents'])
    // Bare imports need a node_modules directory (or an import map): no "none".
    expect(sidecar.denoJson).toEqual({ lock: './deno.lock' })
  })

  it("reads packages the project's lockfile lacks from Deno's cache and resolves their dependencies", async () => {
    const versionMeta = JSON.stringify({
      manifest: {},
      moduleGraph2: {
        '/mod.ts': {
          dependencies: [
            { type: 'static', kind: 'import', specifier: 'jsr:@std/internal@^1.0.14/os' },
            { type: 'static', kind: 'import', specifier: './util.ts' },
          ],
        },
      },
    })
    const internalMeta = '{"manifest":{}}'
    await using dir = await tempDir({
      [`remote/https/jsr.io/${sha256Hex('/@std/path/1.1.6_meta.json')}`]: `${versionMeta}${metadata('https://jsr.io/@std/path/1.1.6_meta.json')}`,
      [`remote/https/jsr.io/${sha256Hex('/@std/internal/1.0.14_meta.json')}`]: `${internalMeta}${metadata('https://jsr.io/@std/internal/1.0.14_meta.json')}`,
      'npm/registry.npmjs.org/strip-ansi/registry.json': {
        name: 'strip-ansi',
        versions: {
          '7.1.0': {
            dependencies: { 'ansi-regex': '^6.0.1' },
            dist: {
              integrity: 'sha512-strip',
              tarball: 'https://registry.npmjs.org/strip-ansi/-/strip-ansi-7.1.0.tgz',
            },
          },
        },
      },
      'npm/registry.npmjs.org/ansi-regex/registry.json': {
        name: 'ansi-regex',
        versions: {
          '6.3.0': {
            dist: {
              integrity: 'sha512-ansi',
              tarball: 'https://mirror.example/ansi-regex-6.3.0.tgz',
            },
          },
        },
      },
    })
    const stripAnsi = npmResolution(dir.root, 'strip-ansi', '7.1.0')
    const engine = tableEngine({
      'ansi-regex': npmResolution(dir.root, 'ansi-regex', '6.3.0'),
      'jsr:@std/internal@^1.0.14': {
        kind: 'remote',
        url: 'https://jsr.io/@std/internal/1.0.14/mod.ts',
        mediaType: 'TypeScript',
      },
    })
    const sidecar = await buildSidecar(
      [{ id: 'npm:strip-ansi@7.1.0', resolved: stripAnsi }, { id: 'jsr:@std/path@1.1.6/posix' }],
      { ...context, denoDirs: [dir.root], lockfile: null, engine: async () => engine },
    )
    expect(sidecar.lockfile).toEqual({
      version: '5',
      specifiers: {
        'jsr:@std/internal@^1.0.14': '1.0.14',
        'jsr:@std/path@1.1.6': '1.1.6',
        'npm:strip-ansi@7.1.0': '7.1.0',
      },
      jsr: {
        '@std/internal@1.0.14': { integrity: sha256Hex(internalMeta) },
        '@std/path@1.1.6': {
          integrity: sha256Hex(versionMeta),
          dependencies: ['jsr:@std/internal'],
        },
      },
      npm: {
        'ansi-regex@6.3.0': {
          integrity: 'sha512-ansi',
          tarball: 'https://mirror.example/ansi-regex-6.3.0.tgz',
        },
        'strip-ansi@7.1.0': { integrity: 'sha512-strip', dependencies: ['ansi-regex'] },
      },
    })
    expect(sidecar.fromCache.toSorted()).toEqual([
      'jsr:@std/internal@1.0.14',
      'jsr:@std/path@1.1.6',
      'npm:ansi-regex@6.3.0',
      'npm:strip-ansi@7.1.0',
    ])
    expect(sidecar.missing).toEqual([])
  })
})
