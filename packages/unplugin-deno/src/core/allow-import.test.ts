import { describe, expect, it } from 'vitest'
import { tempDir } from '../../test/helpers/temp-dir.js'
import { loadProject } from '../config/project.js'
import { isDenoPluginError } from '../diagnostics/errors.js'
import {
  createImportAllowList,
  DEFAULT_JSR_REGISTRY,
  jsrRegistryUrl,
  parseAllowImportEntry,
  projectRemoteUrls,
} from './allow-import.js'
import { DEFAULT_ALLOW_IMPORT } from './options.js'

function refusal(run: () => void): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error('expected DISALLOWED_HOST')
}

describe('parseAllowImportEntry', () => {
  it('reads hosts, ports, wildcards and IP addresses like Deno', () => {
    expect(parseAllowImportEntry('*')).toBe('all')
    expect(parseAllowImportEntry('Deno.Land')).toEqual({
      host: 'deno.land',
      wildcard: false,
      port: undefined,
    })
    expect(parseAllowImportEntry('deno.land:443')).toEqual({
      host: 'deno.land',
      wildcard: false,
      port: 443,
    })
    expect(parseAllowImportEntry('*.example.com:8443')).toEqual({
      host: 'example.com',
      wildcard: true,
      port: 8443,
    })
    expect(parseAllowImportEntry('127.0.0.1:4507')).toEqual({
      host: '127.0.0.1',
      wildcard: false,
      port: 4507,
    })
    expect(parseAllowImportEntry('[::1]:8000')).toEqual({
      host: '[::1]',
      wildcard: false,
      port: 8000,
    })
    expect(parseAllowImportEntry('bücher.example')).toMatchObject({ host: 'xn--bcher-kva.example' })
    expect(parseAllowImportEntry('example.com:99999')).toBeUndefined()
  })
})

describe('createImportAllowList', () => {
  const defaults = createImportAllowList({ allowImport: DEFAULT_ALLOW_IMPORT })

  it("allows Deno's default hosts over HTTPS only, as Deno 2.9.7 does", () => {
    expect(defaults.allows('https://deno.land/std@0.224.0/fmt/colors.ts')).toBe(true)
    expect(defaults.allows('https://esm.sh/preact@10')).toBe(true)
    expect(defaults.allows('https://raw.esm.sh/preact@10')).toBe(true)
    expect(defaults.allows('https://jsr.io/@std/path/1.1.6/mod.ts')).toBe(true)
    // `deno.land:443` does not cover port 80 (Deno: "Requires import access to deno.land:80").
    expect(defaults.allows('http://deno.land/std@0.224.0/fmt/colors.ts')).toBe(false)
    expect(defaults.allows('https://unpkg.com/kleur@4.1.5/colors.mjs')).toBe(false)
    // Not a subdomain wildcard: `jsdelivr.net` would not cover `cdn.jsdelivr.net` either.
    expect(defaults.allows('https://fastly.jsdelivr.net/npm/kleur')).toBe(false)
    // Other schemes are not remote imports.
    expect(defaults.allows('data:text/javascript,export default 1')).toBe(true)
    expect(defaults.allows('file:///x.ts')).toBe(true)
  })

  it('matches ports, wildcard subdomains (and the domain), case-insensitive hosts and *', () => {
    const list = createImportAllowList({
      allowImport: ['localhost:8000', '*.example.com', 'Example.org'],
      jsrRegistries: [],
    })
    expect(list.allows('http://localhost:8000/mod.ts')).toBe(true)
    expect(list.allows('http://localhost:8001/mod.ts')).toBe(false)
    expect(list.allows('https://cdn.example.com/mod.ts')).toBe(true)
    expect(list.allows('https://example.com/mod.ts')).toBe(true)
    expect(list.allows('https://notexample.com/mod.ts')).toBe(false)
    expect(list.allows('http://EXAMPLE.org:9000/mod.ts')).toBe(true)
    const all = createImportAllowList({ allowImport: ['*'] })
    expect(all.allowsAll).toBe(true)
    expect(all.allows('http://anything.test:1234/x.js')).toBe(true)
    expect(all.describe()).toBe('allowImport: every host')
  })

  it('always allows the hosts the project depends on and the JSR registries', () => {
    const list = createImportAllowList({
      allowImport: [],
      projectUrls: ['https://unpkg.com/kleur@4.1.5/colors.mjs', 'http://localhost:4545/x.ts'],
      jsrRegistries: [DEFAULT_JSR_REGISTRY, 'http://127.0.0.1:4507/'],
    })
    expect(list.allows('https://unpkg.com/other@1/mod.js')).toBe(true)
    expect(list.allows('http://unpkg.com/other@1/mod.js')).toBe(false)
    expect(list.allows('http://localhost:4545/y.ts')).toBe(true)
    expect(list.allows('https://jsr.io/@std/path/1.1.6/mod.ts')).toBe(true)
    expect(list.allows('http://127.0.0.1:4507/@mock/pkg/1.0.0/mod.ts')).toBe(true)
    expect(list.allows('https://deno.land/x/mod.ts')).toBe(false)
    expect(list.describe()).toContain('unpkg.com:443, localhost:4545, jsr.io:443, 127.0.0.1:4507')
  })

  it('refuses a disallowed host with DISALLOWED_HOST and a hint naming the host', () => {
    const error = refusal(() =>
      defaults.check('https://ga.jspm.io/npm:kleur@4.1.5/colors.mjs', { importer: '/p/src/x.ts' }),
    )
    expect(isDenoPluginError(error)).toBe(true)
    expect(error).toMatchObject({
      code: 'DISALLOWED_HOST',
      specifier: 'https://ga.jspm.io/npm:kleur@4.1.5/colors.mjs',
      importer: '/p/src/x.ts',
      message:
        'Importing https://ga.jspm.io/npm:kleur@4.1.5/colors.mjs is not allowed: ga.jspm.io:443 is not in `allowImport`.',
      hint: expect.stringContaining('Add "ga.jspm.io" to allowImport'),
    })
    const redirected = refusal(() =>
      defaults.check('http://localhost:8000/mod.ts', { redirectedFrom: 'https://deno.land/x' }),
    )
    expect(redirected).toMatchObject({
      message: expect.stringContaining('(redirected from https://deno.land/x)'),
      hint: expect.stringContaining('Add "localhost:8000" to allowImport'),
    })
    expect(() => defaults.check('https://deno.land/x/mod.ts')).not.toThrow()
  })
})

describe('jsrRegistryUrl', () => {
  it('reads JSR_URL (with a trailing slash) and defaults to jsr.io', () => {
    expect(jsrRegistryUrl({})).toBe('https://jsr.io/')
    expect(jsrRegistryUrl({ JSR_URL: '' })).toBe('https://jsr.io/')
    expect(jsrRegistryUrl({ JSR_URL: 'http://127.0.0.1:4507' })).toBe('http://127.0.0.1:4507/')
    expect(jsrRegistryUrl({ JSR_URL: 'https://jsr.example.com/registry/' })).toBe(
      'https://jsr.example.com/registry/',
    )
    expect(jsrRegistryUrl({ JSR_URL: 'not a url' })).toBe('https://jsr.io/')
  })
})

describe('projectRemoteUrls', () => {
  it('collects the remote URLs of deno.lock and of every import map', async () => {
    await using dir = await tempDir({
      'deno.json': {
        workspace: ['./member'],
        imports: {
          colors: 'https://unpkg.com/kleur@4.1.5/colors.mjs',
          '@std/path': 'jsr:@std/path@^1',
          local: './src/local.ts',
        },
        scopes: { './vendor/': { lib: 'http://localhost:4545/lib.ts' } },
      },
      'member/deno.json': { imports: { util: 'https://esm.sh/util@1' } },
      'deno.lock': {
        version: '5',
        remote: { 'https://deno.land/std@0.224.0/fmt/colors.ts': 'abc' },
        redirects: { 'https://example.com/latest': 'https://example.com/v1/mod.ts' },
      },
    })
    const project = await loadProject(dir.root)
    expect(projectRemoteUrls(project)).toEqual([
      'http://localhost:4545/lib.ts',
      'https://deno.land/std@0.224.0/fmt/colors.ts',
      'https://esm.sh/util@1',
      'https://example.com/latest',
      'https://example.com/v1/mod.ts',
      'https://unpkg.com/kleur@4.1.5/colors.mjs',
    ])
  })
})
