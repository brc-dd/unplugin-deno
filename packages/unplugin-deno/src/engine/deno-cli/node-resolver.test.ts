import { realpathSync, statSync } from 'node:fs'
import { dirname, join, posix, win32 } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TempDir, TempFiles } from '../../../test/helpers/temp-dir.js'
import { tempDir } from '../../../test/helpers/temp-dir.js'
import { isDenoPluginError } from '../../diagnostics/errors.js'
import { createSilentLogger } from '../../diagnostics/logger.js'
import { toFileUrl } from '../../utils/path.js'
import { loaderEngineFactory } from '../loader/engine.js'
import type { Engine, ResolutionMode } from '../types.js'
import {
  BUILTIN_NODE_MODULES,
  isNodeResolutionError,
  NodeResolver,
  normalizeExports,
  parsePackageName,
  patternKeyCompare,
  withKnownExtension,
} from './node-resolver.js'

/** `node_modules/<name>`: its package.json fields and files. */
function npmPackage(
  name: string,
  fields: Record<string, unknown>,
  files: Record<string, string>,
): TempFiles {
  const result: TempFiles = {
    [`node_modules/${name}/package.json`]: { name, version: '1.0.0', ...fields },
  }
  for (const [file, content] of Object.entries(files)) {
    result[`node_modules/${name}/${file}`] = content
  }
  return result
}

const js = 'export default 1\n'

/** Packages covering the resolution rules; the loader resolves them the same way (BYONM). */
const PACKAGES: TempFiles = {
  ...npmPackage('exp-string', { exports: './main.js' }, { 'main.js': js, 'other.js': js }),
  ...npmPackage(
    'exp-conditions',
    {
      exports: {
        '.': {
          types: './types.d.ts',
          browser: './browser.js',
          import: './import.mjs',
          require: './require.cjs',
          default: './default.js',
        },
        './feature': { node: './feature-node.js', default: './feature.js' },
        './package.json': './package.json',
      },
    },
    {
      'browser.js': js,
      'import.mjs': js,
      'require.cjs': js,
      'default.js': js,
      'feature-node.js': js,
      'feature.js': js,
      'types.d.ts': 'export {}\n',
    },
  ),
  ...npmPackage(
    'exp-patterns',
    {
      exports: {
        '.': './index.js',
        './utils/*': './src/utils/*.js',
        './utils/*.js': './src/utils/*.js',
        './internal/*': null,
        './features/*': { browser: './src/features/*.browser.js', default: './src/features/*.js' },
      },
    },
    {
      'index.js': js,
      'src/utils/a.js': js,
      'src/utils/deep/b.js': js,
      'src/features/x.js': js,
      'src/features/x.browser.js': js,
      'internal/x.js': js,
    },
  ),
  ...npmPackage(
    'exp-array',
    { exports: { '.': [{ worker: './worker.js' }, './fallback.js'] } },
    { 'worker.js': js, 'fallback.js': js },
  ),
  ...npmPackage(
    'exp-sugar',
    { exports: { import: './esm.mjs', require: './cjs.cjs' } },
    { 'esm.mjs': js, 'cjs.cjs': js },
  ),
  ...npmPackage(
    'legacy-main',
    { main: 'lib/main' },
    { 'lib/main.js': js, 'lib/other.js': js, 'lib/relative.js': js, 'lib/dir/index.js': js },
  ),
  ...npmPackage(
    'legacy-module',
    { main: 'cjs.js', module: 'esm.js' },
    { 'cjs.js': js, 'esm.js': js },
  ),
  ...npmPackage(
    'legacy-browser',
    { main: 'main.js', module: 'module.js', browser: 'browser.js' },
    { 'main.js': js, 'module.js': js, 'browser.js': js },
  ),
  ...npmPackage(
    'legacy-browser-object',
    { main: 'main.js', browser: { './main.js': './swapped.js' } },
    { 'main.js': js, 'swapped.js': js },
  ),
  ...npmPackage('legacy-index', {}, { 'index.js': js }),
  ...npmPackage('legacy-dir', { main: 'lib' }, { 'lib/index.js': js }),
  ...npmPackage(
    'imports-pkg',
    {
      exports: './src/index.js',
      imports: {
        '#internal': './src/internal.js',
        '#conds': { browser: './src/browser.js', default: './src/default.js' },
        '#star/*': './src/star/*.js',
        '#dep': 'exp-string',
        '#builtin': 'node:fs',
      },
    },
    {
      'src/index.js': js,
      'src/internal.js': js,
      'src/browser.js': js,
      'src/default.js': js,
      'src/star/one.js': js,
    },
  ),
  ...npmPackage(
    'self-ref',
    { exports: { '.': './index.js', './sub': './sub.js' } },
    { 'index.js': js, 'sub.js': js },
  ),
}

const NAMES = Object.keys(PACKAGES)
  .map((file) => /^node_modules\/(.+)\/package\.json$/.exec(file)?.[1])
  .filter((name) => name !== undefined)

/** Node's `node_modules` lookup, as the engine does it outside the global cache. */
function packageFolder(name: string, referrerPath: string): string | undefined {
  let dir = dirname(referrerPath)
  for (;;) {
    const candidate = join(dir, 'node_modules', name)
    try {
      if (statSync(candidate).isDirectory()) return realpathSync(candidate)
    } catch {
      // not here
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** Specifiers and the file (in the temp project) importing them; `main` is `src/main.ts`. */
const CASES: ReadonlyArray<readonly [specifier: string, referrer: string]> = [
  ['exp-string', 'src/main.ts'],
  ['exp-string/other', 'src/main.ts'],
  ['exp-conditions', 'src/main.ts'],
  ['exp-conditions/feature', 'src/main.ts'],
  ['exp-conditions/package.json', 'src/main.ts'],
  ['exp-patterns', 'src/main.ts'],
  ['exp-patterns/utils/a', 'src/main.ts'],
  ['exp-patterns/utils/deep/b', 'src/main.ts'],
  ['exp-patterns/utils/a.js', 'src/main.ts'],
  ['exp-patterns/internal/x', 'src/main.ts'],
  ['exp-patterns/features/x', 'src/main.ts'],
  ['exp-array', 'src/main.ts'],
  ['exp-sugar', 'src/main.ts'],
  ['legacy-main', 'src/main.ts'],
  ['legacy-main/lib/other', 'src/main.ts'],
  ['legacy-main/lib/dir', 'src/main.ts'],
  ['legacy-module', 'src/main.ts'],
  ['legacy-browser', 'src/main.ts'],
  ['legacy-browser-object', 'src/main.ts'],
  ['legacy-index', 'src/main.ts'],
  ['legacy-dir', 'src/main.ts'],
  ['#internal', 'node_modules/imports-pkg/src/index.js'],
  ['#conds', 'node_modules/imports-pkg/src/index.js'],
  ['#star/one', 'node_modules/imports-pkg/src/index.js'],
  ['#dep', 'node_modules/imports-pkg/src/index.js'],
  ['#builtin', 'node_modules/imports-pkg/src/index.js'],
  ['#missing', 'node_modules/imports-pkg/src/index.js'],
  ['self-ref/sub', 'node_modules/self-ref/index.js'],
  ['./relative', 'node_modules/legacy-main/lib/main.js'],
  ['./dir', 'node_modules/legacy-main/lib/main.js'],
  ['./missing', 'node_modules/legacy-main/lib/main.js'],
  ['fs', 'node_modules/legacy-main/lib/main.js'],
  ['node:path', 'node_modules/legacy-main/lib/main.js'],
  ['exp-string', 'node_modules/legacy-main/lib/main.js'],
  ['missing-package', 'node_modules/legacy-main/lib/main.js'],
]

/** A resolution as a comparable string: the canonical file, a builtin, or the error code. */
function describeResolution(temp: TempDir, run: () => string): string {
  try {
    const result = run()
    if (result.startsWith('node:')) return result
    return posix.relative(
      temp.root.replaceAll('\\', '/'),
      realpathSync(result).replaceAll('\\', '/'),
    )
  } catch (error) {
    if (isDenoPluginError(error)) return `error ${error.code}`
    if (isNodeResolutionError(error)) {
      const code =
        error.code === 'ERR_MODULE_NOT_FOUND'
          ? 'RESOLVE_NOT_FOUND'
          : error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'
            ? 'RESOLVE_NOT_EXPORTED'
            : 'RESOLVE_FAILED'
      return `error ${code}`
    }
    throw error
  }
}

describe('NodeResolver agrees with the vendored loader (node_resolver 0.80.0, bundle mode)', () => {
  let temp: TempDir

  beforeAll(async () => {
    temp = await tempDir({
      'deno.json': { nodeModulesDir: 'manual' },
      'package.json': {
        name: 'app',
        private: true,
        dependencies: Object.fromEntries(NAMES.map((name) => [name, '*'])),
      },
      'src/main.ts': 'export {}\n',
      ...PACKAGES,
    })
  })

  afterAll(async () => {
    await temp?.dispose()
  })

  const platforms = ['browser', 'node'] as const
  const modes: ResolutionMode[] = ['import', 'require']
  it.each(platforms.flatMap((platform) => modes.map((mode) => [platform, mode] as const)))(
    'on the %s platform in %s mode',
    { timeout: 60_000 },
    async (platform, mode) => {
      const engine: Engine = await loaderEngineFactory.create({
        project: {
          root: temp.root,
          workspaceRoot: temp.root,
          configPath: temp.path('deno.json'),
          lockfilePath: undefined,
          nodeModulesDir: 'manual',
        },
        platform,
        conditions: [],
        cachedOnly: true,
        logger: createSilentLogger(),
      })
      try {
        const resolver = new NodeResolver({ platform, conditions: [], host: { packageFolder } })
        for (const [specifier, referrer] of CASES) {
          const referrerPath = temp.path(referrer)
          const expected = await (async () => {
            try {
              const resolved = await engine.resolve(specifier, toFileUrl(referrerPath), mode)
              return describeResolution(temp, () => resolved.path ?? resolved.url)
            } catch (error) {
              return describeResolution(temp, () => {
                throw error
              })
            }
          })()
          const actual = describeResolution(temp, () => {
            const resolved = resolver.resolve(specifier, referrerPath, mode)
            return resolved.kind === 'path'
              ? resolved.path
              : resolved.kind === 'builtin'
                ? resolved.specifier
                : resolved.url
          })
          expect({ specifier, referrer, resolution: actual }).toEqual({
            specifier,
            referrer,
            resolution: expected,
          })
        }
      } finally {
        await engine.dispose()
      }
    },
  )
})

describe('NodeResolver', () => {
  it('uses the platform conditions, extra conditions first', () => {
    const host = { packageFolder: () => undefined }
    const browser = new NodeResolver({ platform: 'browser', conditions: ['worker'], host })
    expect(browser.conditions('import')).toEqual(['worker', 'browser', 'import'])
    expect(browser.conditions('require')).toEqual(['worker', 'browser', 'require'])
    const node = new NodeResolver({ platform: 'node', conditions: [], host })
    expect(node.conditions('import')).toEqual(['deno', 'node', 'import'])
    expect(node.conditions('require')).toEqual(['require', 'node'])
  })

  it('resolves builtins, node: and data: URLs without the file system', () => {
    const resolver = new NodeResolver({
      platform: 'node',
      conditions: [],
      host: { packageFolder: () => undefined },
    })
    const referrer = join(process.cwd(), 'x.js')
    expect(resolver.resolve('fs/promises', referrer, 'import')).toEqual({
      kind: 'builtin',
      specifier: 'node:fs/promises',
    })
    expect(resolver.resolve('node:test', referrer, 'import')).toEqual({
      kind: 'builtin',
      specifier: 'node:test',
    })
    expect(resolver.resolve('data:text/javascript,1', referrer, 'import')).toEqual({
      kind: 'url',
      url: 'data:text/javascript,1',
    })
    for (const [specifier, code] of [
      ['node:nope', 'ERR_UNKNOWN_BUILTIN_MODULE'],
      ['https://example.com/x.js', 'ERR_UNSUPPORTED_ESM_URL_SCHEME'],
      ['@scope', 'ERR_INVALID_MODULE_SPECIFIER'],
      ['#', 'ERR_INVALID_MODULE_SPECIFIER'],
    ] as const) {
      expect(() => resolver.resolve(specifier, referrer, 'import')).toThrow(
        expect.objectContaining({ code }),
      )
    }
    // Packages that shadow builtin names elsewhere are not builtins here.
    for (const name of ['ws', 'undici', 'bun', 'test', 'sqlite']) {
      expect(BUILTIN_NODE_MODULES.has(name)).toBe(false)
    }
  })

  it('reports the missing package of a bare import', async () => {
    await using temp = await tempDir({ 'lib/x.js': js })
    const resolver = new NodeResolver({
      platform: 'node',
      conditions: [],
      host: { packageFolder: () => undefined },
    })
    let caught: unknown
    try {
      resolver.resolve('left-pad/x', temp.path('lib/x.js'), 'import')
    } catch (error) {
      caught = error
    }
    expect(isNodeResolutionError(caught, 'ERR_MODULE_NOT_FOUND')).toBe(true)
    expect(caught).toMatchObject({ packageName: 'left-pad' })
  })

  it('does not cache a package.json that is missing (it may be installed later)', async () => {
    await using temp = await tempDir({ 'pkg/index.js': js })
    const resolver = new NodeResolver({
      platform: 'node',
      conditions: [],
      host: { packageFolder: () => undefined },
    })
    expect(resolver.packageJson(temp.path('pkg'))).toBeUndefined()
    await temp.write({ 'pkg/package.json': { name: 'pkg', version: '2.0.0' } })
    expect(resolver.packageJson(temp.path('pkg'))).toMatchObject({ name: 'pkg', version: '2.0.0' })
  })

  it('reads optional dependencies and ignores the object form of browser', async () => {
    await using temp = await tempDir({
      'package.json': {
        name: 'p',
        browser: { './a.js': false },
        optionalDependencies: { fsevents: '*' },
        peerDependencies: { react: '*', vue: '*' },
        peerDependenciesMeta: { vue: { optional: true } },
      },
    })
    const resolver = new NodeResolver({
      platform: 'browser',
      conditions: [],
      host: { packageFolder: () => undefined },
    })
    const manifest = resolver.packageJson(temp.root)
    expect(manifest).toMatchObject({ browser: undefined, optionalDependencies: { fsevents: '*' } })
    expect([...(manifest?.optionalPeers ?? [])]).toEqual(['vue'])
  })
})

describe('node-resolver helpers', () => {
  it('normalizeExports treats strings, arrays and condition objects as the main export', () => {
    expect(normalizeExports('./x.js')).toEqual({ '.': './x.js' })
    expect(normalizeExports(['./x.js'])).toEqual({ '.': ['./x.js'] })
    expect(normalizeExports({ import: './x.mjs' })).toEqual({ '.': { import: './x.mjs' } })
    expect(normalizeExports({ '.': './x.js', './y': './y.js' })).toEqual({
      '.': './x.js',
      './y': './y.js',
    })
    expect(normalizeExports(null)).toBeUndefined()
    expect(normalizeExports(undefined)).toBeUndefined()
  })

  it('patternKeyCompare orders pattern keys like Node.js', () => {
    expect(patternKeyCompare('', './utils/*')).toBe(1)
    expect(patternKeyCompare('./utils/*', './utils/*.js')).toBe(1)
    expect(patternKeyCompare('./utils/*.js', './utils/*')).toBe(-1)
    expect(patternKeyCompare('./a/*', './a/b/*')).toBe(1)
    expect(patternKeyCompare('./a/*', './a/*')).toBe(0)
  })

  it('parsePackageName splits names and subpaths', () => {
    expect(parsePackageName('kleur', 'r')).toEqual({ name: 'kleur', subpath: '.' })
    expect(parsePackageName('kleur/colors', 'r')).toEqual({ name: 'kleur', subpath: './colors' })
    expect(parsePackageName('@s/p/a/b', 'r')).toEqual({ name: '@s/p', subpath: './a/b' })
    expect(() => parsePackageName('@s', 'r')).toThrow(/not a valid package name/)
    expect(() => parsePackageName('a%2f', 'r')).toThrow(/not a valid package name/)
  })

  it('withKnownExtension replaces known extensions and appends others', () => {
    for (const [syntax, root] of [
      [posix, '/p/'],
      [win32, 'C:\\p\\'],
    ] as const) {
      const at = (name: string): string => syntax.join(root, name)
      expect(withKnownExtension(at('lib'), 'js', syntax)).toBe(at('lib.js'))
      expect(withKnownExtension(at('x.ts'), 'js', syntax)).toBe(at('x.js'))
      expect(withKnownExtension(at('x.d.ts'), 'js', syntax)).toBe(at('x.js'))
      expect(withKnownExtension(at('x.json'), 'js', syntax)).toBe(at('x.js'))
      expect(withKnownExtension(at('x.min'), 'js', syntax)).toBe(at('x.min.js'))
      expect(withKnownExtension(at('x.css'), 'js', syntax)).toBe(at('x.css.js'))
    }
  })
})
