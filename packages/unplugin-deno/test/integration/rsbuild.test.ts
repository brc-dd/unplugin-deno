/**
 * Rsbuild builds (docs/architecture.md §6.6): the core fixtures built through `rsbuild.setup` (the
 * Rspack plugin added to each environment's Rspack config), with the platform of each Rsbuild
 * environment (`web` → browser, `node` → Deno for projects with a `deno.json`, or the
 * `platform` option), several environments sharing one plugin state in one build; the source
 * transforms per environment, the `deno.json` JSX settings (Rsbuild's `builtin:swc-loader`), the
 * checks and Wasm modules.
 */
import { existsSync, readdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import type { EnvironmentConfig } from '@rsbuild/core'
import { createUnplugin } from 'unplugin'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { Options } from '../../src/core/options.js'
import type { BuildEntries, BuildResult } from '../helpers/build.js'
import { evaluateModule, installCssStyleSheet } from '../helpers/build.js'
import type { RsbuildBuildOptions } from '../helpers/rsbuild.js'
import { buildWithRsbuild } from '../helpers/rsbuild.js'
import {
  entryChunk,
  expectedValues,
  generationDir,
  runUnderDeno,
  slashed,
} from '../helpers/webpack-family.js'
import { HostBuildError } from '../helpers/webpack-stats.js'
import { DENO_AVAILABLE, fixture, importMetaMainCount, warningsWith } from './core-suite.js'

const timeout = { timeout: 180_000 }

const NODE: Record<string, EnvironmentConfig> = { node: { output: { target: 'node' } } }

/** Builds with Rsbuild; the output directory is removed after the test. */
async function bundle(
  root: string,
  entries: BuildEntries,
  options: Options = {},
  extra: RsbuildBuildOptions = {},
): Promise<Record<string, BuildResult>> {
  const out = await buildWithRsbuild(root, entries, options, extra)
  onTestFinished(() => out.dispose())
  return out.environments
}

function only(builds: Record<string, BuildResult>, name: string): BuildResult {
  const build = builds[name]
  if (build === undefined) throw new Error(`no ${name} environment`)
  return build
}

describe('core-basic (rsbuild)', () => {
  it('bundles jsr:, npm:, https:, data:, node:, local and aliased imports', timeout, async () => {
    const project = await fixture('core-basic')
    const builds = await bundle(
      project.root,
      project.manifest.entries,
      { platform: 'node' },
      { environments: NODE },
    )
    const out = only(builds, 'node')
    const { values } = await evaluateModule<{ values: Record<string, unknown> }>(out.entry)
    expect(values).toMatchObject(expectedValues(project))
    expect(stripVTControlCharacters(String(values.colored))).toBe('x')
    expect(entryChunk(out).imports).toEqual(['node:path'])
  })
})

describe('core-remote-mirror (rsbuild)', () => {
  it('bundles jsr: and https: in a web environment from the mirror', timeout, async () => {
    const project = await fixture('core-remote-mirror')
    const expected = project.manifest.expect as {
      values: Record<string, unknown>
      mirror: { closest: string }
    }
    const out = only(await bundle(project.root, project.manifest.entries), 'web')
    expect((await evaluateModule<{ values: unknown }>(out.entry)).values).toEqual(expected.values)
    const chunk = entryChunk(out)
    expect(chunk.imports).toEqual([])
    expect(slashed(chunk.moduleIds)).toContain(
      slashed([join(generationDir(project.root), ...expected.mirror.closest.split('/'))])[0],
    )
  })

  it('resolves each environment for its platform, sharing one plugin state', timeout, async () => {
    const project = await fixture('core-remote-mirror')
    const expected = project.manifest.expect as { values: Record<string, unknown> }
    const builds = await bundle(
      project.root,
      project.manifest.entries,
      {},
      {
        environments: { web: {}, ...NODE },
      },
    )
    // Browser: jsr: bundled; Deno (node target and a deno.json): jsr: external and pinned.
    expect(entryChunk(only(builds, 'web')).imports).toEqual([])
    const server = entryChunk(only(builds, 'node'))
    expect(server.imports).toEqual(['jsr:@std/path@1.1.6/posix'])
    expect(server.code).toContain('function closestString')
    expect((await evaluateModule<{ values: unknown }>(only(builds, 'web').entry)).values).toEqual(
      expected.values,
    )
    // Mirror generations of both platforms.
    const cacheDir = join(project.root, 'node_modules', '.unplugin-deno')
    expect(existsSync(cacheDir)).toBe(true)
  })

  it('takes the platform of an environment from a `platform` record', timeout, async () => {
    const project = await fixture('core-remote-mirror')
    const builds = await bundle(
      project.root,
      project.manifest.entries,
      { platform: { node: 'node' } },
      { environments: NODE },
    )
    // The Node.js platform bundles jsr: imports.
    expect(entryChunk(only(builds, 'node')).imports).toEqual([])
  })
})

describe('core-attributes (rsbuild)', () => {
  it('matches Deno for text, bytes, css and json attributes', timeout, async () => {
    onTestFinished(installCssStyleSheet())
    const project = await fixture('core-attributes')
    const out = only(await bundle(project.root, project.manifest.entries), 'web')
    const mod = await evaluateModule<{
      values: Record<string, unknown>
      dynamicValues: () => Promise<Record<string, unknown>>
    }>(out.entry)
    expect(mod.values).toMatchObject(expectedValues(project))
    expect(mod.values.bytesType).toBe('Uint8Array')
    expect(mod.values.cssType).toBe('CSSStyleSheet')
    expect(mod.values.licenseMatches).toBe(true)
    const expected = expectedValues(project)
    expect(await mod.dynamicValues()).toEqual({
      text: expected.text,
      bytes: expected.bytes,
      json: expected.json,
      css: expected.css,
      license: 'The MIT License ',
    })
  })
})

describe('core-platform-deno (rsbuild)', () => {
  const entries = ['src/server.ts']
  it('keeps npm:, jsr: and node: external and pinned in a node environment', timeout, async () => {
    const project = await fixture('core-platform-deno')
    const expected = project.manifest.expect as { externals: string[] }
    const out = only(await bundle(project.root, entries, {}, { environments: NODE }), 'node')
    const chunk = entryChunk(out)
    expect(chunk.imports.toSorted()).toEqual(expected.externals.toSorted())
    expect(chunk.code).toContain('function closestString')
  })

  it.skipIf(!DENO_AVAILABLE)(
    'runs under `deno run --cached-only` (skipped without a deno binary)',
    timeout,
    async () => {
      const project = await fixture('core-platform-deno')
      const out = only(await bundle(project.root, entries, {}, { environments: NODE }), 'node')
      expect(await runUnderDeno(out, 'server.js')).toEqual(expectedValues(project))
    },
  )
})

describe('core-npm-node-modules (rsbuild)', () => {
  it('bundles npm subpaths, CommonJS and tree-shaken ES packages', timeout, async () => {
    const project = await fixture('core-npm-node-modules')
    const out = only(
      await bundle(
        project.root,
        project.manifest.entries,
        { platform: 'node' },
        { environments: NODE },
      ),
      'node',
    )
    const { values } = await evaluateModule<{ values: Record<string, unknown> }>(out.entry)
    expect(values).toMatchObject(expectedValues(project))
    const lodashBytes = Object.entries(entryChunk(out).moduleSizes)
      .filter(([id]) => /[\\/]lodash-es[\\/]/.test(id))
      .reduce((total, [, size]) => total + size, 0)
    expect(lodashBytes).toBeGreaterThan(0)
    expect(lodashBytes).toBeLessThan(project.manifest.expect?.maxBytes as number)
  })
})

describe('core-workspace (rsbuild)', () => {
  it('resolves members by name and member-scoped aliases', timeout, async () => {
    const project = await fixture('core-workspace')
    const out = only(await bundle(project.root, project.manifest.entries), 'web')
    const { values } = await evaluateModule<{ values: unknown }>(out.entry)
    expect(values).toEqual(expectedValues(project))
  })
})

describe('core-virtual-coexist (rsbuild)', () => {
  it("never intercepts an unplugin-based plugin's virtual: and \\0 ids", timeout, async () => {
    const project = await fixture('core-virtual-coexist')
    const seen: string[] = []
    const companion = createUnplugin(() => ({
      name: 'test-virtual',
      resolveId(source: string) {
        if (!source.startsWith('virtual:')) return null
        seen.push(source)
        return source === 'virtual:answer' ? '\0virtual:answer' : '\0greeting'
      },
      load(id: string) {
        if (id === '\0virtual:answer') return 'export default 42'
        if (id === '\0greeting') {
          return 'const note = "with { type: \'text\' } stays as it is"\nexport default `hi, ${note}`'
        }
        return null
      },
    })).rsbuild()
    const out = only(
      await bundle(
        project.root,
        project.manifest.entries,
        {},
        { config: { plugins: [companion] } },
      ),
      'web',
    )
    const { values } = await evaluateModule<{ values: unknown }>(out.entry)
    expect(values).toEqual(expectedValues(project))
    expect(seen.toSorted()).toEqual(['virtual:answer', 'virtual:greeting'])
  })
})

/** A web environment whose Rspack parser keeps `import.meta.main` as written. */
const WEB_KEEPING_IMPORT_META_MAIN: Record<string, EnvironmentConfig> = {
  web: {
    tools: { rspack: { module: { parser: { javascript: { importMeta: { main: false } } } } } },
  },
}

describe('core-import-meta-main (rsbuild)', () => {
  it('replaces import.meta.main in modules that are not entries', timeout, async () => {
    const project = await fixture('core-import-meta-main')
    const out = only(
      await bundle(
        project.root,
        project.manifest.entries,
        {},
        { environments: WEB_KEEPING_IMPORT_META_MAIN },
      ),
      'web',
    )
    const { values } = await evaluateModule<{ values: unknown }>(out.entry)
    expect(values).toEqual(expectedValues(project))
    // The entry keeps its own (SWC keeps the comment that mentions it).
    const code = entryChunk(out).code.replaceAll(/\/\/[^\n]*/g, '')
    expect(importMetaMainCount(code)).toBe(1)
  })
})

describe('core-env-inline (rsbuild)', () => {
  it('inlines allowed variables in web environments, not in Deno ones', timeout, async () => {
    const project = await fixture('core-env-inline')
    const files = project.manifest.expect?.files as Record<string, string>
    for (const [name, text] of Object.entries(files)) await writeFile(project.path(name), text)
    vi.stubEnv('PUBLIC_TARGET', 'from the process')
    const builds = await bundle(
      project.root,
      project.manifest.entries,
      { env: { prefix: 'PUBLIC_' }, denoGlobals: 'off' },
      { environments: { web: {}, ...NODE } },
    )
    const web = only(builds, 'web')
    const mod = await evaluateModule<{ values: unknown; fromFile: () => unknown }>(web.entry)
    expect(mod.values).toEqual(expectedValues(project))
    expect(mod.fromFile()).toBeUndefined()
    expect(entryChunk(web).code).not.toContain('PUBLIC_')
    // The node environment builds for Deno (a deno.json): read at runtime.
    expect(entryChunk(only(builds, 'node')).code).toMatch(
      /Deno\.env\.get\(["']PUBLIC_GREETING["']\)/,
    )
  })
})

describe('core-deno-globals (rsbuild)', () => {
  it('reports Deno globals of local modules in web environments only', timeout, async () => {
    const project = await fixture('core-deno-globals')
    const expected = project.manifest.expect as { values: object; warning: string }
    const builds = await bundle(
      project.root,
      project.manifest.entries,
      {},
      { environments: { web: {}, ...NODE } },
    )
    const web = only(builds, 'web')
    const { values } = await evaluateModule<{ values: object }>(web.entry)
    expect(values).toMatchObject(expected.values)
    expect(warningsWith(web, 'uses `Deno.')).toEqual([expect.stringContaining(expected.warning)])
  })

  it("fails the build with denoGlobals: 'error'", timeout, async () => {
    const project = await fixture('core-deno-globals')
    const expected = project.manifest.expect as { warning: string }
    const failure: unknown = await bundle(project.root, project.manifest.entries, {
      denoGlobals: 'error',
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(HostBuildError)
    const { errors, modules } = failure as HostBuildError
    expect(errors).toEqual([expect.stringContaining(expected.warning)])
    expect(errors[0]).toContain('(PLATFORM_INCOMPATIBLE)')
    expect(modules).toEqual(['./src/server-only.ts'])
  })
})

describe('core-jsx-preact (rsbuild)', () => {
  it(
    "gives Rsbuild's builtin:swc-loader the deno.json JSX settings (react-jsx, preact)",
    timeout,
    async () => {
      const project = await fixture('core-jsx-preact')
      const out = only(await bundle(project.root, project.manifest.entries), 'web')
      const { values } = await evaluateModule<{ values: unknown }>(out.entry)
      expect(values).toEqual(expectedValues(project))
      const ids = slashed(entryChunk(out).moduleIds)
      expect(ids.some((id) => /\/preact\/10\.29\.8\/jsx-runtime\/dist\//.test(id))).toBe(true)
    },
  )

  it('follows the classic runtime, and leaves the JSX tools.swc configures', timeout, async () => {
    const project = await fixture('core-jsx-preact')
    const config = JSON.parse(await readFile(project.path('deno.json'), 'utf8')) as object
    await writeFile(
      project.path('deno.json'),
      JSON.stringify({
        ...config,
        compilerOptions: { jsx: 'react', jsxFactory: 'h', jsxFragmentFactory: 'Fragment' },
      }),
    )
    const classic = only(await bundle(project.root, project.manifest.entries), 'web')
    expect((await evaluateModule<{ values: unknown }>(classic.entry)).values).toEqual(
      expectedValues(project),
    )
    expect(slashed(entryChunk(classic).moduleIds).some((id) => id.includes('/jsx-runtime/'))).toBe(
      false,
    )
    // `tools.swc` sets the automatic runtime (as @rsbuild/plugin-react does): left alone.
    const configured = only(
      await bundle(
        project.root,
        project.manifest.entries,
        {},
        {
          environments: {
            web: {
              tools: {
                swc: {
                  jsc: { transform: { react: { runtime: 'automatic', importSource: 'preact' } } },
                },
              },
            },
          },
        },
      ),
      'web',
    )
    expect((await evaluateModule<{ values: unknown }>(configured.entry)).values).toEqual(
      expectedValues(project),
    )
    expect(
      slashed(entryChunk(configured).moduleIds).some((id) => id.includes('/jsx-runtime/')),
    ).toBe(true)
  })
})

describe('core-checks (rsbuild)', () => {
  it(
    'warns about node: builtins in web environments and npm packages in two versions',
    timeout,
    async () => {
      const project = await fixture('core-checks')
      const expected = project.manifest.expect as { builtin: string; duplicate: string }
      const out = only(
        await bundle(
          project.root,
          project.manifest.entries,
          {},
          { environments: { web: { output: { externals: { 'node:path': 'module node:path' } } } } },
        ),
        'web',
      )
      const { values } = await evaluateModule<{ values: unknown }>(out.entry)
      expect(values).toEqual(expectedValues(project))
      expect(warningsWith(out, expected.builtin)).toHaveLength(1)
      expect(warningsWith(out, expected.duplicate)).toEqual([
        expect.stringContaining('(3.3.19, 5.1.16)'),
      ])
    },
  )
})

describe('core-wasm (rsbuild)', () => {
  it('instantiates .wasm module imports like Deno, with their own imports', timeout, async () => {
    const project = await fixture('core-wasm')
    const out = only(await bundle(project.root, project.manifest.entries), 'web')
    const { values } = await evaluateModule<{ values: unknown }>(out.entry)
    expect(values).toEqual(expectedValues(project))
    const chunk = entryChunk(out)
    expect(chunk.code).toContain('new WebAssembly.Instance(')
    expect(slashed(chunk.moduleIds)).toContain(slashed([project.path('src/offset.js')])[0])
    expect(
      readdirSync(out.outDir, { recursive: true }).filter((file) => String(file).endsWith('.wasm')),
    ).toEqual([])
  })
})
