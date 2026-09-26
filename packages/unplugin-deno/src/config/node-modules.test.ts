import { afterEach, describe, expect, it } from 'vitest'
import { tempDir } from '../../test/helpers/temp-dir.js'
import type { TempDir, TempFiles } from '../../test/helpers/temp-dir.js'
import type { DenoConfig } from './deno-config.js'
import type { ConfigFolder } from './discover.js'
import { detectNodeModules } from './node-modules.js'
import type { PackageJson } from './package-json.js'

let dir: TempDir | undefined

afterEach(async () => {
  await dir?.dispose()
  dir = undefined
})

async function detect(
  files: TempFiles,
  config: DenoConfig | null,
  packageJson: PackageJson | null = null,
): ReturnType<typeof detectNodeModules> {
  dir = await tempDir(files)
  const rootFolder: ConfigFolder | null =
    config === null && packageJson === null
      ? null
      : {
          dir: dir.root,
          dirUrl: dir.url('/'),
          realDir: dir.root,
          denoJson:
            config === null
              ? null
              : { path: dir.path('deno.json'), url: dir.url('deno.json'), config, importMap: null },
          packageJson:
            packageJson === null
              ? null
              : { path: dir.path('package.json'), url: dir.url('package.json'), json: packageJson },
        }
  return detectNodeModules({ rootFolder, workspaceRoot: dir.root })
}

describe('detectNodeModules: mode (Deno 2.9 raw_node_modules_dir_mode)', () => {
  it.each<[DenoConfig, string, boolean]>([
    [{ nodeModulesDir: 'auto' }, 'auto', true],
    [{ nodeModulesDir: 'manual' }, 'manual', true],
    [{ nodeModulesDir: 'none' }, 'none', true],
    [{ nodeModulesDir: true }, 'auto', true],
    [{ nodeModulesDir: false }, 'none', true],
    [{}, 'none', false],
    [{ vendor: true }, 'auto', false],
    [{ vendor: false }, 'none', false],
  ])('%j -> %s', async (config, mode, explicit) => {
    expect(await detect({}, config)).toMatchObject({ mode, explicit })
  })

  it('is manual when the workspace root has a package.json (verified: deno install creates node_modules)', async () => {
    expect(await detect({}, {}, { name: 'root' })).toMatchObject({
      mode: 'manual',
      explicit: false,
    })
    expect(await detect({}, null, { name: 'root' })).toMatchObject({
      mode: 'manual',
      explicit: false,
    })
    expect(await detect({}, { nodeModulesDir: 'none' }, { name: 'root' })).toMatchObject({
      mode: 'none',
      explicit: true,
    })
  })

  it('is none without any config', async () => {
    expect(await detect({}, null)).toEqual({
      mode: 'none',
      explicit: false,
      dir: null,
      layout: null,
      hasJsrDeps: false,
      foreignManager: null,
    })
  })
})

describe('detectNodeModules: layout', () => {
  it("detects Deno's isolated linker (node_modules/.deno/<pkg>@<version>)", async () => {
    const info = await detect(
      {
        'node_modules/.deno/.deno.lock': '',
        'node_modules/.deno/left-pad@1.3.0/node_modules/left-pad/package.json': '{}',
        'node_modules/left-pad/package.json': '{}',
      },
      { nodeModulesDir: 'auto' },
    )
    expect(info).toEqual({
      mode: 'auto',
      explicit: true,
      dir: dir?.path('node_modules'),
      layout: 'isolated',
      hasJsrDeps: false,
      foreignManager: null,
    })
  })

  it("detects hoisted layouts (npm, Yarn, Bun, Deno's hoisted linker)", async () => {
    // Deno's hoisted linker keeps only a lock file in node_modules/.deno (verified with 2.9.7).
    const info = await detect(
      { 'node_modules/.deno/.deno.lock': '', 'node_modules/kleur/package.json': '{}' },
      { nodeModulesDir: 'manual', nodeModulesLinker: 'hoisted' },
    )
    expect(info.layout).toBe('hoisted')
  })

  it('detects pnpm', async () => {
    const info = await detect(
      { 'node_modules/.pnpm/kleur@4.1.5/node_modules/kleur/package.json': '{}' },
      {},
      { name: 'app' },
    )
    expect(info).toMatchObject({ mode: 'manual', layout: 'pnpm' })
  })

  it('detects jsr packages installed from npm.jsr.io (jsrDepsInNodeModules)', async () => {
    const info = await detect(
      {
        'node_modules/.deno/@jsr+std__fmt@1.0.10/node_modules/@jsr/std__fmt/package.json': '{}',
        'node_modules/@jsr/std__fmt/package.json': '{}',
      },
      { nodeModulesDir: 'auto', jsrDepsInNodeModules: true },
    )
    expect(info).toMatchObject({ layout: 'isolated', hasJsrDeps: true })
  })

  it('reports no layout for a node_modules without packages (e.g. only caches)', async () => {
    const info = await detect(
      { 'node_modules/.unplugin-deno/x.js': '', 'node_modules/.vite/deps.json': '{}' },
      {},
    )
    expect(info).toMatchObject({ dir: dir?.path('node_modules'), layout: null, hasJsrDeps: false })
  })

  it('needs packages in node_modules/@jsr to report jsr dependencies', async () => {
    const info = await detect(
      { 'node_modules/@jsr/': null, 'node_modules/kleur/package.json': '{}' },
      {},
    )
    expect(info).toMatchObject({ layout: 'hoisted', hasJsrDeps: false })
  })

  it('ignores a node_modules file', async () => {
    const info = await detect({ node_modules: 'not a directory' }, {})
    expect(info).toMatchObject({ dir: null, layout: null, foreignManager: null })
  })
})

describe('detectNodeModules: node_modules installed by another package manager', () => {
  it.each<[string, string]>([
    ['node_modules/.pnpm/kleur@4.1.5/node_modules/kleur/package.json', 'pnpm'],
    ['node_modules/.modules.yaml', 'pnpm'],
    ['node_modules/.package-lock.json', 'npm'],
    ['node_modules/.yarn-integrity', 'yarn'],
    ['node_modules/.yarn-state.yml', 'yarn'],
  ])('%s -> %s', async (marker, manager) => {
    const info = await detect(
      { [marker]: '{}', 'node_modules/kleur/package.json': '{}' },
      {
        nodeModulesDir: 'auto',
      },
    )
    expect(info).toMatchObject({ mode: 'auto', foreignManager: manager })
  })

  it("does not take Deno's own node_modules for a foreign one", async () => {
    const info = await detect(
      {
        'node_modules/.deno/.deno.lock': '',
        'node_modules/.deno/kleur@4.1.5/node_modules/kleur/package.json': '{}',
        'node_modules/kleur/package.json': '{}',
      },
      { nodeModulesDir: 'auto' },
    )
    expect(info).toMatchObject({ layout: 'isolated', foreignManager: null })
  })
})
