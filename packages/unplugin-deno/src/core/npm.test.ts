import { mkdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { tempDir } from '../../test/helpers/temp-dir.js'
import type { ResolvedModule } from '../engine/types.js'
import type { PathFlavor } from '../utils/path.js'
import {
  denoDirVariants,
  isGlobalCachePath,
  isNodeModulesPath,
  npmOutcome,
  npmStrategyFor,
} from './npm.js'

describe('npmStrategyFor', () => {
  it('follows nodeModulesDir for auto and keeps explicit choices', () => {
    expect(npmStrategyFor('auto', 'none')).toBe('deno-cache')
    expect(npmStrategyFor('auto', 'auto')).toBe('node_modules')
    expect(npmStrategyFor('auto', 'manual')).toBe('node_modules')
    expect(npmStrategyFor('node_modules', 'none')).toBe('node_modules')
    expect(npmStrategyFor('deno-cache', 'manual')).toBe('deno-cache')
  })
})

describe('isNodeModulesPath', () => {
  it.each<[string, PathFlavor, boolean]>([
    ['/p/node_modules/.deno/kleur@4.1.5/node_modules/kleur/index.mjs', 'posix', true],
    ['/p/node_modules/kleur/index.mjs', 'posix', true],
    ['/p/node_modules/.pnpm/kleur@4.1.5/node_modules/kleur/index.mjs', 'posix', true],
    ['/p/node_modules', 'posix', false],
    ['/p/node_modules_backup/x.js', 'posix', false],
    ['/p/src/main.ts', 'posix', false],
    ['C:\\p\\node_modules\\kleur\\index.mjs', 'win32', true],
    ['C:/p/node_modules/kleur/index.mjs', 'win32', true],
    ['C:\\p\\src\\node_modules.ts', 'win32', false],
  ])('%s (%s) → %s', (path, flavor, expected) => {
    expect(isNodeModulesPath(path, flavor)).toBe(expected)
  })
})

describe('isGlobalCachePath', () => {
  it.each<[string, string | string[] | undefined, PathFlavor, boolean]>([
    [
      '/home/u/.cache/deno/npm/registry.npmjs.org/kleur/4.1.5/index.mjs',
      '/home/u/.cache/deno',
      'posix',
      true,
    ],
    ['/home/u/.cache/deno/npm', '/home/u/.cache/deno', 'posix', false],
    ['/home/u/.cache/deno/remote/https/x', '/home/u/.cache/deno', 'posix', false],
    [
      '/private/var/deno/npm/registry.npmjs.org/ms/2.1.3/index.js',
      ['/var/deno', '/private/var/deno'],
      'posix',
      true,
    ],
    ['/p/node_modules/kleur/index.mjs', '/home/u/.cache/deno', 'posix', false],
    ['/p/x.js', undefined, 'posix', false],
    [
      'C:\\Users\\u\\AppData\\Local\\deno\\npm\\registry.npmjs.org\\ms\\2.1.3\\index.js',
      'C:\\Users\\u\\AppData\\Local\\deno',
      'win32',
      true,
    ],
    [
      'c:\\users\\u\\appdata\\local\\deno\\npm\\x\\index.js',
      'C:\\Users\\u\\AppData\\Local\\deno',
      'win32',
      true,
    ],
    ['D:\\deno\\npm\\x\\index.js', 'C:\\deno', 'win32', false],
  ])('%s in %j (%s) → %s', (path, denoDir, flavor, expected) => {
    expect(isGlobalCachePath(path, denoDir, flavor)).toBe(expected)
  })

  it('lists the real path of a symlinked DENO_DIR too', async () => {
    const dir = await tempDir({ 'real/npm': null })
    onTestFinished(() => dir.dispose())
    const link = dir.path('link')
    await symlink(dir.path('real'), link, 'junction')
    expect(denoDirVariants(link)).toEqual([link, dir.path('real')])
    expect(denoDirVariants(dir.path('real'))).toEqual([dir.path('real')])
    expect(denoDirVariants(undefined)).toEqual([])
  })
})

function resolvedNpm(
  path: string,
  info: { name: string; version: string; subpath: string; packageDir: string },
  sideEffects: boolean | null = null,
  flavor: PathFlavor = 'posix',
): ResolvedModule {
  const separator = flavor === 'win32' ? '\\' : '/'
  return {
    kind: 'npm',
    url: 'file:///ignored',
    path,
    mediaType: 'Mjs',
    npm: { ...info, packageJsonPath: `${info.packageDir}${separator}package.json` },
    sideEffects,
  }
}

describe('npmOutcome', () => {
  const isolated = resolvedNpm('/p/node_modules/.deno/kleur@4.1.5/node_modules/kleur/colors.mjs', {
    name: 'kleur',
    version: '4.1.5',
    subpath: '/colors',
    packageDir: '/p/node_modules/.deno/kleur@4.1.5/node_modules/kleur',
  })
  const context = {
    strategy: 'node_modules' as const,
    denoDirs: ['/home/u/.cache/deno'],
    query: '',
    flavor: 'posix' as const,
  }

  it('redirects node_modules files to the host (isolated layout)', () => {
    expect(npmOutcome(isolated, 'npm:kleur@^4/colors', context)).toEqual({
      type: 'npm-redirect',
      request: 'kleur/colors',
      resolveDir: '/p/node_modules/.deno/kleur@4.1.5/node_modules/kleur',
      packageJsonPath: '/p/node_modules/.deno/kleur@4.1.5/node_modules/kleur/package.json',
      rawSpecifier: 'npm:kleur@^4/colors',
      fallbackPath: '/p/node_modules/.deno/kleur@4.1.5/node_modules/kleur/colors.mjs',
      query: '',
      sideEffects: null,
    })
  })

  it('redirects hoisted and pnpm layouts, keeping the query and sideEffects', () => {
    const hoisted = resolvedNpm(
      '/p/node_modules/lodash-es/lodash.js',
      {
        name: 'lodash-es',
        version: '4.18.1',
        subpath: '',
        packageDir: '/p/node_modules/lodash-es',
      },
      false,
    )
    expect(npmOutcome(hoisted, 'npm:lodash-es@4', { ...context, query: '?raw' })).toMatchObject({
      type: 'npm-redirect',
      request: 'lodash-es',
      query: '?raw',
      sideEffects: false,
    })
    const pnpm = resolvedNpm(
      '/p/node_modules/.pnpm/@scope+pkg@1.0.0/node_modules/@scope/pkg/dist/x.js',
      {
        name: '@scope/pkg',
        version: '1.0.0',
        subpath: '/x',
        packageDir: '/p/node_modules/.pnpm/@scope+pkg@1.0.0/node_modules/@scope/pkg',
      },
    )
    expect(npmOutcome(pnpm, 'npm:@scope/pkg@1/x', context)).toMatchObject({
      type: 'npm-redirect',
      request: '@scope/pkg/x',
    })
  })

  it('redirects bare package.json names too', () => {
    expect(npmOutcome(isolated, 'kleur/colors', context)).toMatchObject({ request: 'kleur/colors' })
  })

  it('loads the file when the specifier does not name the package', () => {
    const inner = resolvedNpm('/p/node_modules/kleur/lib/x.js', {
      name: 'kleur',
      version: '4.1.5',
      subpath: '/lib/x.js',
      packageDir: '/p/node_modules/kleur',
    })
    expect(npmOutcome(inner, './lib/x.js', context)).toEqual({
      type: 'path',
      path: '/p/node_modules/kleur/lib/x.js',
      sideEffects: null,
    })
    expect(npmOutcome(isolated, 'npm:other@1', context).type).toBe('path')
  })

  it('loads global-cache files as paths, with the query and sideEffects', () => {
    const cached = resolvedNpm(
      '/home/u/.cache/deno/npm/registry.npmjs.org/lodash-es/4.18.1/lodash.js',
      {
        name: 'lodash-es',
        version: '4.18.1',
        subpath: '',
        packageDir: '/home/u/.cache/deno/npm/registry.npmjs.org/lodash-es/4.18.1',
      },
      false,
    )
    expect(npmOutcome(cached, 'npm:lodash-es@4', { ...context, query: '?x' })).toEqual({
      type: 'path',
      path: '/home/u/.cache/deno/npm/registry.npmjs.org/lodash-es/4.18.1/lodash.js?x',
      sideEffects: false,
    })
  })

  it('loads node_modules files as paths with the deno-cache strategy', () => {
    expect(
      npmOutcome(isolated, 'npm:kleur@^4/colors', { ...context, strategy: 'deno-cache' }),
    ).toMatchObject({
      type: 'path',
      path: isolated.path,
    })
  })

  it('handles Windows paths', () => {
    const windows = resolvedNpm(
      'C:\\p\\node_modules\\.deno\\kleur@4.1.5\\node_modules\\kleur\\index.mjs',
      {
        name: 'kleur',
        version: '4.1.5',
        subpath: '',
        packageDir: 'C:\\p\\node_modules\\.deno\\kleur@4.1.5\\node_modules\\kleur',
      },
      null,
      'win32',
    )
    expect(
      npmOutcome(windows, 'npm:kleur@4', {
        ...context,
        denoDirs: ['C:\\Users\\u\\AppData\\Local\\deno'],
        flavor: 'win32',
      }),
    ).toMatchObject({
      type: 'npm-redirect',
      request: 'kleur',
      packageJsonPath: 'C:\\p\\node_modules\\.deno\\kleur@4.1.5\\node_modules\\kleur\\package.json',
    })
    const cached = {
      ...windows,
      path: 'C:\\Users\\u\\AppData\\Local\\deno\\npm\\registry.npmjs.org\\kleur\\4.1.5\\index.mjs',
    }
    expect(
      npmOutcome(cached, 'npm:kleur@4', {
        ...context,
        denoDirs: ['C:\\Users\\u\\AppData\\Local\\deno'],
        flavor: 'win32',
      }).type,
    ).toBe('path')
  })

  it('derives the path from the URL when the engine gave none', () => {
    const noPath: ResolvedModule = {
      kind: 'npm',
      url: 'file:///p/node_modules/x/index.js',
      mediaType: 'JavaScript',
    }
    expect(npmOutcome(noPath, 'npm:x', context)).toEqual({
      type: 'path',
      path: '/p/node_modules/x/index.js',
      sideEffects: null,
    })
  })
})

describe('npmOutcome on disk', () => {
  it('uses real package directories', async () => {
    const dir = await tempDir({
      'node_modules/kleur/package.json': { name: 'kleur', version: '4.1.5' },
    })
    onTestFinished(() => dir.dispose())
    await mkdir(dir.path('node_modules/kleur/lib'), { recursive: true })
    const file = join(dir.root, 'node_modules', 'kleur', 'index.mjs')
    const resolved = resolvedNpm(file, {
      name: 'kleur',
      version: '4.1.5',
      subpath: '',
      packageDir: join(dir.root, 'node_modules', 'kleur'),
    })
    expect(
      npmOutcome(resolved, 'npm:kleur@4', { strategy: 'node_modules', denoDirs: [], query: '' }),
    ).toMatchObject({ type: 'npm-redirect', resolveDir: join(dir.root, 'node_modules', 'kleur') })
  })
})
