import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import type { PackageJsonFields } from './npm-package.js'
import {
  canonicalize,
  NpmPackageLocator,
  readPackageJsonFields,
  realpathMaybeMissing,
} from './npm-package.js'

/** A locator over an in-memory set of package.json files. */
function locator(
  flavor: 'posix' | 'win32',
  packages: Record<string, Partial<PackageJsonFields>>,
  cacheRoots: string[] = [],
): NpmPackageLocator {
  return new NpmPackageLocator(
    () => cacheRoots,
    flavor,
    (dir) => {
      const fields = packages[dir]
      if (fields?.name === undefined) return undefined
      return {
        name: fields.name,
        version: fields.version ?? '',
        sideEffects: fields.sideEffects ?? null,
      }
    },
  )
}

describe('NpmPackageLocator (posix)', () => {
  const root = '/work/app'
  const deno = `${root}/node_modules/.deno/kleur@4.1.5/node_modules/kleur`
  const cache = '/cache/deno/npm'
  const packages = {
    [deno]: { name: 'kleur', version: '4.1.5' },
    [`${root}/node_modules/.pnpm/kleur@4.1.5/node_modules/kleur`]: {
      name: 'kleur',
      version: '4.1.5',
    },
    [`${root}/node_modules/@scope/pkg`]: {
      name: '@scope/pkg',
      version: '1.0.0',
      sideEffects: false,
    },
    [`${root}/node_modules/@scope/pkg/dist/esm`]: { name: 'pkg-esm-build' },
    [`${root}/node_modules/rxjs`]: { name: 'rxjs', version: '7.8.2' },
    [`${root}/node_modules/rxjs/ajax`]: { name: 'rxjs/ajax' },
    [`${cache}/registry.npmjs.org/kleur/4.1.5`]: { name: 'kleur', version: '4.1.5' },
    [`${cache}/registry.npmjs.org/@types/node/22.0.0`]: { name: '@types/node', version: '22.0.0' },
    [`${root}/src`]: { name: 'app' },
  }
  const npm = locator('posix', packages, [cache])

  it('tells npm locations from local files', () => {
    expect(npm.contains(`${deno}/index.mjs`)).toBe(true)
    expect(npm.contains(`${cache}/registry.npmjs.org/kleur/4.1.5/index.mjs`)).toBe(true)
    expect(npm.contains(`${root}/src/main.ts`)).toBe(false)
    expect(npm.contains(`${root}/node_modules`)).toBe(false)
    expect(npm.contains(cache)).toBe(false)
    expect(npm.contains('/cache/deno/npm-other/x.js')).toBe(false)
  })

  it('finds packages in node_modules/.deno, .pnpm and hoisted layouts', () => {
    expect(npm.find(`${deno}/index.mjs`, 'kleur')).toMatchObject({
      name: 'kleur',
      version: '4.1.5',
      dir: deno,
      packageJsonPath: `${deno}/package.json`,
    })
    expect(
      npm.find(`${root}/node_modules/.pnpm/kleur@4.1.5/node_modules/kleur/colors.mjs`)?.dir,
    ).toBe(`${root}/node_modules/.pnpm/kleur@4.1.5/node_modules/kleur`)
    expect(npm.find(`${root}/node_modules/@scope/pkg/index.js`)).toMatchObject({
      name: '@scope/pkg',
      sideEffects: false,
    })
  })

  it('skips nested package.json files', () => {
    expect(npm.find(`${root}/node_modules/@scope/pkg/dist/esm/index.js`)?.name).toBe('@scope/pkg')
    expect(npm.find(`${root}/node_modules/@scope/pkg/dist/esm/index.js`, '@scope/pkg')?.name).toBe(
      '@scope/pkg',
    )
    expect(npm.find(`${root}/node_modules/rxjs/ajax/index.js`, 'rxjs')?.dir).toBe(
      `${root}/node_modules/rxjs`,
    )
    // With a name that does not match (an aliased import), the package root is used.
    expect(npm.find(`${root}/node_modules/rxjs/ajax/index.js`, 'alias')?.dir).toBe(
      `${root}/node_modules/rxjs`,
    )
  })

  it('finds packages in the global npm cache', () => {
    expect(npm.find(`${cache}/registry.npmjs.org/kleur/4.1.5/index.mjs`, 'kleur')).toMatchObject({
      dir: `${cache}/registry.npmjs.org/kleur/4.1.5`,
      version: '4.1.5',
    })
    expect(npm.find(`${cache}/registry.npmjs.org/@types/node/22.0.0/fs.d.ts`)?.name).toBe(
      '@types/node',
    )
  })

  it('returns nothing outside npm locations', () => {
    expect(npm.find(`${root}/src/main.ts`)).toBeUndefined()
    expect(npm.find(`${root}/node_modules/unknown/index.js`)).toBeUndefined()
  })
})

describe('NpmPackageLocator (win32)', () => {
  const root = 'C:\\work\\app'
  const cache = 'C:\\Users\\u\\AppData\\Local\\deno\\npm'
  const packages = {
    [`${root}\\node_modules\\.deno\\kleur@4.1.5\\node_modules\\kleur`]: {
      name: 'kleur',
      version: '4.1.5',
    },
    [`${cache}\\registry.npmjs.org\\kleur\\4.1.5`]: { name: 'kleur', version: '4.1.5' },
  }
  const npm = locator('win32', packages, [cache])

  it('finds packages with Windows paths', () => {
    const file = `${root}\\node_modules\\.deno\\kleur@4.1.5\\node_modules\\kleur\\index.mjs`
    expect(npm.contains(file)).toBe(true)
    expect(npm.find(file, 'kleur')).toMatchObject({
      dir: `${root}\\node_modules\\.deno\\kleur@4.1.5\\node_modules\\kleur`,
      packageJsonPath: `${root}\\node_modules\\.deno\\kleur@4.1.5\\node_modules\\kleur\\package.json`,
    })
    expect(
      npm.contains(
        `c:\\users\\u\\appdata\\local\\deno\\npm\\registry.npmjs.org\\kleur\\4.1.5\\index.mjs`,
      ),
    ).toBe(true)
    expect(npm.find(`${cache}\\registry.npmjs.org\\kleur\\4.1.5\\colors.mjs`)?.version).toBe(
      '4.1.5',
    )
    expect(npm.contains(`${root}\\src\\main.ts`)).toBe(false)
  })

  it('reads each package.json once', () => {
    let reads = 0
    const counting = new NpmPackageLocator(
      () => [],
      'win32',
      () => {
        reads++
        return undefined
      },
    )
    counting.find(`${root}\\node_modules\\pkg\\a\\b.js`)
    counting.find(`${root}\\node_modules\\pkg\\a\\c.js`)
    expect(reads).toBe(2)
  })
})

describe('readPackageJsonFields', () => {
  it('reads name, version and a boolean sideEffects', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'unplugin-deno-pkg-'))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    const write = async (name: string, content: string): Promise<string> => {
      await mkdir(join(dir, name))
      await writeFile(join(dir, name, 'package.json'), content)
      return join(dir, name)
    }
    expect(
      readPackageJsonFields(await write('a', '{"name":"a","version":"1.0.0","sideEffects":false}')),
    ).toEqual({
      name: 'a',
      version: '1.0.0',
      sideEffects: false,
    })
    expect(readPackageJsonFields(await write('b', '{"name":"b","sideEffects":["*.css"]}'))).toEqual(
      {
        name: 'b',
        version: '',
        sideEffects: null,
      },
    )
    expect(readPackageJsonFields(await write('c', '{"type":"module"}'))).toBeUndefined()
    expect(readPackageJsonFields(await write('d', '{ not json'))).toBeUndefined()
    expect(readPackageJsonFields(join(dir, 'missing'))).toBeUndefined()
  })
})

/** A temporary directory with `target/file.js`, removed after the test. */
async function scratch(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'unplugin-deno-real-')))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, 'target'))
  await writeFile(join(dir, 'target', 'file.js'), 'x')
  return dir
}

describe('realpathMaybeMissing', () => {
  it('resolves symlinked directories, also below missing parts', async () => {
    const dir = await scratch()
    await symlink(join(dir, 'target'), join(dir, 'link'), 'junction')
    expect(realpathMaybeMissing(join(dir, 'link'))).toBe(join(dir, 'target'))
    expect(realpathMaybeMissing(join(dir, 'link', 'file.js'))).toBe(join(dir, 'target', 'file.js'))
    expect(realpathMaybeMissing(join(dir, 'link', 'missing', 'file.js'))).toBe(
      join(dir, 'target', 'missing', 'file.js'),
    )
    expect(realpathMaybeMissing(join(dir, 'target'))).toBe(join(dir, 'target'))
  })

  // File symlinks need extra privileges on Windows.
  it.skipIf(process.platform === 'win32')('follows file symlinks and stops on loops', async () => {
    const dir = await scratch()
    await symlink('target/file.js', join(dir, 'file-link.js'))
    await symlink('file-link.js', join(dir, 'chain.js'))
    await symlink('loop-b.js', join(dir, 'loop-a.js'))
    await symlink('loop-a.js', join(dir, 'loop-b.js'))
    expect(realpathMaybeMissing(join(dir, 'file-link.js'))).toBe(join(dir, 'target', 'file.js'))
    expect(realpathMaybeMissing(join(dir, 'chain.js'))).toBe(join(dir, 'target', 'file.js'))
    expect(realpathMaybeMissing(join(dir, 'loop-a.js'))).toMatch(/loop-[ab]\.js$/)
  })

  it('tells whether the canonical path exists', async () => {
    const dir = await scratch()
    expect(canonicalize(join(dir, 'target', 'file.js'))).toEqual({
      path: join(dir, 'target', 'file.js'),
      exists: true,
    })
    expect(canonicalize(join(dir, 'target', 'missing.js'))).toEqual({
      path: join(dir, 'target', 'missing.js'),
      exists: false,
    })
  })

  it('keeps the name of a hard-linked file', async () => {
    const dir = await scratch()
    await mkdir(join(dir, 'install'))
    await link(join(dir, 'target', 'file.js'), join(dir, 'install', 'file.js'))
    await readFile(join(dir, 'target', 'file.js'))
    expect(realpathMaybeMissing(join(dir, 'install', 'file.js'))).toBe(
      join(dir, 'install', 'file.js'),
    )
  })
})
