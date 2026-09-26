import { describe, expect, expectTypeOf, it } from 'vitest'
import { denoBinary } from '../../test/helpers/deno-binary.js'
import { tempProject } from '../../test/helpers/temp-project.js'
import type { Project } from '../config/project.js'
import { loadProject } from '../config/project.js'
import type { EngineSelectionFolder, EngineSelectionProject } from './select.js'
import { denoOnlyFeatures, selectEngineKind } from './select.js'

const MISSING_DENO = 'unplugin-deno-test-missing-deno'

function folder(
  denoJson?: EngineSelectionFolder['denoJson'],
  packageJson?: EngineSelectionFolder['packageJson'],
): EngineSelectionFolder {
  return { denoJson: denoJson ?? null, packageJson: packageJson ?? null }
}

function project(overrides: Partial<EngineSelectionProject> = {}): EngineSelectionProject {
  return {
    rootFolder: folder({ path: '/p/deno.json', config: {} }),
    members: [],
    links: [],
    jsrDepsInNodeModules: false,
    ...overrides,
  }
}

describe('denoOnlyFeatures', () => {
  it('accepts the config layer’s Project', () => {
    expectTypeOf<Project>().toExtend<EngineSelectionProject>()
  })

  it('finds nothing in a plain project', () => {
    expect(denoOnlyFeatures(project())).toEqual([])
    expect(
      denoOnlyFeatures(
        project({
          rootFolder: folder({
            path: '/p/deno.json',
            config: { imports: { kleur: 'npm:kleur@^4' }, links: ['../lib'] },
          }),
        }),
      ),
    ).toEqual([])
  })

  it('finds catalog: in deno.json imports and package.json dependencies of every folder', () => {
    const features = denoOnlyFeatures(
      project({
        rootFolder: folder({ path: '/p/deno.json', config: { imports: { kleur: 'catalog:' } } }),
        members: [
          folder(undefined, {
            path: '/p/a/package.json',
            json: { devDependencies: { vitest: 'catalog:testing' } },
          }),
          folder(undefined, { path: '/p/b/package.json', json: { dependencies: { x: '^1' } } }),
        ],
      }),
    )
    expect(features).toEqual([
      {
        feature: 'catalog',
        description: '`catalog:` in the imports of /p/deno.json',
        file: '/p/deno.json',
      },
      {
        feature: 'catalog',
        description: '`catalog:` in the dependencies of /p/a/package.json',
        file: '/p/a/package.json',
      },
    ])
  })

  it('finds globs in the root links (and the deprecated patch)', () => {
    for (const config of [{ links: ['./libs/*'] }, { patch: ['../pkg?'] }, { links: ['!x'] }]) {
      expect(
        denoOnlyFeatures(project({ rootFolder: folder({ path: '/p/deno.json', config }) })),
      ).toEqual([
        {
          feature: 'link-globs',
          description: 'globs in the links of /p/deno.json',
          file: '/p/deno.json',
        },
      ])
    }
  })

  it('finds jsrDepsInNodeModules', () => {
    expect(denoOnlyFeatures(project({ jsrDepsInNodeModules: true }))).toEqual([
      {
        feature: 'jsr-deps-in-node-modules',
        description: '`jsrDepsInNodeModules`',
        file: '/p/deno.json',
      },
    ])
  })

  it('finds the features of the engine-cli fixtures in their loaded projects', async () => {
    await using catalog = await tempProject('engine-cli-catalog')
    expect(
      denoOnlyFeatures(await loadProject(catalog.root)).map((feature) => feature.feature),
    ).toEqual(['catalog', 'catalog'])
    await using links = await tempProject('engine-cli-link-globs')
    expect(
      denoOnlyFeatures(await loadProject(links.root)).map((feature) => feature.feature),
    ).toEqual(['link-globs'])
    await using basic = await tempProject('engine-basic')
    expect(denoOnlyFeatures(await loadProject(basic.root))).toEqual([])
  })
})

describe('selectEngineKind', () => {
  it('follows an explicit engine option without probing Deno', async () => {
    const features = project({ jsrDepsInNodeModules: true })
    const loader = await selectEngineKind({
      engine: 'loader',
      project: features,
      denoBinary: MISSING_DENO,
    })
    expect(loader).toMatchObject({ kind: 'loader', reason: "`engine: 'loader'`" })
    expect(loader.warning).toBeUndefined()
    const deno = await selectEngineKind({
      engine: 'deno',
      project: project(),
      denoBinary: MISSING_DENO,
    })
    expect(deno).toMatchObject({ kind: 'deno', reason: "`engine: 'deno'`" })
    expect(deno.warning).toBeUndefined()
  })

  it('keeps the loader for projects the loader supports', async () => {
    for (const input of [project(), null]) {
      const selection = await selectEngineKind({
        engine: 'auto',
        project: input,
        denoBinary: MISSING_DENO,
      })
      expect(selection).toMatchObject({ kind: 'loader', features: [] })
      expect(selection.warning).toBeUndefined()
    }
  })

  it('falls back to the loader with a warning when the project needs Deno but it is missing', async () => {
    const selection = await selectEngineKind({
      engine: 'auto',
      project: project({ jsrDepsInNodeModules: true }),
      denoBinary: MISSING_DENO,
    })
    expect(selection).toMatchObject({
      kind: 'loader',
      reason: expect.stringContaining('unavailable'),
      warning: expect.stringContaining(MISSING_DENO),
    })
    expect(selection.features).toHaveLength(1)
  })

  it.skipIf(denoBinary.skipReason !== undefined)(
    `picks the deno engine when the project needs it and Deno is installed${denoBinary.skipReason === undefined ? '' : ` (skipped: ${denoBinary.skipReason})`}`,
    async () => {
      const selection = await selectEngineKind({
        engine: 'auto',
        project: project({ jsrDepsInNodeModules: true }),
        denoBinary: denoBinary.binary,
      })
      expect(selection).toMatchObject({
        kind: 'deno',
        reason: expect.stringContaining(`Deno ${denoBinary.version ?? ''}`),
      })
      expect(selection.warning).toBeUndefined()
    },
  )
})
