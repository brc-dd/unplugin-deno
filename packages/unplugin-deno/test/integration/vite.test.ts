/**
 * Vite builds (docs/architecture.md §6.1) of the Vite fixtures and of core fixtures, with Vite 8
 * and Vite 7 (the `vite7` devDependency alias): library builds for the browser (client
 * environment) evaluated in the current runtime, and SSR builds for the Deno platform.
 */
import { execFile } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { Options } from '../../src/core/options.js'
import type { BuildEntries, BuildResult } from '../helpers/build.js'
import { evaluateModule, installCssStyleSheet } from '../helpers/build.js'
import { testDenoDirPath } from '../helpers/deno-dir.js'
import type { ViteBuildOptions, ViteModule } from '../helpers/vite.js'
import { buildWithVite, loadVite } from '../helpers/vite.js'
import {
  containsAbsolutePath,
  DENO_AVAILABLE,
  fixture,
  importMetaMainCount,
  runWithSidecar,
  warningsWith,
} from './core-suite.js'

const execFileAsync = promisify(execFile)
const timeout = { timeout: 180_000 }

async function build(
  root: string,
  entries: BuildEntries,
  options: Options,
  viteOptions: ViteBuildOptions,
): Promise<BuildResult> {
  const out = await buildWithVite(root, entries, options, viteOptions)
  onTestFinished(() => out.dispose())
  return out
}

function entryChunk(out: BuildResult): BuildResult['chunks'][number] {
  const chunk = out.chunks.find((item) => item.isEntry)
  if (chunk === undefined) throw new Error('no entry chunk')
  return chunk
}

/** The sorted `expect.externals` of a fixture. */
function expected(externals: unknown): string[] {
  return [...(externals as string[])].toSorted()
}

function slashed(ids: readonly string[]): string[] {
  return ids.map((id) => id.replaceAll('\\', '/'))
}

/** The files of an output directory, recursively, relative to it with `/` separators. */
function outputFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(dir.length + 1)
        .replaceAll('\\', '/'),
    )
}

/** A companion plugin with `virtual:` and `\0` modules; records what reaches it. */
function virtualPlugin(seen: string[]): object {
  return {
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
  }
}

function viteBuildSuite(major: 7 | 8): void {
  const load = (): Promise<ViteModule> => loadVite(major)

  describe(`vite-spa (Vite ${major} build)`, () => {
    it(
      'bundles jsr:, an npm: subpath, https:, data:, ?raw through an import-map alias, text, bytes and JSON',
      timeout,
      async () => {
        const project = await fixture('vite-spa')
        const vite = await load()
        const out = await build(project.root, project.manifest.entries, {}, { vite })
        const { values } = await evaluateModule<{ values: unknown }>(out.entry)
        expect(values).toEqual(project.manifest.expect?.values)
        const chunk = entryChunk(out)
        expect(chunk.imports).toEqual([])
        const ids = slashed(chunk.moduleIds)
        expect(ids.some((id) => id.includes('/https/jsr.io/@std/path/1.1.6/'))).toBe(true)
        expect(ids.some((id) => id.includes('/node_modules/.deno/kleur@4.1.5/'))).toBe(true)
        // Markers are virtual ids that hide the target's extension from Vite's plugins.
        // Relative to the Vite root, so no machine path reaches the output.
        expect(ids).toContain('\0deno:text:src/message.txt.js')
        expect(ids).toContain('\0deno:bytes:src/data.bin.js')
        expect(chunk.code).not.toMatch(/type:\s*["'](?:text|bytes)["']/)
        for (const item of out.chunks) {
          expect(containsAbsolutePath(item.code, project.root)).toBe(false)
        }
      },
    )
  })

  describe(`vite-css-alias (Vite ${major} build)`, () => {
    it(
      'resolves CSS @import of path-like import-map keys through resolve.alias',
      timeout,
      async () => {
        const project = await fixture('vite-css-alias')
        const vite = await load()
        const out = await build(project.root, project.manifest.entries, {}, { vite })
        const css = outputFiles(out.outDir).filter((file) => file.endsWith('.css'))
        expect(css).toHaveLength(1)
        const text = await readFile(join(out.outDir, css[0] ?? ''), 'utf8')
        const selectors = (project.manifest.expect?.css ?? []) as string[]
        for (const selector of selectors) expect(text).toContain(selector)
        expect(text).not.toContain('@import')
      },
    )
  })

  describe(`vite-worker (Vite ${major} build)`, () => {
    it('bundles a worker that imports jsr: through the import map', timeout, async () => {
      const project = await fixture('vite-worker')
      const vite = await load()
      const out = await build(project.root, project.manifest.entries, {}, { vite })
      const { values } = await evaluateModule<{ values: unknown }>(out.entry)
      expect(values).toEqual(project.manifest.expect?.values)
      const workers = outputFiles(out.outDir).filter((file) => /worker[^/]*\.js$/.test(file))
      expect(workers).toHaveLength(1)
      const worker = await readFile(join(out.outDir, workers[0] ?? ''), 'utf8')
      // The mirrored @std/path code is in the worker bundle, which imports nothing.
      expect(worker).toContain('function join(')
      expect(worker).not.toMatch(/^\s*import\s[^\n]*from\s*["']/m)
    })
  })

  describe(`vite-ssr-deno (Vite ${major} build)`, () => {
    it('keeps npm:, jsr: and node: external and pinned in an SSR build', timeout, async () => {
      const project = await fixture('vite-ssr-deno')
      const vite = await load()
      const out = await build(
        project.root,
        project.manifest.entries,
        {},
        {
          vite,
          environment: 'ssr',
        },
      )
      const chunk = entryChunk(out)
      expect(chunk.imports.toSorted()).toEqual(expected(project.manifest.expect?.externals))
      expect(chunk.code).toContain('42')
      expect(chunk.code).not.toContain('/node_modules/')
      for (const specifier of expected(project.manifest.expect?.externals)) {
        expect(chunk.code).toContain(`from "${specifier}"`)
      }
    })

    it(
      'reads the platform of the ssr environment from a record, bundling for node',
      timeout,
      async () => {
        const project = await fixture('vite-ssr-deno')
        const vite = await load()
        const out = await build(
          project.root,
          project.manifest.entries,
          { platform: { ssr: 'node' } },
          { vite, environment: 'ssr' },
        )
        const chunk = entryChunk(out)
        // npm: and jsr: are bundled for node (Vite keeps node: builtins external).
        expect(chunk.imports).toEqual(['node:fs'])
        expect(slashed(chunk.moduleIds).some((id) => id.includes('/https/jsr.io/'))).toBe(true)
        const { values } = await evaluateModule<{ values: unknown }>(out.entry)
        expect(values).toEqual(project.manifest.expect?.values)
      },
    )

    it.skipIf(!DENO_AVAILABLE)(
      'runs under `deno run --cached-only` (skipped without a deno binary)',
      timeout,
      async () => {
        const project = await fixture('vite-ssr-deno')
        const vite = await load()
        const out = await build(
          project.root,
          project.manifest.entries,
          {},
          {
            vite,
            environment: 'ssr',
          },
        )
        const runner = join(out.outDir, 'run.mjs')
        await writeFile(
          runner,
          "import { values } from './server.js'\nconsole.log(JSON.stringify(values))\n",
        )
        const env = { ...process.env, DENO_DIR: testDenoDirPath(), NO_COLOR: '1' }
        await execFileAsync('deno', ['cache', '--quiet', 'run.mjs'], { cwd: out.outDir, env })
        const { stdout } = await execFileAsync('deno', ['run', '-A', '--cached-only', 'run.mjs'], {
          cwd: out.outDir,
          env,
        })
        expect(JSON.parse(stdout)).toEqual(project.manifest.expect?.values)
      },
    )

    it(
      'writes the sidecar deno.json and deno.lock for the ssr environment only (emitDenoConfig)',
      timeout,
      async () => {
        const project = await fixture('vite-ssr-deno')
        const vite = await load()
        const out = await build(
          project.root,
          project.manifest.entries,
          { emitDenoConfig: true },
          { vite, environment: 'ssr' },
        )
        expect(outputFiles(out.outDir).toSorted()).toEqual(['deno.json', 'deno.lock', 'server.js'])
        const lock = JSON.parse(await readFile(join(out.outDir, 'deno.lock'), 'utf8')) as {
          jsr: Record<string, unknown>
          npm: Record<string, unknown>
        }
        expect(Object.keys(lock.npm)).toEqual(['kleur@4.1.5'])
        expect(Object.keys(lock.jsr)).toContain('@std/path@1.1.6')
        // The client (browser) environment writes none.
        const client = await build(
          project.root,
          ['src/answer.ts'],
          { emitDenoConfig: true },
          { vite },
        )
        expect(outputFiles(client.outDir).filter((file) => file.startsWith('deno.'))).toEqual([])
      },
    )

    it.skipIf(!DENO_AVAILABLE)(
      'runs the ssr output with the sidecar under `deno run --frozen --cached-only` (skipped without a deno binary)',
      timeout,
      async () => {
        const project = await fixture('vite-ssr-deno')
        const vite = await load()
        const out = await build(
          project.root,
          project.manifest.entries,
          { emitDenoConfig: true },
          { vite, environment: 'ssr' },
        )
        expect(await runWithSidecar(out.outDir)).toEqual(project.manifest.expect?.values)
      },
    )
  })

  describe(`core fixtures (Vite ${major} build)`, () => {
    it("never intercepts other plugins' virtual: and \\0 ids", timeout, async () => {
      const project = await fixture('core-virtual-coexist')
      const vite = await load()
      const seen: string[] = []
      const out = await build(
        project.root,
        project.manifest.entries,
        {},
        {
          vite,
          plugins: [virtualPlugin(seen) as never],
        },
      )
      const { values } = await evaluateModule<{ values: unknown }>(out.entry)
      expect(values).toEqual(project.manifest.expect?.values)
      expect(seen.toSorted()).toEqual(['virtual:answer', 'virtual:greeting'])
    })

    it(
      'resolves a mapped bare name through the import map, not node_modules',
      timeout,
      async () => {
        const project = await fixture('core-import-map-precedence')
        const vite = await load()
        const out = await build(project.root, project.manifest.entries, {}, { vite })
        const { values } = await evaluateModule<{ values: unknown }>(out.entry)
        expect(values).toMatchObject(project.manifest.expect?.values as object)
        const ids = slashed(entryChunk(out).moduleIds)
        expect(ids.some((id) => id.includes('/npm/registry.npmjs.org/kleur/4.1.5/'))).toBe(true)
        expect(ids.some((id) => id.includes('/node_modules/kleur/'))).toBe(false)
        expect(ids).toContain(
          project.path('node_modules/stub-only-pkg/index.js').replaceAll('\\', '/'),
        )
      },
    )

    it(
      'turns text, bytes and css attributes into marker modules that vite:css leaves alone',
      timeout,
      async () => {
        onTestFinished(installCssStyleSheet())
        const project = await fixture('core-attributes')
        const vite = await load()
        const out = await build(project.root, project.manifest.entries, {}, { vite })
        const mod = await evaluateModule<{
          values: Record<string, unknown>
          dynamicValues: () => Promise<Record<string, unknown>>
        }>(out.entry)
        const values = project.manifest.expect?.values as Record<string, unknown>
        expect(mod.values).toMatchObject(values)
        expect(mod.values.cssType).toBe('CSSStyleSheet')
        expect(mod.values.normalizeLength).toBeGreaterThan(5000)
        expect(await mod.dynamicValues()).toEqual({
          text: values.text,
          bytes: values.bytes,
          json: values.json,
          css: values.css,
          license: 'The MIT License ',
        })
        const ids = slashed(out.chunks.flatMap((chunk) => chunk.moduleIds))
        expect(ids).toContain('\0deno:css:src/style.css.js')
        // No CSS asset was emitted: the style sheet is a module, not a stylesheet link.
        expect(out.chunks.every((chunk) => !chunk.code.includes('__vite_css'))).toBe(true)
        for (const chunk of out.chunks) {
          expect(containsAbsolutePath(chunk.code, project.root)).toBe(false)
        }
      },
    )

    it('compiles local JSX with the deno.json settings (react-jsx, preact)', timeout, async () => {
      const project = await fixture('core-jsx-preact')
      const vite = await load()
      const config = JSON.parse(await readFile(project.path('deno.json'), 'utf8')) as object
      // [compilerOptions, whether the preact runtime is bundled, whether it is the development one
      // (for react-jsx, Vite's own default applies: development unless NODE_ENV is production)]
      const variants = [
        [
          { jsx: 'react-jsx', jsxImportSource: 'preact' },
          true,
          process.env.NODE_ENV !== 'production',
        ],
        [{ jsx: 'react-jsxdev', jsxImportSource: 'preact' }, true, true],
        [{ jsx: 'react', jsxFactory: 'h', jsxFragmentFactory: 'Fragment' }, false, false],
      ] as const
      for (const [compilerOptions, runtime, development] of variants) {
        await writeFile(project.path('deno.json'), JSON.stringify({ ...config, compilerOptions }))
        const out = await build(project.root, project.manifest.entries, {}, { vite })
        const { values } = await evaluateModule<{ values: unknown }>(out.entry)
        expect(values).toEqual(project.manifest.expect?.values)
        const chunk = entryChunk(out)
        const ids = slashed(chunk.moduleIds)
        expect(ids.some((id) => id.includes('/preact/10.29.8/jsx-runtime/'))).toBe(runtime)
        expect(chunk.code.includes('lineNumber')).toBe(development)
      }
    })

    it('leaves the JSX settings of the Vite config alone', timeout, async () => {
      const project = await fixture('core-jsx-preact')
      const vite = await load()
      const config =
        major >= 8
          ? { oxc: { jsx: { runtime: 'classic' as const, pragma: 'h', pragmaFrag: 'Fragment' } } }
          : { esbuild: { jsx: 'transform' as const, jsxFactory: 'h', jsxFragment: 'Fragment' } }
      const out = await build(project.root, project.manifest.entries, {}, { vite, config })
      const { values } = await evaluateModule<{ values: unknown }>(out.entry)
      expect(values).toEqual(project.manifest.expect?.values)
      expect(slashed(entryChunk(out).moduleIds).some((id) => id.includes('/jsx-runtime/'))).toBe(
        false,
      )
    })

    it('replaces import.meta.main outside the entry', timeout, async () => {
      const project = await fixture('core-import-meta-main')
      const vite = await load()
      const out = await build(project.root, project.manifest.entries, {}, { vite })
      const { values } = await evaluateModule<{ values: unknown }>(out.entry)
      expect(values).toEqual(project.manifest.expect?.values)
      expect(importMetaMainCount(entryChunk(out).code)).toBe(1)
    })

    it('inlines allowed variables into the client bundle', timeout, async () => {
      const project = await fixture('core-env-inline')
      const vite = await load()
      const files = project.manifest.expect?.files as Record<string, string>
      for (const [name, text] of Object.entries(files)) await writeFile(project.path(name), text)
      vi.stubEnv('PUBLIC_TARGET', 'from the process')
      const out = await build(
        project.root,
        project.manifest.entries,
        { env: { prefix: 'PUBLIC_' }, denoGlobals: 'off' },
        { vite },
      )
      const mod = await evaluateModule<{ values: unknown; fromFile: () => unknown }>(out.entry)
      expect(mod.values).toEqual(project.manifest.expect?.values)
      expect(mod.fromFile()).toBeUndefined()
      expect(entryChunk(out).code).not.toContain('PUBLIC_')
    })

    it('instantiates .wasm module imports like Deno', timeout, async () => {
      const project = await fixture('core-wasm')
      const vite = await load()
      const out = await build(project.root, project.manifest.entries, {}, { vite })
      const { values } = await evaluateModule<{ values: unknown }>(out.entry)
      expect(values).toEqual(project.manifest.expect?.values)
      expect(entryChunk(out).code).toContain('new WebAssembly.Instance(')
    })

    it('reports Deno globals of local modules in the client bundle', timeout, async () => {
      const project = await fixture('core-deno-globals')
      const vite = await load()
      const expectations = project.manifest.expect as { values: object; warning: string }
      const out = await build(project.root, project.manifest.entries, {}, { vite })
      const { values } = await evaluateModule<{ values: object }>(out.entry)
      expect(values).toMatchObject(expectations.values)
      expect(warningsWith(out, 'uses `Deno.')).toEqual([
        expect.stringContaining(expectations.warning),
      ])
    })

    it('warns about node: builtins and npm packages bundled in two versions', timeout, async () => {
      const project = await fixture('core-checks')
      const vite = await load()
      const expectations = project.manifest.expect as { builtin: string; duplicate: string }
      const out = await build(project.root, project.manifest.entries, {}, { vite })
      const { values } = await evaluateModule<{ values: unknown }>(out.entry)
      expect(values).toEqual(project.manifest.expect?.values)
      expect(warningsWith(out, expectations.builtin)).toHaveLength(1)
      expect(warningsWith(out, expectations.duplicate)).toEqual([
        expect.stringContaining('(3.3.19, 5.1.16)'),
      ])
    })
  })
}

viteBuildSuite(8)
viteBuildSuite(7)

describe('vite build with a vite.config-style setup', () => {
  it('builds the client and ssr environments of one app (createBuilder)', timeout, async () => {
    const project = await fixture('vite-ssr-deno')
    const vite = await import('vite')
    const { default: deno } = await import('../../src/vite.js')
    const { denoDir } = await import('../helpers/deno-dir.js')
    vi.stubEnv('DENO_DIR', await denoDir())
    const outDir = resolve(project.root, 'dist')
    const builder = await vite.createBuilder({
      root: project.root,
      configFile: false,
      logLevel: 'silent',
      plugins: [deno()],
      environments: {
        client: {
          build: {
            outDir: join(outDir, 'client'),
            rolldownOptions: { input: project.path('src/answer.ts') },
          },
        },
        ssr: {
          build: {
            outDir: join(outDir, 'server'),
            rolldownOptions: { input: project.path('src/server.ts') },
          },
        },
      },
    })
    await builder.buildApp()
    // Vite names ES module SSR output `.mjs` when no package.json says `"type": "module"`.
    const server = readFileSync(join(outDir, 'server', 'server.mjs'), 'utf8')
    expect(server).toContain('from "npm:kleur@4.1.5"')
    expect(server).toContain('from "jsr:@std/path@1.1.6/posix"')
    expect(server).toContain('from "node:fs"')
    expect(server).not.toContain('node:module')
    const client = readdirSync(join(outDir, 'client', 'assets'))
    expect(client.some((file) => /^answer-.+\.js$/.test(file))).toBe(true)
  })
})
