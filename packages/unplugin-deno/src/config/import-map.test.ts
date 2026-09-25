import { describe, expect, it } from 'vitest'
import { DenoPluginError } from '../diagnostics/errors.js'
import type { DenoConfig } from './deno-config.js'
import type { ConfigFolder, ImportMapSource, LinkFolder } from './discover.js'
import type { ImportMapInput, ImportMapMatch } from './import-map.js'
import {
  createImportMapResolver,
  expandImportMapValue,
  parseImportMap,
  resolveImportMap,
  serializeImportMap,
} from './import-map.js'
import type { PackageJson } from './package-json.js'

// Unless noted, the expectations below were verified with Deno 2.9.7 (`import.meta.resolve` in
// scratch projects shaped like these inputs, 2026-09-26). Deno prints expanded jsr: subpaths in the
// import-map form (`jsr:/@std/path@^1/join`); the resolver normalises `jsr:/`/`npm:/` to
// `jsr:`/`npm:`. Specifiers Deno reports as "not a dependency" resolve to `null` here (the host
// decides), and failures of a matched entry throw.

interface FolderSpec {
  deno?: DenoConfig
  packageJson?: PackageJson
  /** An external import map `{ path, value }` instead of the inline `imports`/`scopes`. */
  external?: { url: string; value: unknown }
}

/** A config folder at a `file:` directory URL, without touching the file system. */
function folder(dirUrl: string, spec: FolderSpec): ConfigFolder {
  const dir = decodeURIComponent(new URL(dirUrl).pathname).replace(/\/$/, '')
  const denoPath = `${dir}/deno.json`
  let importMap: ImportMapSource | null = null
  if (spec.external !== undefined) {
    const path = decodeURIComponent(new URL(spec.external.url).pathname)
    importMap = { baseUrl: spec.external.url, value: spec.external.value, path, inline: false }
  } else if (spec.deno?.imports !== undefined || spec.deno?.scopes !== undefined) {
    const { imports, scopes } = spec.deno
    importMap = {
      baseUrl: `${dirUrl}deno.json`,
      value: { ...(imports ? { imports } : {}), ...(scopes ? { scopes } : {}) },
      path: denoPath,
      inline: true,
    }
  }
  return {
    dir,
    dirUrl,
    realDir: dir,
    denoJson:
      spec.deno === undefined
        ? null
        : { path: denoPath, url: `${dirUrl}deno.json`, config: spec.deno, importMap },
    packageJson:
      spec.packageJson === undefined
        ? null
        : { path: `${dir}/package.json`, url: `${dirUrl}package.json`, json: spec.packageJson },
  }
}

function link(dirUrl: string, spec: FolderSpec, entry: string | null = '../linked'): LinkFolder {
  return { ...folder(dirUrl, spec), link: entry }
}

function workspace(
  root: ConfigFolder | null,
  members: ConfigFolder[] = [],
  links: LinkFolder[] = [],
): ImportMapInput {
  return { rootFolder: root, members, links, workspaceRootUrl: root?.dirUrl ?? 'file:///ws/' }
}

/** `mapped` of a match, `null`, or `ERROR <code>`. */
function outcome(run: () => ImportMapMatch | null): string | null {
  try {
    return run()?.mapped ?? null
  } catch (error) {
    if (error instanceof DenoPluginError) return `ERROR ${error.code}`
    throw error
  }
}

const WS = 'file:///ws/'

describe('parseImportMap', () => {
  it('normalises keys and addresses against the base URL and sorts them', () => {
    const map = parseImportMap(
      {
        imports: { b: './b.ts', a: 'https://x.test/a.ts', './c.ts': '/c2.ts', 'dir/': './dir/' },
        scopes: { './sub/': { a: './sub-a.ts' }, 'https://esm.sh/': { b: './b2.ts' } },
      },
      `${WS}deno.json`,
    )
    expect(serializeImportMap(map)).toEqual({
      imports: {
        'file:///ws/c.ts': 'file:///c2.ts',
        'dir/': 'file:///ws/dir/',
        b: 'file:///ws/b.ts',
        a: 'https://x.test/a.ts',
      },
      scopes: {
        'https://esm.sh/': { b: 'file:///ws/b2.ts' },
        'file:///ws/sub/': { a: 'file:///ws/sub-a.ts' },
      },
    })
    expect(map.imports.entries.map((entry) => entry.key)).toEqual([
      'file:///ws/c.ts',
      'dir/',
      'b',
      'a',
    ])
    expect(map.scopes.map((scope) => scope.prefix)).toEqual(['https://esm.sh/', 'file:///ws/sub/'])
  })

  it('records invalid entries as null with warnings', () => {
    const map = parseImportMap(
      { imports: { bare: 'not-a-url', num: 1, 'pkg/': './no-slash.ts', '': './x.ts' }, extra: {} },
      `${WS}deno.json`,
      { source: '/ws/deno.json' },
    )
    expect(serializeImportMap(map).imports).toEqual({ bare: null, num: null, 'pkg/': null })
    expect(map.warnings).toEqual([
      'Invalid top-level key "extra"; only "imports" and "scopes" can be present.',
      'Invalid address "not-a-url" for the specifier key "bare".',
      'Invalid address 1 for the specifier key "num"; addresses must be strings.',
      'Invalid target address "file:///ws/no-slash.ts" for package specifier "pkg/"; package address targets must end with "/".',
      'Invalid empty string specifier.',
    ])
    expect(map.imports.byKey.get('bare')?.source).toBe('/ws/deno.json')
  })

  it.each([
    [[], 'An import map must be a JSON object'],
    [{ imports: [] }, '"imports" must be an object'],
    [{ scopes: 'x' }, '"scopes" must be an object'],
    [{ scopes: { './a/': null } }, 'The value of the scope "./a/" must be an object'],
  ])('rejects %j', (value, message) => {
    expect(() => parseImportMap(value, `${WS}deno.json`)).toThrow(
      expect.objectContaining({
        code: 'IMPORT_MAP_INVALID',
        message: expect.stringContaining(message),
      }),
    )
  })

  it('upper-cases Windows drive letters in file: keys, addresses and scopes', () => {
    const map = parseImportMap(
      {
        imports: { x: './x.ts', 'file:///c:/lib/': './lib/' },
        scopes: { 'file:///c:/proj/sub/': {} },
      },
      'file:///c:/proj/deno.json',
    )
    expect(serializeImportMap(map)).toEqual({
      imports: { x: 'file:///C:/proj/x.ts', 'file:///C:/lib/': 'file:///C:/proj/lib/' },
      scopes: { 'file:///C:/proj/sub/': {} },
    })
    expect(resolveImportMap(map, 'file:///c:/lib/a.ts', 'file:///c:/proj/main.ts').url).toBe(
      'file:///C:/proj/lib/a.ts',
    )
  })

  it('serialises "^" like Deno on every runtime (not as %5E)', () => {
    const map = parseImportMap(
      expandImportMapValue({
        imports: { react: 'npm:react@^19.0.0', 'esm/': 'https://esm.sh/x@^1/' },
      }),
      'file:///k/deno.json',
    )
    expect(serializeImportMap(map).imports).toEqual({
      react: 'npm:react@^19.0.0',
      'react/': 'npm:/react@^19.0.0/',
      'esm/': 'https://esm.sh/x@^1/',
    })
    expect(resolveImportMap(map, 'react/jsx-runtime', 'file:///k/a^b/x.ts').url).toBe(
      'npm:/react@^19.0.0/jsx-runtime',
    )
    expect(resolveImportMap(map, 'esm/y^z.js', 'file:///k/x.ts').url).toBe(
      'https://esm.sh/x@^1/y^z.js',
    )
  })
})

describe('expandImportMapValue (Deno package expansion)', () => {
  it('adds subpath entries for jsr: and npm: values only', () => {
    expect(
      expandImportMapValue({
        imports: {
          '@std/path': 'jsr:@std/path@^1',
          kleur: 'npm:kleur@^4',
          chalk: 'npm:/chalk@5',
          preact: 'https://esm.sh/preact@10',
          local: './local.ts',
          'has/': 'jsr:@x/has@1/',
          has: 'jsr:@x/has@1',
          dir: 'jsr:@x/dir/',
          nonString: 1,
        },
        scopes: { './s/': { x: 'jsr:@x/x' } },
        other: true,
      }),
    ).toEqual({
      imports: {
        '@std/path': 'jsr:@std/path@^1',
        '@std/path/': 'jsr:/@std/path@^1/',
        kleur: 'npm:kleur@^4',
        'kleur/': 'npm:/kleur@^4/',
        chalk: 'npm:/chalk@5',
        'chalk/': 'npm:/chalk@5/',
        preact: 'https://esm.sh/preact@10',
        local: './local.ts',
        'has/': 'jsr:@x/has@1/',
        has: 'jsr:@x/has@1',
        dir: 'jsr:@x/dir/',
        nonString: 1,
      },
      scopes: { './s/': { x: 'jsr:@x/x', 'x/': 'jsr:/@x/x/' } },
      other: true,
    })
  })

  it('leaves non-objects alone', () => {
    expect(expandImportMapValue(null)).toBeNull()
    expect(expandImportMapValue({ imports: [] })).toEqual({ imports: [] })
  })
})

describe('resolveImportMap (Deno deviations from the spec)', () => {
  const map = parseImportMap(
    expandImportMapValue({
      imports: {
        'rel/': './rel/',
        lodash: 'npm:lodash@4',
        'lodash/': 'npm:/lodash@4/',
        react: 'npm:react@^19.0.0',
        'jsr-nover': 'jsr:@std/path',
        'npm-tag': 'npm:preact@latest',
        abs: '/abs.ts',
        '@std/fmt/': 'jsr:@std/fmt@^1/',
      },
    }),
    'file:///k/deno.json',
  )
  const resolve = (specifier: string): string => {
    try {
      return resolveImportMap(map, specifier, 'file:///k/x.ts').url
    } catch (error) {
      return error instanceof DenoPluginError ? `ERROR ${error.code}` : String(error)
    }
  }

  // Experiment "k" (Deno 2.9.7).
  it.each([
    ['lodash/fp', 'npm:/lodash@4/fp'],
    ['lodash', 'npm:lodash@4'],
    ['react/jsx-runtime', 'npm:/react@^19.0.0/jsx-runtime'],
    ['jsr-nover/join', 'jsr:/@std/path/join'],
    ['npm-tag/hooks', 'npm:/preact@latest/hooks'],
    ['rel/a/b.ts', 'file:///k/rel/a/b.ts'],
    // Deno appends segments after a prefix and drops `..` (the spec would reject this).
    ['rel/a/../../escape.ts', 'file:///k/rel/a/escape.ts'],
    ['rel/../escape.ts', 'ERROR IMPORT_MAP_INVALID'],
    // The remainder is percent-decoded first, then URL-joined.
    ['rel/%2E%2E/escape.ts', 'ERROR IMPORT_MAP_INVALID'],
    ['rel/a%20b.ts', 'file:///k/rel/a%20b.ts'],
    ['rel/%E3%81%8D.ts', 'file:///k/rel/%E3%81%8D.ts'],
    ['rel/q.ts?raw#x', 'file:///k/rel/q.ts?raw#x'],
    ['abs', 'file:///abs.ts'],
    // A trailing-slash key whose jsr: target has no slash after the scheme cannot take subpaths.
    ['@std/fmt/colors', 'ERROR IMPORT_MAP_INVALID'],
    ['jsr:@std/path@1', 'jsr:@std/path@1'],
    ['unmapped', 'ERROR RESOLVE_UNMAPPED_BARE'],
  ])('%s -> %s', (specifier, expected) => {
    expect(resolve(specifier)).toBe(expected)
  })

  it('explains opaque jsr: prefixes in the hint', () => {
    expect(() => resolveImportMap(map, '@std/fmt/colors', 'file:///k/x.ts')).toThrow(
      expect.objectContaining({ hint: expect.stringContaining('jsr:/@std/fmt@^1/') }),
    )
  })
})

describe('createImportMapResolver: workspace (experiment "exp1")', () => {
  const root = folder(WS, {
    deno: {
      workspace: ['./packages/*'],
      imports: {
        '@std/path': 'jsr:@std/path@^1',
        kleur: 'npm:kleur@^4',
        shared: './shared/mod.ts',
        dup: './root-dup.ts',
        '@std/fmt/': 'jsr:@std/fmt@^1/',
        '@std/fmt2/': 'jsr:/@std/fmt@^1/',
        preact: 'https://esm.sh/preact@10',
        '@std/assert': 'jsr:@std/assert@^1',
        '@std/assert/': './my-assert/',
        withslash: 'npm:/chalk@5',
        'root-only': './root-only.ts',
      },
      scopes: { './scoped/': { dup: './scoped-dup.ts' } },
    },
  })
  const memberA = folder(`${WS}packages/a/`, {
    deno: {
      name: '@exp/a',
      version: '1.0.0',
      exports: { '.': './mod.ts', './sub': './sub.ts' },
      imports: {
        dup: './a-dup.ts',
        'only-a': './only-a.ts',
        chalk: 'npm:chalk@5',
        shared: 'https://example.com/shared.ts',
      },
      // Deno warns that member scopes are root-only and ignores them.
      scopes: { './inner/': { dup: './inner-dup.ts' } },
    },
  })
  const memberB = folder(`${WS}packages/b/`, {
    packageJson: {
      name: 'exp-b',
      version: '1.0.0',
      main: './index.js',
      dependencies: { 'left-pad': '^1.3.0' },
    },
  })
  const resolver = createImportMapResolver(workspace(root, [memberA, memberB]))
  const referrers = {
    root: `${WS}main.ts`,
    a: `${WS}packages/a/mod.ts`,
    inner: `${WS}packages/a/inner/x.ts`,
    scoped: `${WS}scoped/x.ts`,
    b: `${WS}packages/b/index.js`,
  }
  const table: Array<[string, Record<keyof typeof referrers, string | null>]> = [
    [
      '@std/path',
      {
        root: 'jsr:@std/path@^1',
        a: 'jsr:@std/path@^1',
        inner: 'jsr:@std/path@^1',
        scoped: 'jsr:@std/path@^1',
        b: 'jsr:@std/path@^1',
      },
    ],
    [
      '@std/path/join',
      {
        root: 'jsr:@std/path@^1/join',
        a: 'jsr:@std/path@^1/join',
        inner: 'jsr:@std/path@^1/join',
        scoped: 'jsr:@std/path@^1/join',
        b: 'jsr:@std/path@^1/join',
      },
    ],
    [
      'kleur/colors',
      {
        root: 'npm:kleur@^4/colors',
        a: 'npm:kleur@^4/colors',
        inner: 'npm:kleur@^4/colors',
        scoped: 'npm:kleur@^4/colors',
        b: 'npm:kleur@^4/colors',
      },
    ],
    [
      'shared',
      {
        root: `${WS}shared/mod.ts`,
        a: 'https://example.com/shared.ts',
        inner: 'https://example.com/shared.ts',
        scoped: `${WS}shared/mod.ts`,
        b: `${WS}shared/mod.ts`,
      },
    ],
    [
      'dup',
      {
        root: `${WS}root-dup.ts`,
        a: `${WS}packages/a/a-dup.ts`,
        inner: `${WS}packages/a/a-dup.ts`,
        scoped: `${WS}scoped-dup.ts`,
        b: `${WS}root-dup.ts`,
      },
    ],
    [
      '@std/fmt/colors',
      {
        root: 'ERROR IMPORT_MAP_INVALID',
        a: 'ERROR IMPORT_MAP_INVALID',
        inner: 'ERROR IMPORT_MAP_INVALID',
        scoped: 'ERROR IMPORT_MAP_INVALID',
        b: 'ERROR IMPORT_MAP_INVALID',
      },
    ],
    [
      '@std/fmt2/colors',
      {
        root: 'jsr:@std/fmt@^1/colors',
        a: 'jsr:@std/fmt@^1/colors',
        inner: 'jsr:@std/fmt@^1/colors',
        scoped: 'jsr:@std/fmt@^1/colors',
        b: 'jsr:@std/fmt@^1/colors',
      },
    ],
    [
      'preact',
      {
        root: 'https://esm.sh/preact@10',
        a: 'https://esm.sh/preact@10',
        inner: 'https://esm.sh/preact@10',
        scoped: 'https://esm.sh/preact@10',
        b: 'https://esm.sh/preact@10',
      },
    ],
    ['preact/hooks', { root: null, a: null, inner: null, scoped: null, b: null }],
    [
      '@std/assert/equals',
      {
        root: `${WS}my-assert/equals`,
        a: `${WS}my-assert/equals`,
        inner: `${WS}my-assert/equals`,
        scoped: `${WS}my-assert/equals`,
        b: `${WS}my-assert/equals`,
      },
    ],
    [
      'withslash/x',
      {
        root: 'npm:chalk@5/x',
        a: 'npm:chalk@5/x',
        inner: 'npm:chalk@5/x',
        scoped: 'npm:chalk@5/x',
        b: 'npm:chalk@5/x',
      },
    ],
    [
      'only-a',
      {
        root: null,
        a: `${WS}packages/a/only-a.ts`,
        inner: `${WS}packages/a/only-a.ts`,
        scoped: null,
        b: null,
      },
    ],
    ['chalk', { root: null, a: 'npm:chalk@5', inner: 'npm:chalk@5', scoped: null, b: null }],
    [
      'root-only',
      {
        root: `${WS}root-only.ts`,
        a: `${WS}root-only.ts`,
        inner: `${WS}root-only.ts`,
        scoped: `${WS}root-only.ts`,
        b: `${WS}root-only.ts`,
      },
    ],
    [
      '@exp/a',
      {
        root: `${WS}packages/a/mod.ts`,
        a: `${WS}packages/a/mod.ts`,
        inner: `${WS}packages/a/mod.ts`,
        scoped: `${WS}packages/a/mod.ts`,
        b: `${WS}packages/a/mod.ts`,
      },
    ],
    [
      '@exp/a/sub',
      {
        root: `${WS}packages/a/sub.ts`,
        a: `${WS}packages/a/sub.ts`,
        inner: `${WS}packages/a/sub.ts`,
        scoped: `${WS}packages/a/sub.ts`,
        b: `${WS}packages/a/sub.ts`,
      },
    ],
    [
      '@exp/a/missing',
      {
        root: 'ERROR RESOLVE_NOT_EXPORTED',
        a: 'ERROR RESOLVE_NOT_EXPORTED',
        inner: 'ERROR RESOLVE_NOT_EXPORTED',
        scoped: 'ERROR RESOLVE_NOT_EXPORTED',
        b: 'ERROR RESOLVE_NOT_EXPORTED',
      },
    ],
    // Deno resolves the package's `main` (`index.js`); the match gives the directory and
    // `packageName`/`subpath` so the caller applies Node rules.
    [
      'exp-b',
      {
        root: `${WS}packages/b/`,
        a: `${WS}packages/b/`,
        inner: `${WS}packages/b/`,
        scoped: `${WS}packages/b/`,
        b: `${WS}packages/b/`,
      },
    ],
    [
      'exp-b/x.js',
      {
        root: `${WS}packages/b/x.js`,
        a: `${WS}packages/b/x.js`,
        inner: `${WS}packages/b/x.js`,
        scoped: `${WS}packages/b/x.js`,
        b: `${WS}packages/b/x.js`,
      },
    ],
    ['left-pad', { root: null, a: null, inner: null, scoped: null, b: 'npm:left-pad@^1.3.0' }],
    [
      'jsr:@exp/a@^1',
      {
        root: `${WS}packages/a/mod.ts`,
        a: `${WS}packages/a/mod.ts`,
        inner: `${WS}packages/a/mod.ts`,
        scoped: `${WS}packages/a/mod.ts`,
        b: `${WS}packages/a/mod.ts`,
      },
    ],
    [
      'jsr:@exp/a@^1/sub',
      {
        root: `${WS}packages/a/sub.ts`,
        a: `${WS}packages/a/sub.ts`,
        inner: `${WS}packages/a/sub.ts`,
        scoped: `${WS}packages/a/sub.ts`,
        b: `${WS}packages/a/sub.ts`,
      },
    ],
    [
      'jsr:@exp/a',
      {
        root: `${WS}packages/a/mod.ts`,
        a: `${WS}packages/a/mod.ts`,
        inner: `${WS}packages/a/mod.ts`,
        scoped: `${WS}packages/a/mod.ts`,
        b: `${WS}packages/a/mod.ts`,
      },
    ],
    ['npm:kleur@4', { root: null, a: null, inner: null, scoped: null, b: null }],
  ]
  for (const [specifier, expected] of table) {
    for (const [name, referrer] of Object.entries(referrers)) {
      it(`${specifier} from ${name}`, () => {
        expect(outcome(() => resolver.resolve(specifier, referrer))).toBe(
          expected[name as keyof typeof referrers],
        )
      })
    }
  }

  it('describes where each mapping comes from', () => {
    expect(resolver.resolve('@std/path/join', referrers.root)).toEqual({
      mapped: 'jsr:@std/path@^1/join',
      kind: 'import-map',
      key: '@std/path/',
      configPath: '/ws/deno.json',
    })
    expect(resolver.resolve('dup', referrers.scoped)).toEqual({
      mapped: `${WS}scoped-dup.ts`,
      kind: 'import-map',
      scope: `${WS}scoped/`,
      key: 'dup',
      configPath: '/ws/deno.json',
    })
    expect(resolver.resolve('dup', referrers.inner)).toEqual({
      mapped: `${WS}packages/a/a-dup.ts`,
      kind: 'import-map',
      scope: `${WS}packages/a/`,
      key: 'dup',
      configPath: '/ws/packages/a/deno.json',
    })
    expect(resolver.resolve('@exp/a/sub', referrers.b)).toEqual({
      mapped: `${WS}packages/a/sub.ts`,
      kind: 'workspace-member',
      key: '@exp/a',
      configPath: '/ws/packages/a/deno.json',
    })
    expect(resolver.resolve('exp-b/x.js', referrers.a)).toEqual({
      mapped: `${WS}packages/b/x.js`,
      kind: 'workspace-member',
      key: 'exp-b',
      configPath: '/ws/packages/b/package.json',
      packageName: 'exp-b',
      subpath: '/x.js',
    })
    expect(resolver.resolve('left-pad/lib/x.js', referrers.b)).toEqual({
      mapped: 'npm:left-pad@^1.3.0/lib/x.js',
      kind: 'package-json-dependency',
      key: 'left-pad',
      configPath: '/ws/packages/b/package.json',
      packageName: 'left-pad',
      subpath: '/lib/x.js',
    })
  })

  it('carries the specifier and importer on errors', () => {
    expect(() => resolver.resolve('@std/fmt/colors', referrers.a)).toThrow(
      expect.objectContaining({ specifier: '@std/fmt/colors', importer: referrers.a }),
    )
    expect(() => resolver.resolve('@exp/a/missing')).toThrow(
      expect.objectContaining({ code: 'RESOLVE_NOT_EXPORTED', hint: 'Exports: ., ./sub.' }),
    )
  })

  it('uses the workspace root as referrer by default and accepts paths', () => {
    expect(resolver.resolve('dup')?.mapped).toBe(`${WS}root-dup.ts`)
    expect(resolver.resolve('only-a')).toBeNull()
  })

  it('lists owned keys: bare import-map keys and workspace package names', () => {
    expect(resolver.ownedKeys()).toEqual([
      '@exp/a',
      '@std/assert',
      '@std/fmt',
      '@std/fmt2',
      '@std/path',
      'chalk',
      'dup',
      'exp-b',
      'kleur',
      'only-a',
      'preact',
      'root-only',
      'shared',
      'withslash',
    ])
  })

  it('merges member imports into the combined map as scopes', () => {
    expect(resolver.map.scopes.map((scope) => scope.prefix)).toEqual([
      `${WS}scoped/`,
      `${WS}packages/a/`,
    ])
  })
})

describe('createImportMapResolver: links (experiment "e")', () => {
  const root = folder('file:///e/root/', {
    deno: {
      links: ['../linked', '../linkws/pkgs/p1'],
      imports: { viajsr: 'jsr:@fx/linked@^2', 'viajsr-old': 'jsr:@fx/linked@^1' },
    },
  })
  const linked = link('file:///e/linked/', {
    deno: {
      name: '@fx/linked',
      version: '2.1.0',
      exports: { '.': './mod.ts', './extra': './extra.ts' },
      imports: { 'linked-dep': './dep.ts' },
    },
  })
  // A link to a workspace member brings in the whole linked workspace.
  const p1 = link(
    'file:///e/linkws/pkgs/p1/',
    { deno: { name: '@fx/p1', exports: './mod.ts' } },
    '../linkws/pkgs/p1',
  )
  const p2 = link(
    'file:///e/linkws/pkgs/p2/',
    { deno: { name: '@fx/p2', exports: './mod.ts' } },
    '../linkws/pkgs/p1',
  )
  const resolver = createImportMapResolver(workspace(root, [], [linked, p1, p2]))
  const fromRoot = 'file:///e/root/src/x.ts'
  const fromLinked = 'file:///e/linked/mod.ts'

  it.each([
    ['@fx/linked', fromRoot, 'file:///e/linked/mod.ts'],
    ['@fx/linked/extra', fromRoot, 'file:///e/linked/extra.ts'],
    ['viajsr', fromRoot, 'file:///e/linked/mod.ts'],
    // 2.1.0 does not satisfy ^1: Deno warns and keeps the registry specifier.
    ['viajsr-old', fromRoot, 'jsr:@fx/linked@^1'],
    ['jsr:@fx/linked@2', fromRoot, 'file:///e/linked/mod.ts'],
    ['jsr:@fx/linked@^3', fromRoot, null],
    ['linked-dep', fromRoot, null],
    ['@fx/p1', fromRoot, 'file:///e/linkws/pkgs/p1/mod.ts'],
    ['@fx/p2', fromRoot, 'file:///e/linkws/pkgs/p2/mod.ts'],
    ['linked-dep', fromLinked, 'file:///e/linked/dep.ts'],
    ['viajsr', fromLinked, 'file:///e/linked/mod.ts'],
    ['@fx/linked/extra', fromLinked, 'file:///e/linked/extra.ts'],
  ])('%s from %s -> %s', (specifier, referrer, expected) => {
    expect(outcome(() => resolver.resolve(specifier, referrer))).toBe(expected)
  })

  it('reports links as kind "link"', () => {
    expect(resolver.resolve('viajsr', fromRoot)).toEqual({
      mapped: 'file:///e/linked/mod.ts',
      kind: 'link',
      key: 'viajsr',
      configPath: '/e/linked/deno.json',
    })
    expect(resolver.resolve('@fx/p2', fromRoot)?.kind).toBe('link')
    expect(resolver.resolve('viajsr-old', fromRoot)?.kind).toBe('import-map')
  })

  it('prefers workspace members over links with the same name', () => {
    const member = folder('file:///e/root/packages/linked/', {
      deno: { name: '@fx/linked', version: '2.0.0', exports: './member.ts' },
    })
    const withMember = createImportMapResolver(workspace(root, [member], [linked]))
    expect(withMember.resolve('@fx/linked', fromRoot)).toMatchObject({
      mapped: 'file:///e/root/packages/linked/member.ts',
      kind: 'workspace-member',
    })
  })
})

describe('createImportMapResolver: package.json dependencies (experiment "a")', () => {
  const root = folder('file:///a/', {
    deno: { workspace: ['./packages/m1', './packages/m2'] },
    packageJson: { name: 'root-pkg', dependencies: { 'root-dep': '^1.0.0' } },
  })
  const m1 = folder('file:///a/packages/m1/', {
    packageJson: { name: 'm1', dependencies: { 'm1-dep': '^1.0.0' } },
  })
  const m2 = folder('file:///a/packages/m2/', {
    packageJson: {
      name: 'm2',
      dependencies: { 'm2-dep': '^2.0.0', alias: 'npm:real-name@^3', ws: 'workspace:*' },
      devDependencies: {
        'm2-dep': '9.9.9',
        'dev-only': 'latest',
        'jsr-dep': 'jsr:@std/path@^1',
        local: 'file:../x',
      },
    },
  })
  const resolver = createImportMapResolver(workspace(root, [m1, m2]))

  it.each([
    ['root-dep', 'file:///a/x.ts', 'npm:root-dep@^1.0.0'],
    ['m1-dep', 'file:///a/x.ts', null],
    ['m1-dep', 'file:///a/packages/m1/x.ts', 'npm:m1-dep@^1.0.0'],
    ['root-dep', 'file:///a/packages/m1/x.ts', 'npm:root-dep@^1.0.0'],
    // Deno 2.9.7 misses `root-dep` from m2 (its folder lookup stops at the sibling m1); the
    // resolver consults every enclosing package.json, like Node resolution does.
    ['root-dep', 'file:///a/packages/m2/x.ts', 'npm:root-dep@^1.0.0'],
    ['m2-dep', 'file:///a/packages/m2/x.ts', 'npm:m2-dep@^2.0.0'],
    ['alias/sub', 'file:///a/packages/m2/x.ts', 'npm:real-name@^3/sub'],
    ['dev-only', 'file:///a/packages/m2/x.ts', 'npm:dev-only@latest'],
    ['jsr-dep/join', 'file:///a/packages/m2/x.ts', 'jsr:@std/path@^1/join'],
    ['local', 'file:///a/packages/m2/x.ts', 'file:../x'],
    ['m1', 'file:///a/packages/m2/x.ts', 'file:///a/packages/m1/'],
    ['root-pkg', 'file:///a/packages/m2/x.ts', 'file:///a/'],
    ['m1', 'file:///elsewhere/x.ts', null],
    ['#internal', 'file:///a/packages/m2/x.ts', null],
  ])('%s from %s -> %s', (specifier, referrer, expected) => {
    expect(outcome(() => resolver.resolve(specifier, referrer))).toBe(expected)
  })

  it('resolves workspace: dependencies to the member', () => {
    const withWs = createImportMapResolver(
      workspace(root, [
        m1,
        folder('file:///a/packages/m2/', {
          packageJson: { name: 'm2', dependencies: { m1: 'workspace:^' } },
        }),
      ]),
    )
    expect(withWs.resolve('m1/x.js', 'file:///a/packages/m2/y.ts')).toMatchObject({
      mapped: 'file:///a/packages/m1/x.js',
      kind: 'workspace-member',
      packageName: 'm1',
    })
  })

  it('does not claim dependency names', () => {
    expect(resolver.ownedKeys()).toEqual(['m1', 'm2', 'root-pkg'])
  })
})

describe('createImportMapResolver: external import maps (experiments "b1", "m")', () => {
  it('uses the file as base and does not expand packages', () => {
    const root = folder('file:///b1/', {
      deno: { importMap: './maps/import_map.json' },
      external: {
        url: 'file:///b1/maps/import_map.json',
        value: {
          imports: {
            '@std/path': 'jsr:@std/path@^1',
            local: './local.ts',
            'slash/': 'jsr:/@std/fmt@^1/',
          },
          scopes: { '../sub/': { local: './sub-local.ts' } },
        },
      },
    })
    const resolver = createImportMapResolver(workspace(root))
    expect(outcome(() => resolver.resolve('@std/path', 'file:///b1/x.ts'))).toBe('jsr:@std/path@^1')
    expect(outcome(() => resolver.resolve('@std/path/join', 'file:///b1/x.ts'))).toBeNull()
    expect(outcome(() => resolver.resolve('local', 'file:///b1/x.ts'))).toBe(
      'file:///b1/maps/local.ts',
    )
    expect(outcome(() => resolver.resolve('local', 'file:///b1/sub/x.ts'))).toBe(
      'file:///b1/maps/sub-local.ts',
    )
    expect(outcome(() => resolver.resolve('slash/colors', 'file:///b1/x.ts'))).toBe(
      'jsr:@std/fmt@^1/colors',
    )
    expect(resolver.resolve('local', 'file:///b1/x.ts')?.configPath).toBe(
      '/b1/maps/import_map.json',
    )
  })

  it('still applies member imports (despite Deno\'s "ignored" warning)', () => {
    const root = folder('file:///m/', {
      deno: { workspace: ['./p'], importMap: './im.json' },
      external: { url: 'file:///m/im.json', value: { imports: { ext: './ext.ts' } } },
    })
    const member = folder('file:///m/p/', {
      deno: { imports: { member: './member.ts', ext: './member-ext.ts' } },
    })
    const resolver = createImportMapResolver(workspace(root, [member]))
    expect(outcome(() => resolver.resolve('ext', 'file:///m/p/x.ts'))).toBe(
      'file:///m/p/member-ext.ts',
    )
    expect(outcome(() => resolver.resolve('member', 'file:///m/p/x.ts'))).toBe(
      'file:///m/p/member.ts',
    )
    expect(outcome(() => resolver.resolve('ext', 'file:///m/x.ts'))).toBe('file:///m/ext.ts')
  })
})

describe('createImportMapResolver: catalogs (experiment "cat")', () => {
  const catalog = { catalog: { react: '^19.0.0' }, catalogs: { legacy: { preact: '^10.0.0' } } }

  it('expands catalog: values in root and member imports', () => {
    const root = folder('file:///cat/', {
      deno: {
        ...catalog,
        workspace: ['./p'],
        imports: { react: 'catalog:', 'preact/': 'catalog:legacy' },
      },
    })
    const member = folder('file:///cat/p/', { deno: { imports: { react: 'catalog:' } } })
    const resolver = createImportMapResolver(workspace(root, [member]))
    for (const referrer of ['file:///cat/x.ts', 'file:///cat/p/x.ts']) {
      expect(outcome(() => resolver.resolve('react', referrer))).toBe('npm:react@^19.0.0')
      expect(outcome(() => resolver.resolve('react/jsx-runtime', referrer))).toBe(
        'npm:react@^19.0.0/jsx-runtime',
      )
      expect(outcome(() => resolver.resolve('preact/hooks', referrer))).toBe(
        'npm:preact@^10.0.0/hooks',
      )
      expect(outcome(() => resolver.resolve('preact', referrer))).toBeNull()
    }
  })

  it('prefers the root package.json catalogs', () => {
    const root = folder('file:///cat/', {
      deno: { ...catalog, imports: { react: 'catalog:' } },
      packageJson: { catalog: { react: '18.3.1' } },
    })
    expect(outcome(() => createImportMapResolver(workspace(root)).resolve('react'))).toBe(
      'npm:react@18.3.1',
    )
  })

  it('fails for packages missing from the catalog', () => {
    const root = folder('file:///cat/', { deno: { imports: { nope: 'catalog:' } } })
    expect(() => createImportMapResolver(workspace(root))).toThrow(
      expect.objectContaining({
        code: 'IMPORT_MAP_INVALID',
        message: expect.stringContaining('"nope"'),
      }),
    )
  })
})

describe('createImportMapResolver: edge cases', () => {
  it('merges a member scope into a root scope for the same directory (member wins)', () => {
    // Deno's synthetic import map (import_map `ext.rs`, test_synthetic_import_map2) combines them.
    const root = folder(WS, {
      deno: {
        workspace: ['./foo'],
        scopes: { './foo/': { root: './other.js', override: './overwritten.js' } },
      },
    })
    const member = folder(`${WS}foo/`, { deno: { imports: { override: './mine.js' } } })
    const resolver = createImportMapResolver(workspace(root, [member]))
    expect(outcome(() => resolver.resolve('override', `${WS}foo/x.ts`))).toBe(`${WS}foo/mine.js`)
    expect(outcome(() => resolver.resolve('root', `${WS}foo/x.ts`))).toBe(`${WS}other.js`)
  })

  it('throws for invalid (null) entries instead of falling back', () => {
    const root = folder(WS, {
      deno: { imports: { bad: 'not a url', 'lib/': './lib/', 'lib/x/': 'nope' } },
    })
    const resolver = createImportMapResolver(workspace(root))
    expect(outcome(() => resolver.resolve('bad'))).toBe('ERROR IMPORT_MAP_INVALID')
    expect(outcome(() => resolver.resolve('lib/x/y.ts'))).toBe('ERROR IMPORT_MAP_INVALID')
    expect(outcome(() => resolver.resolve('lib/y.ts'))).toBe(`${WS}lib/y.ts`)
    expect(resolver.warnings).toContain('Invalid address "not a url" for the specifier key "bad".')
  })

  it('maps URL-like keys and leaves unmapped URLs to the caller', () => {
    const root = folder(WS, {
      deno: {
        imports: {
          'https://deno.land/std@0.224.0/': './vendor/std/',
          'npm:chalk@5': 'npm:chalk@4',
          './legacy.ts': './modern.ts',
        },
      },
    })
    const resolver = createImportMapResolver(workspace(root))
    expect(
      resolver.resolve('https://deno.land/std@0.224.0/fmt/colors.ts', `${WS}main.ts`),
    ).toMatchObject({
      mapped: `${WS}vendor/std/fmt/colors.ts`,
      kind: 'import-map',
      key: 'https://deno.land/std@0.224.0/',
    })
    expect(outcome(() => resolver.resolve('npm:chalk@5', `${WS}main.ts`))).toBe('npm:chalk@4')
    expect(outcome(() => resolver.resolve('./legacy.ts', `${WS}main.ts`))).toBe(`${WS}modern.ts`)
    expect(outcome(() => resolver.resolve('./other.ts', `${WS}main.ts`))).toBeNull()
    expect(outcome(() => resolver.resolve('https://esm.sh/x', `${WS}main.ts`))).toBeNull()
    expect(resolver.ownedKeys()).toEqual([])
  })

  it('matches Windows drive letters case-insensitively', () => {
    const root = folder('file:///C:/ws/', {
      deno: { workspace: ['./a'], imports: { x: './x.ts' } },
    })
    const member = folder('file:///C:/ws/a/', { deno: { imports: { y: './y.ts' } } })
    const resolver = createImportMapResolver(workspace(root, [member]))
    expect(outcome(() => resolver.resolve('y', 'file:///c:/ws/a/mod.ts'))).toBe(
      'file:///C:/ws/a/y.ts',
    )
    expect(outcome(() => resolver.resolve('x', 'file:///c:/ws/a/mod.ts'))).toBe(
      'file:///C:/ws/x.ts',
    )
  })

  it('handles members without version, invalid exports and names without exports', () => {
    const root = folder(WS, { deno: { workspace: ['./a', './b', './c'] } })
    const a = folder(`${WS}a/`, { deno: { name: '@x/a', exports: './mod.ts' } })
    const b = folder(`${WS}b/`, { deno: { name: '@x/b', exports: { '.': 'mod.ts' } } })
    const c = folder(`${WS}c/`, { deno: { name: '@x/c' } })
    const resolver = createImportMapResolver(workspace(root, [a, b, c]))
    // No version: every jsr: range matches.
    expect(outcome(() => resolver.resolve('jsr:@x/a@^9'))).toBe(`${WS}a/mod.ts`)
    // Invalid exports: Deno ignores the package (with a warning).
    expect(outcome(() => resolver.resolve('@x/b'))).toBeNull()
    expect(resolver.warnings).toContain(
      `Ignoring the package "@x/b" in /ws/b/deno.json: the "." export "mod.ts" must start with "./".`,
    )
    // A name without exports: the package exists but exports nothing.
    expect(outcome(() => resolver.resolve('@x/c'))).toBe('ERROR RESOLVE_NOT_EXPORTED')
  })

  it('works without any config', () => {
    const resolver = createImportMapResolver(workspace(null))
    expect(resolver.resolve('react')).toBeNull()
    expect(resolver.resolve('./x.ts', 'file:///ws/main.ts')).toBeNull()
    expect(resolver.ownedKeys()).toEqual([])
  })
})
