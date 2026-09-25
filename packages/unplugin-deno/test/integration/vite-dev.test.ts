/**
 * The Vite dev server (docs/architecture.md §6.1) with unplugin-deno, on Vite 8 and Vite 7 (the
 * `vite7` devDependency alias), in middleware mode without a file watcher (tests emit the watcher
 * events): prebundled npm, JSR, `https:` and `data:` dependencies keyed on the specifier as
 * written (one optimizer run), `?raw` through the import map, markers, other plugins' virtual
 * modules, SSR on the server platform, config reloads and workspace members outside the root.
 */
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DevEnvironment } from 'vite'
import { describe, expect, it, onTestFinished } from 'vitest'
import type { Options } from '../../src/core/options.js'
import { fixturesDir } from '../helpers/fixture.js'
import type { ViteDevOptions, ViteDevServerHandle } from '../helpers/vite.js'
import { loadVite, startViteDevServer } from '../helpers/vite.js'
import { fixture } from './core-suite.js'

const timeout = { timeout: 180_000 }

function client(dev: ViteDevServerHandle): DevEnvironment {
  return dev.server.environments.client as DevEnvironment
}

/** The import specifiers of transformed code (`import … from "<url>"`). */
function importUrls(code: string): string[] {
  return [...code.matchAll(/^import .* from "([^"]+)";/gm)].map((match) => match[1] ?? '')
}

/**
 * The module graph URL of an import URL: without Vite's `import` query, and with the id (`\0…`)
 * of a virtual module instead of `/@id/__x00__…` (which the dev server's middleware unwraps).
 */
function graphUrl(url: string): string {
  return url
    .replace(/^\/@id\/__x00__/, '\0')
    .replace(/\?import&/, '?')
    .replace(/[?&]import$/, '')
}

/** The crawled code of the module an import URL points to. */
function codeOf(codes: ReadonlyMap<string, string>, url: string | undefined): string {
  if (url === undefined) return ''
  return codes.get(url) ?? codes.get(graphUrl(url)) ?? ''
}

/** The crawled code of the prebundled dependency whose file name contains `name`. */
function prebundledCode(codes: ReadonlyMap<string, string>, name: string): string {
  return [...codes].find(([url]) => url.includes('/.vite/deps/') && url.includes(name))?.[1] ?? ''
}

/** Waits until `check` passes (the dev server reacts to watcher events asynchronously). */
async function eventually(check: () => void | Promise<void>, ms = 10_000): Promise<void> {
  const started = Date.now()
  for (;;) {
    try {
      await check()
      return
    } catch (error) {
      if (Date.now() - started > ms) throw error
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
}

/** The optimized dependencies of the client environment: key → source file. */
function optimized(dev: ViteDevServerHandle): Record<string, string> {
  const metadata = client(dev).depsOptimizer?.metadata
  return Object.fromEntries(
    Object.entries(metadata?.optimized ?? {}).map(([key, info]) => [key, info.src ?? '']),
  )
}

function isFullReload(payload: unknown): boolean {
  return (payload as { type?: unknown } | undefined)?.type === 'full-reload'
}

function slash(path: string): string {
  return path.replaceAll('\\', '/')
}

function viteDevSuite(major: 7 | 8): void {
  async function serve(
    root: string,
    options: Options = {},
    devOptions: ViteDevOptions = {},
  ): Promise<ViteDevServerHandle> {
    const dev = await startViteDevServer(root, options, {
      ...devOptions,
      vite: await loadVite(major),
    })
    onTestFinished(() => dev.close())
    return dev
  }

  describe(`vite-spa (Vite ${major} dev server)`, () => {
    it('prebundles npm, JSR, https: and data: imports in one optimizer run', timeout, async () => {
      const project = await fixture('vite-spa')
      const dev = await serve(project.root)
      const main = await client(dev).transformRequest('/src/main.ts')
      const urls = importUrls(main?.code ?? '')
      expect(urls.filter((url) => url.startsWith('/node_modules/.vite/deps/'))).toHaveLength(4)
      expect(urls.filter((url) => url.includes('/.unplugin-deno/'))).toEqual([])
      // Load everything the page loads, prebundled dependencies included.
      const codes = await dev.crawl('/src/main.ts')
      const deps = optimized(dev)
      expect(Object.keys(deps).toSorted()).toEqual([
        '@std/path/posix',
        'data:text/javascript,export default 42',
        'https://deno.land/std@0.224.0/text/closest_string.ts',
        'npm:kleur@^4/colors',
      ])
      expect(slash(deps['@std/path/posix'] ?? '')).toMatch(
        /\/\.unplugin-deno\/\w+\/https\/jsr\.io\//,
      )
      expect(slash(deps['npm:kleur@^4/colors'] ?? '')).toMatch(
        /\/node_modules\/\.deno\/kleur@4\.1\.5\//,
      )
      expect(prebundledCode(codes, '@std_path')).toContain('function join(')
      expect(dev.optimizerRuns()).toBe(1)
      expect(dev.sent.client?.filter(isFullReload)).toEqual([])
      expect(dev.logs).toEqual([])
    })

    it(
      'serves ?raw through an import-map path alias, markers and JSON as modules',
      timeout,
      async () => {
        const project = await fixture('vite-spa')
        const dev = await serve(project.root)
        const codes = await dev.crawl('/src/main.ts')
        const urls = importUrls(codes.get('/src/main.ts') ?? '')
        expect(urls).toContain('/src/icon.svg?import&raw')
        expect(codeOf(codes, '/src/icon.svg?import&raw')).toContain('export default "<svg')
        const text = urls.find((url) => url.startsWith('/@id/__x00__deno:text:'))
        expect(text).toMatch(/\/src\/message\.txt\.js$/)
        expect(codeOf(codes, text)).toContain('export default "hello text\\n"')
        const bytes = urls.find((url) => url.startsWith('/@id/__x00__deno:bytes:'))
        expect(codeOf(codes, bytes)).toContain('new Uint8Array([0,1,2,250,255])')
        expect(urls).toContain('/src/data.json?import')
        expect(codeOf(codes, '/src/data.json?import')).toContain('"vite-spa"')
      },
    )

    it('configures the alias, server.fs.allow and the optimizer plugin', timeout, async () => {
      const project = await fixture('vite-spa')
      const dev = await serve(project.root)
      const { config } = dev.server
      const alias = config.resolve.alias.find(
        (entry) => entry.find instanceof RegExp && entry.find.test('https://x.test/a.ts'),
      )
      expect(alias?.replacement).toBe('$1')
      expect(alias?.find instanceof RegExp && alias.find.test('data:text/javascript,1')).toBe(true)
      const allow = config.server.fs.allow.map(slash)
      expect(allow).toContain(slash(project.path('node_modules/.unplugin-deno')))
      expect(allow).toContain(slash(project.root))
      const optimizeDeps = client(dev).config.optimizeDeps
      const plugins =
        major >= 8 ? optimizeDeps.rolldownOptions?.plugins : optimizeDeps.esbuildOptions?.plugins
      expect(JSON.stringify(plugins)).toContain('unplugin-deno:optimizer:')
    })

    it('serves mirror files as they are for excluded dependencies', timeout, async () => {
      const project = await fixture('vite-spa')
      const dev = await serve(
        project.root,
        {},
        { config: { optimizeDeps: { exclude: ['@std/path'] } } },
      )
      const codes = await dev.crawl('/src/main.ts')
      const urls = importUrls(codes.get('/src/main.ts') ?? '')
      const mirror = urls.find((url) => url.includes('/.unplugin-deno/'))
      expect(mirror).toMatch(
        /^\/node_modules\/\.unplugin-deno\/\w+\/https\/jsr\.io\/@std\/path\/1\.1\.6\/posix\/mod\.ts\.js$/,
      )
      expect(Object.keys(optimized(dev))).not.toContain('@std/path')
      // The mirror's relative imports resolve natively; the loaded code has no linked source map.
      const joinCode =
        [...codes].find(([url]) => url.includes('/@std/path/1.1.6/posix/join.ts.js'))?.[1] ?? ''
      expect(joinCode).toContain('function join(')
      expect(joinCode).not.toContain('sourceMappingURL=join.ts.js.map')
    })

    it("keeps the config's aliases ahead of its own", timeout, async () => {
      const project = await fixture('vite-spa')
      const local = project.path('src/local-closest.ts')
      await writeFile(local, 'export const closestString = () => "local"\n')
      const dev = await serve(
        project.root,
        {},
        {
          config: {
            resolve: { alias: { 'https://deno.land/std@0.224.0/text/closest_string.ts': local } },
          },
        },
      )
      const main = await client(dev).transformRequest('/src/main.ts')
      expect(importUrls(main?.code ?? '')).toContain('/src/local-closest.ts')
    })
  })

  describe(`vite-no-package-json (Vite ${major} dev server)`, () => {
    it(
      "defaults cacheDir to <root>/node_modules/.vite and prebundles packages from Deno's global cache",
      timeout,
      async () => {
        const project = await fixture('vite-no-package-json')
        const dev = await serve(project.root)
        expect(slash(dev.server.config.cacheDir)).toBe(slash(project.path('node_modules/.vite')))
        const codes = await dev.crawl('/src/main.ts')
        const deps = optimized(dev)
        const prebundled = (project.manifest.expect?.prebundled ?? []) as string[]
        expect(Object.keys(deps).toSorted()).toEqual(prebundled.toSorted())
        for (const file of Object.values(deps)) {
          expect(slash(file)).toMatch(/\/npm\/registry\.npmjs\.org\//)
        }
        expect(dev.optimizerRuns()).toBe(1)
        // ms is CommonJS: the prebundled module has an ES default export.
        expect(prebundledCode(codes, '/ms.js')).toMatch(/export (?:default|\{[^}]*\bdefault\b)/)
        // strip-ansi imports ansi-regex, which the engine resolved inside the optimizer.
        expect(prebundledCode(codes, 'strip-ansi')).toContain('ansiRegex')
      },
    )

    it('ignores the package.json of an ancestor directory', timeout, async () => {
      const parent = await realpath(await mkdtemp(join(tmpdir(), 'unplugin-deno-ancestor-')))
      onTestFinished(() => rm(parent, { recursive: true, force: true, maxRetries: 3 }))
      await writeFile(join(parent, 'package.json'), '{ "name": "unrelated" }\n')
      const root = join(parent, 'app')
      await cp(join(fixturesDir, 'vite-no-package-json'), root, { recursive: true })
      const dev = await serve(root)
      expect(slash(dev.server.config.cacheDir)).toBe(slash(join(root, 'node_modules', '.vite')))
    })
  })

  describe(`core fixtures (Vite ${major} dev server)`, () => {
    it("leaves other plugins' virtual: and \\0 ids alone", timeout, async () => {
      const project = await fixture('core-virtual-coexist')
      const seen: string[] = []
      const dev = await serve(
        project.root,
        {},
        {
          plugins: [
            {
              name: 'test-virtual',
              resolveId(source) {
                if (!source.startsWith('virtual:')) return null
                seen.push(source)
                return source === 'virtual:answer' ? '\0virtual:answer' : '\0greeting'
              },
              load(id) {
                if (id === '\0virtual:answer') return 'export default 42'
                if (id === '\0greeting') return 'export default "hi, with { type: \'text\' } stays"'
                return null
              },
            },
          ],
        },
      )
      const codes = await dev.crawl('/src/main.ts')
      expect(seen.toSorted()).toEqual(['virtual:answer', 'virtual:greeting'])
      expect(codeOf(codes, '/@id/__x00__virtual:answer')).toContain('export default 42')
      expect(codeOf(codes, '/@id/__x00__greeting')).toContain("with { type: 'text' } stays")
    })

    it(
      'resolves a mapped bare name through the import map, not node_modules',
      timeout,
      async () => {
        const project = await fixture('core-import-map-precedence')
        const dev = await serve(project.root)
        await dev.crawl('/src/main.ts')
        const deps = optimized(dev)
        expect(slash(deps.kleur ?? '')).toMatch(/\/npm\/registry\.npmjs\.org\/kleur\/4\.1\.5\//)
        // An unmapped name stays with Vite, which prebundles it from node_modules.
        expect(slash(deps['stub-only-pkg'] ?? '')).toBe(
          slash(project.path('node_modules/stub-only-pkg/index.js')),
        )
      },
    )

    it('serves css attributes as CSSStyleSheet modules, not as Vite CSS', timeout, async () => {
      const project = await fixture('core-attributes')
      const dev = await serve(project.root)
      const codes = await dev.crawl('/src/main.ts')
      const urls = importUrls(codes.get('/src/main.ts') ?? '')
      const css = urls.filter((url) => url.startsWith('/@id/__x00__deno:css:'))
      expect(css).toHaveLength(2)
      for (const url of css) {
        const code = codeOf(codes, url)
        expect(code).toContain('new CSSStyleSheet()')
        expect(code).not.toContain('__vite__updateStyle')
      }
      const local = codeOf(
        codes,
        css.find((url) => url.endsWith('/src/style.css.js')),
      )
      expect(local).toContain('color: red')
    })

    it('updates a marker module when its file changes', timeout, async () => {
      const project = await fixture('core-attributes')
      const dev = await serve(project.root)
      const codes = await dev.crawl('/src/main.ts')
      const url = importUrls(codes.get('/src/main.ts') ?? '').find((item) =>
        item.startsWith('/@id/__x00__deno:text:'),
      )
      expect(codeOf(codes, url)).toContain('hello text')
      await writeFile(project.path('src/data.txt'), 'changed text\n')
      dev.server.watcher.emit('change', project.path('src/data.txt'))
      await eventually(async () => {
        const result = await client(dev).transformRequest(graphUrl(url ?? ''))
        expect(result?.code).toContain('changed text')
      })
    })
  })

  describe(`vite-ssr-deno (Vite ${major} dev server)`, () => {
    it('loads a server module importing npm:, jsr: and node: through Vite', timeout, async () => {
      const project = await fixture('vite-ssr-deno')
      const dev = await serve(project.root)
      const mod = (await dev.server.ssrLoadModule('/src/server.ts')) as { values: unknown }
      expect(mod.values).toEqual(project.manifest.expect?.values)
      const ssr = dev.server.environments.ssr
      expect(ssr?.config.resolve.conditions).toContain('deno')
      expect(ssr?.config.resolve.conditions).toContain('node')
      expect(ssr?.config.resolve.externalConditions).toEqual(['node', 'module-sync', 'deno'])
      expect(client(dev).config.resolve.conditions).not.toContain('deno')
    })

    it('keeps the conditions the config sets', timeout, async () => {
      const project = await fixture('vite-ssr-deno')
      const dev = await serve(
        project.root,
        {},
        {
          config: { environments: { ssr: { resolve: { conditions: ['custom'] } } } },
        },
      )
      expect(dev.server.environments.ssr?.config.resolve.conditions).toEqual(['custom', 'deno'])
    })
  })

  describe(`config changes (Vite ${major} dev server)`, () => {
    it(
      'reloads the project, invalidates every environment and reloads on a deno.json change',
      timeout,
      async () => {
        const project = await fixture('vite-spa')
        await writeFile(project.path('src/late.ts'), 'export { late } from "late-alias"\n')
        await writeFile(project.path('src/late-target.ts'), 'export const late = "late"\n')
        const dev = await serve(project.root)
        await expect(client(dev).transformRequest('/src/late.ts')).rejects.toThrow(/late-alias/)
        const configPath = project.path('deno.json')
        const config = JSON.parse(await readFile(configPath, 'utf8')) as {
          imports: Record<string, string>
        }
        config.imports['late-alias'] = './src/late-target.ts'
        await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)
        dev.server.watcher.emit('change', configPath)
        await eventually(() => {
          expect(dev.sent.client?.some(isFullReload)).toBe(true)
          expect(dev.sent.ssr?.some(isFullReload)).toBe(true)
        })
        const late = await client(dev).transformRequest('/src/late.ts')
        expect(late?.code).toContain('/src/late-target.ts')
        // No hot update for the config file itself.
        expect(dev.sent.client?.filter((payload) => !isFullReload(payload))).toEqual([])
      },
    )
  })

  describe(`vite-workspace-member-outside-root (Vite ${major} dev server)`, () => {
    it(
      'serves a member outside the Vite root as a file and updates it when edited',
      timeout,
      async () => {
        const project = await fixture('vite-workspace-member-outside-root')
        const dev = await serve(project.path('app'))
        const libPath = slash(project.path('lib/mod.ts'))
        const main = await client(dev).transformRequest('/src/main.ts')
        const libUrl = importUrls(main?.code ?? '').find((url) => url.endsWith('/lib/mod.ts'))
        expect(libUrl).toBe(`/@fs${libPath.startsWith('/') ? '' : '/'}${libPath}`)
        expect((await client(dev).transformRequest(libUrl ?? ''))?.code).toContain('lib v1')
        expect(dev.server.config.server.fs.allow.map(slash)).toContain(slash(project.root))

        await writeFile(project.path('lib/mod.ts'), 'export const message: string = "lib v2"\n')
        dev.server.watcher.emit('change', project.path('lib/mod.ts'))
        await eventually(async () => {
          const module = await client(dev).moduleGraph.getModuleByUrl(libUrl ?? '')
          expect(module?.transformResult).toBeNull()
        })
        expect(dev.sent.client?.length).toBeGreaterThan(0)
        expect((await client(dev).transformRequest(libUrl ?? ''))?.code).toContain('lib v2')
      },
    )
  })
}

viteDevSuite(8)
viteDevSuite(7)
