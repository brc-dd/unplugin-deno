import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fixturesDir, loadFixture } from '../../test/helpers/fixture.js'
import { tempDir } from '../../test/helpers/temp-dir.js'
import type { TempDir } from '../../test/helpers/temp-dir.js'
import type { Lockfile, UnsupportedLockfile } from './lockfile.js'
import { parseLockfile, readLockfile } from './lockfile.js'

function v5(lockfile: Lockfile | UnsupportedLockfile | null): Lockfile {
  if (lockfile === null || lockfile.unsupported) throw new Error('expected a v5 lockfile')
  return lockfile
}

/**
 * Written by `deno install --entrypoint main.ts` (Deno 2.9.7, 2026-09-26) in a workspace with a
 * member importing npm:preact-render-to-string (a peer of preact), a member package.json and an
 * unversioned deno.land/std URL (redirected).
 */
const WORKSPACE_LOCK = {
  version: '5',
  specifiers: {
    'jsr:@std/fmt@1': '1.0.10',
    'npm:preact-render-to-string@6.5.11': '6.5.11_preact@10.24.3',
    'npm:preact@10.24.3': '10.24.3',
  },
  jsr: {
    '@std/fmt@1.0.10': {
      integrity: '90dfba288802ac6de82fb31d0917eb9e4450b9925b954d5e51fc29ac07419db5',
    },
  },
  npm: {
    'preact-render-to-string@6.5.11_preact@10.24.3': {
      integrity:
        'sha512-ubnauqoGczeGISiOh6RjX0/cdaF8v/oDXIjO85XALCQjwQP+SB4RDXXtvZ6yTYSjG+PC1QRP2AhPgCEsM2EvUw==',
      dependencies: ['preact'],
    },
    'preact@10.24.3': {
      integrity:
        'sha512-Z2dPnBnMUfyQfSQ+GBdsGa16hz35YmLmtTLhM169uW944hYL6xzTYkJjC07j+Wosz733pMWx0fgON3JNw1jJQA==',
    },
  },
  redirects: {
    'https://deno.land/std/fmt/printf.ts': 'https://deno.land/std@0.224.0/fmt/printf.ts',
  },
  remote: {
    'https://deno.land/std@0.224.0/fmt/printf.ts':
      '8d01408076e2f956b03dd8377010c4974515d6cc909978d2edc5c8cd75077eeb',
  },
  workspace: {
    dependencies: ['jsr:@std/fmt@1'],
    members: {
      'packages/tool': { packageJson: { dependencies: ['npm:left-pad@^1.3.0'] } },
      'packages/ui': {
        dependencies: ['npm:preact-render-to-string@6.5.11', 'npm:preact@10.24.3'],
      },
    },
  },
}

/** The sample from docs/research/multi-and-deno-tooling.md §6.4 (hashes shortened there). */
const RESEARCH_SAMPLE = `{
  "version": "5",
  "specifiers": { "jsr:@std/internal@^1.0.14": "1.0.14", "jsr:@std/path@1": "1.1.6", "npm:kleur@4": "4.1.5" },
  "jsr": {
    "@std/internal@1.0.14": { "integrity": "291516b3…fdf7" },
    "@std/path@1.1.6": { "integrity": "c68485c2…cbe", "dependencies": ["jsr:@std/internal"] }
  },
  "npm": { "kleur@4.1.5": { "integrity": "sha512-o+NO+8Wr…uQQ==" } },
  "remote": { "https://deno.land/std@0.224.0/assert/mod.ts": "48b8cb8a…d6f3" }
}`

describe('parseLockfile', () => {
  const lock = v5(parseLockfile(JSON.stringify(WORKSPACE_LOCK), '/ws/deno.lock'))

  it('reads every section', () => {
    expect(lock.path).toBe('/ws/deno.lock')
    expect(lock.version).toBe('5')
    expect(lock.specifiers['jsr:@std/fmt@1']).toBe('1.0.10')
    expect(lock.jsr['@std/fmt@1.0.10']).toEqual({
      integrity: '90dfba288802ac6de82fb31d0917eb9e4450b9925b954d5e51fc29ac07419db5',
      dependencies: [],
    })
    expect(lock.npm['preact-render-to-string@6.5.11_preact@10.24.3']).toMatchObject({
      dependencies: ['preact'],
      optionalDependencies: [],
      optionalPeers: [],
      tarball: undefined,
    })
    expect(lock.workspace).toEqual({
      dependencies: ['jsr:@std/fmt@1'],
      packageJsonDependencies: [],
      members: {
        'packages/tool': { dependencies: [], packageJsonDependencies: ['npm:left-pad@^1.3.0'] },
        'packages/ui': {
          dependencies: ['npm:preact-render-to-string@6.5.11', 'npm:preact@10.24.3'],
          packageJsonDependencies: [],
        },
      },
    })
  })

  it.each([
    // Deno writes normalised requirements: `^1.0.0` → `1`.
    ['jsr:@std/fmt@^1.0.0', 'jsr:@std/fmt@1.0.10'],
    ['jsr:@std/fmt@1', 'jsr:@std/fmt@1.0.10'],
    ['jsr:@std/fmt@^1/colors', 'jsr:@std/fmt@1.0.10/colors'],
    ['jsr:/@std/fmt@1.x/printf', 'jsr:@std/fmt@1.0.10/printf'],
    // npm versions keep the peer suffix in the lockfile; the pin does not.
    ['npm:preact-render-to-string@6.5.11', 'npm:preact-render-to-string@6.5.11'],
    ['npm:preact@10.24.3/hooks', 'npm:preact@10.24.3/hooks'],
    ['npm:/preact@10.24.3', 'npm:preact@10.24.3'],
    ['jsr:@std/fmt@^2', null],
    ['jsr:@std/fmt', null],
    ['npm:left-pad@^1.3.0', null],
    ['https://deno.land/std/fmt/printf.ts', null],
    ['npm:', null],
  ])('pin(%j) = %j', (specifier, expected) => {
    expect(lock.pin(specifier)).toBe(expected)
  })

  it('checks packages, remote integrity (following redirects) and npm dependencies', () => {
    expect(lock.hasPackage('jsr', '@std/fmt', '1.0.10')).toBe(true)
    expect(lock.hasPackage('jsr', '@std/fmt', '1.0.9')).toBe(false)
    expect(lock.hasPackage('npm', 'preact', '10.24.3')).toBe(true)
    expect(lock.hasPackage('npm', 'preact-render-to-string', '6.5.11')).toBe(true)
    expect(lock.hasPackage('npm', 'preact', '10.24')).toBe(false)
    expect(lock.remoteIntegrity('https://deno.land/std@0.224.0/fmt/printf.ts')).toBe(
      '8d01408076e2f956b03dd8377010c4974515d6cc909978d2edc5c8cd75077eeb',
    )
    expect(lock.remoteIntegrity('https://deno.land/std/fmt/printf.ts')).toBe(
      '8d01408076e2f956b03dd8377010c4974515d6cc909978d2edc5c8cd75077eeb',
    )
    expect(lock.remoteIntegrity('https://deno.land/std@0.224.0/fmt/colors.ts')).toBeNull()
    expect(lock.npmDependencies('preact-render-to-string@6.5.11')).toEqual(['preact'])
    expect(lock.npmDependencies('preact@10.24.3')).toEqual([])
    expect(lock.npmDependencies('react@19.0.0')).toBeNull()
    expect(lock.has('npm:preact@10.24.3')).toBe(true)
    expect(lock.has('jsr:@std/fmt@^1')).toBe(true)
    expect(lock.has('jsr:@std/path@^1')).toBe(false)
    expect(lock.has('https://deno.land/std/fmt/printf.ts')).toBe(true)
    expect(lock.has('https://example.com/x.ts')).toBe(false)
  })

  it('reads the research sample', () => {
    const sample = v5(parseLockfile(RESEARCH_SAMPLE, 'deno.lock'))
    expect(sample.pin('jsr:@std/path@^1/join')).toBe('jsr:@std/path@1.1.6/join')
    expect(sample.pin('npm:kleur@^4')).toBe('npm:kleur@4.1.5')
    expect(sample.pin('npm:kleur@^4.1.0')).toBeNull()
    expect(sample.jsr['@std/path@1.1.6']?.dependencies).toEqual(['jsr:@std/internal'])
    expect(sample.remoteIntegrity('https://deno.land/std@0.224.0/assert/mod.ts')).toBe(
      '48b8cb8a…d6f3',
    )
    expect(sample.redirects).toEqual({})
    expect(sample.workspace).toEqual({ dependencies: [], packageJsonDependencies: [], members: {} })
  })

  it('ignores unexpected shapes instead of failing', () => {
    const odd = v5(
      parseLockfile(
        JSON.stringify({
          version: '5',
          specifiers: { a: 1, 'npm:x@1': '1.0.0' },
          jsr: [],
          npm: { 'x@1.0.0': 'nope', 'y@1.0.0': { dependencies: ['z', 1] } },
          remote: null,
          workspace: { dependencies: 'x', members: { m: null } },
        }),
        'deno.lock',
      ),
    )
    expect(odd.specifiers).toEqual({ 'npm:x@1': '1.0.0' })
    expect(odd.jsr).toEqual({})
    expect(odd.npm['x@1.0.0']?.dependencies).toEqual([])
    expect(odd.npmDependencies('y@1.0.0')).toEqual(['z'])
    expect(odd.remote).toEqual({})
    expect(odd.workspace.members).toEqual({ m: { dependencies: [], packageJsonDependencies: [] } })
  })

  it.each([
    ['{"version": "4", "specifiers": {}}', '4'],
    ['{"version": "3", "packages": {}}', '3'],
    ['{"https://deno.land/x/mod.ts": "abc"}', '1'],
  ])('reports older formats as unsupported: %s', (text, version) => {
    expect(parseLockfile(text, 'deno.lock')).toEqual({
      path: 'deno.lock',
      version,
      unsupported: true,
    })
  })

  it('throws LOCKFILE_INVALID for unparsable content', () => {
    expect(() => parseLockfile('<<<<<<< HEAD\n{}', 'deno.lock')).toThrow(
      expect.objectContaining({ code: 'LOCKFILE_INVALID' }),
    )
    expect(() => parseLockfile('[]', 'deno.lock')).toThrow(
      expect.objectContaining({ code: 'LOCKFILE_INVALID' }),
    )
  })
})

describe('readLockfile', () => {
  let dir: TempDir

  beforeEach(async () => {
    dir = await tempDir({ 'empty/deno.lock': '', 'bad/deno.lock': '{', 'dir/deno.lock/': null })
  })

  afterEach(() => dir.dispose())

  it('returns null for missing and empty files', async () => {
    expect(await readLockfile(dir.path('missing/deno.lock'))).toBeNull()
    expect(await readLockfile(dir.path('empty/deno.lock'))).toBeNull()
  })

  it('throws LOCKFILE_INVALID for unreadable or unparsable files', async () => {
    await expect(readLockfile(dir.path('bad/deno.lock'))).rejects.toMatchObject({
      code: 'LOCKFILE_INVALID',
    })
    await expect(readLockfile(dir.path('dir/deno.lock'))).rejects.toMatchObject({
      code: 'LOCKFILE_INVALID',
    })
  })

  it('reads the lockfile-v5-sample fixture', async () => {
    const fixture = await loadFixture('lockfile-v5-sample')
    const lock = v5(await readLockfile(join(fixture.dir, 'deno.lock')))
    const expected = fixture.manifest.expect as {
      pins: Record<string, string | null>
      remote: Record<string, string>
      npmDependencies: Record<string, string[]>
    }
    const pins = Object.keys(expected.pins).map((specifier) => [specifier, lock.pin(specifier)])
    expect(Object.fromEntries(pins)).toEqual(expected.pins)
    for (const [url, integrity] of Object.entries(expected.remote)) {
      expect(lock.remoteIntegrity(url)).toBe(integrity)
    }
    for (const [nameVersion, deps] of Object.entries(expected.npmDependencies)) {
      expect(lock.npmDependencies(nameVersion)).toEqual(deps)
    }
    expect(lock.workspace.dependencies).toEqual(['jsr:@std/path@1.1.6', 'npm:strip-ansi@7.1.0'])
  })

  it('reads the smoke-jsr-npm fixture', async () => {
    const lock = v5(await readLockfile(join(fixturesDir, 'smoke-jsr-npm', 'deno.lock')))
    expect(lock.pin('jsr:@std/path@^1')).toBe('jsr:@std/path@1.1.6')
    expect(lock.pin('npm:kleur@^4/colors')).toBe('npm:kleur@4.1.5/colors')
    expect(lock.hasPackage('jsr', '@std/internal', '1.0.14')).toBe(true)
    expect(JSON.parse(await readFile(lock.path, 'utf8'))).toMatchObject({ version: '5' })
  })
})
