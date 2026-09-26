import { describe, expect, it } from 'vitest'
import { tempDir } from '../../test/helpers/temp-dir.js'
import type { Lockfile } from '../config/lockfile.js'
import { parseLockfile } from '../config/lockfile.js'
import type { Project } from '../config/project.js'
import { DenoPluginError } from '../diagnostics/errors.js'
import type { Logger } from '../diagnostics/logger.js'
import type { ResolvedModule } from '../engine/types.js'
import { sha256Hex } from '../utils/hash.js'
import type { LockCheck } from './lockfile-policy.js'
import {
  isCiEnvironment,
  jsrPackageOfUrl,
  lockfileDrift,
  lockfileModeFor,
  LockfilePolicy,
  withheldVersions,
} from './lockfile-policy.js'

const REGISTRIES = ['https://jsr.io/']

/** A lock pinning kleur 4.1.4 and @std/path 1.1.6, plus a remote module. */
const LOCK = parseLockfile(
  JSON.stringify({
    version: '5',
    specifiers: {
      'jsr:@std/path@1': '1.1.6',
      'npm:kleur@4.1.4': '4.1.4',
      'npm:preact-render-to-string@6': '6.5.11_preact@10.24.3',
    },
    jsr: { '@std/path@1.1.6': { integrity: 'c684' } },
    npm: {
      'kleur@4.1.4': { integrity: 'sha512-kleur' },
      'preact@10.24.3': { integrity: 'sha512-preact' },
      'preact-render-to-string@6.5.11_preact@10.24.3': {
        integrity: 'sha512-prts',
        dependencies: ['preact'],
      },
      'ansi-regex@6.3.0': { integrity: 'sha512-ansi' },
    },
    remote: { 'https://deno.land/std@0.224.0/fmt/colors.ts': '5085' },
    redirects: {
      'https://deno.land/std/fmt/colors.ts': 'https://deno.land/std@0.224.0/fmt/colors.ts',
    },
  }),
  '/p/deno.lock',
) as Lockfile

function npm(name: string, version: string): ResolvedModule {
  return {
    kind: 'npm',
    url: `file:///cache/${name}/${version}/index.js`,
    path: `/cache/${name}/${version}/index.js`,
    mediaType: 'JavaScript',
    npm: {
      name,
      version,
      subpath: '',
      packageDir: `/cache/${name}/${version}`,
      packageJsonPath: `/cache/${name}/${version}/package.json`,
    },
  }
}

function remote(url: string): ResolvedModule {
  return { kind: 'remote', url, mediaType: 'TypeScript' }
}

const drift = (check: LockCheck, lockfile: Lockfile | null = LOCK) =>
  lockfileDrift(lockfile, check, { jsrRegistries: REGISTRIES, npm: true })

interface RecordingLogger extends Logger {
  readonly lines: string[]
}

function recordingLogger(): RecordingLogger {
  const lines: string[] = []
  return {
    lines,
    debugEnabled: true,
    error: (message) => lines.push(`error ${message}`),
    warn: (message) => lines.push(`warn ${message}`),
    info: (message) => lines.push(`info ${message}`),
    debug: (message) => lines.push(`debug ${message}`),
    downloading: () => {},
  }
}

type PolicyProject = Pick<Project, 'lockfile' | 'minimumDependencyAge' | 'nodeModules'>

function policyProject(overrides: Partial<PolicyProject> = {}): PolicyProject {
  return {
    lockfile: LOCK,
    minimumDependencyAge: {
      newestDependencyDate: new Date('2026-09-25T00:00:00Z'),
      exclude: [],
      source: 'default',
    },
    nodeModules: {
      mode: 'none',
      explicit: false,
      dir: null,
      layout: null,
      hasJsrDeps: false,
      foreignManager: null,
    },
    ...overrides,
  }
}

function thrown(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error('expected an error')
}

describe('lockfileModeFor', () => {
  const withLock = { lockfile: LOCK, lockfileFrozen: false }
  it('turns auto into frozen on CI or with lock.frozen, when there is a lockfile', () => {
    expect(lockfileModeFor('auto', withLock, {})).toEqual({
      mode: 'auto',
      reason: "`lockfile: 'auto'`",
    })
    expect(lockfileModeFor('auto', withLock, { CI: 'true' })).toEqual({
      mode: 'frozen',
      reason: '`CI` is set',
    })
    expect(lockfileModeFor('auto', { lockfile: LOCK, lockfileFrozen: true }, {}).mode).toBe(
      'frozen',
    )
    expect(lockfileModeFor('auto', { lockfile: null, lockfileFrozen: false }, { CI: '1' })).toEqual(
      { mode: 'auto', reason: 'no deno.lock' },
    )
    expect(lockfileModeFor('frozen', { lockfile: null, lockfileFrozen: false }, {}).mode).toBe(
      'frozen',
    )
    expect(lockfileModeFor('off', withLock, { CI: 'true' }).mode).toBe('off')
  })

  it('reads CI like the ci-info convention: empty, 0 and false are off', () => {
    for (const value of ['true', '1', 'yes', 'github'])
      expect(isCiEnvironment({ CI: value })).toBe(true)
    for (const value of ['', '0', 'false', 'FALSE', 'no', 'off']) {
      expect(isCiEnvironment({ CI: value })).toBe(false)
    }
    expect(isCiEnvironment({})).toBe(false)
  })
})

describe('lockfileDrift', () => {
  it('accepts resolutions the lockfile records', () => {
    expect(drift({ specifier: 'npm:kleur@4.1.4', resolved: npm('kleur', '4.1.4') })).toBeNull()
    expect(
      drift({
        specifier: 'npm:preact-render-to-string@^6',
        resolved: npm('preact-render-to-string', '6.5.11'),
      }),
    ).toBeNull()
    expect(
      drift({
        specifier: 'jsr:@std/path@^1/posix',
        resolved: remote('https://jsr.io/@std/path/1.1.6/posix/mod.ts'),
      }),
    ).toBeNull()
    // Relative imports inside a JSR package, and packages imported by npm packages.
    expect(
      drift({ specifier: './join.ts', resolved: remote('https://jsr.io/@std/path/1.1.6/join.ts') }),
    ).toBeNull()
    expect(
      drift({ specifier: 'ansi-regex', resolved: npm('ansi-regex', '6.3.0'), transitive: true }),
    ).toBeNull()
    // Remote URLs, through redirects too.
    expect(
      drift({
        specifier: 'https://deno.land/std/fmt/colors.ts',
        resolved: remote('https://deno.land/std/fmt/colors.ts'),
      }),
    ).toBeNull()
    // Local files, data: URLs and builtins are not locked.
    expect(
      drift({
        specifier: 'node:fs',
        resolved: { kind: 'node', url: 'node:fs', mediaType: 'Unknown' },
      }),
    ).toBeNull()
  })

  it('reports requirements the lockfile lacks, with the versions it has', () => {
    expect(drift({ specifier: 'npm:kleur@^4.1.5', resolved: npm('kleur', '4.1.5') })).toEqual({
      resolved: 'npm:kleur@4.1.5',
      locked: undefined,
      message:
        'npm:kleur@^4.1.5 resolved to 4.1.5, but deno.lock has no entry for it (it locks kleur 4.1.4)',
    })
    expect(
      drift({
        specifier: 'jsr:@std/fmt@^1',
        resolved: remote('https://jsr.io/@std/fmt/1.0.8/mod.ts'),
      }),
    ).toMatchObject({
      message: 'jsr:@std/fmt@^1 resolved to 1.0.8, but deno.lock has no entry for it',
    })
    expect(
      drift({ specifier: 'strip-ansi', resolved: npm('strip-ansi', '7.1.0'), transitive: true }),
    ).toMatchObject({ message: 'npm:strip-ansi@7.1.0 is not in deno.lock' })
    expect(
      drift({ specifier: 'https://unpkg.com/x.js', resolved: remote('https://unpkg.com/x.js') }),
    ).toMatchObject({ message: 'https://unpkg.com/x.js is not in deno.lock' })
  })

  it('reports a version other than the pinned one', () => {
    const other = parseLockfile(
      JSON.stringify({
        version: '5',
        specifiers: { 'npm:kleur@4': '4.1.5' },
        npm: { 'kleur@4.1.5': {}, 'kleur@4.1.6': {} },
      }),
      '/p/deno.lock',
    ) as Lockfile
    expect(drift({ specifier: 'npm:kleur@^4', resolved: npm('kleur', '4.1.6') }, other)).toEqual({
      resolved: 'npm:kleur@4.1.6',
      locked: '4.1.5',
      message: 'npm:kleur@^4 resolved to 4.1.6, but deno.lock has 4.1.5',
    })
  })

  it('reports everything without a lockfile, and nothing for npm with nodeModulesDir manual', () => {
    expect(
      drift({ specifier: 'npm:kleur@4', resolved: npm('kleur', '4.1.5') }, null),
    ).toMatchObject({
      message: 'npm:kleur@4 resolved to 4.1.5',
    })
    expect(
      lockfileDrift(
        LOCK,
        { specifier: 'npm:kleur@^9', resolved: npm('kleur', '9.0.0') },
        { jsrRegistries: REGISTRIES, npm: false },
      ),
    ).toBeNull()
  })

  it('recognises JSR registry URLs', () => {
    expect(jsrPackageOfUrl('https://jsr.io/@std/path/1.1.6/mod.ts', REGISTRIES)).toEqual({
      name: '@std/path',
      version: '1.1.6',
    })
    expect(jsrPackageOfUrl('https://jsr.io/@std/path/meta.json', REGISTRIES)).toBeUndefined()
    expect(jsrPackageOfUrl('https://deno.land/x/mod.ts', REGISTRIES)).toBeUndefined()
  })
})

describe('LockfilePolicy', () => {
  const check: LockCheck = { specifier: 'npm:kleur@^4.1.5', resolved: npm('kleur', '4.1.5') }

  it("fails on drift in frozen mode with LOCKFILE_FROZEN_DRIFT and a 'deno install' hint", () => {
    const policy = new LockfilePolicy({
      decision: { mode: 'frozen', reason: '`CI` is set' },
      project: policyProject(),
      explain: true,
      logger: recordingLogger(),
      jsrRegistries: REGISTRIES,
      denoDirs: [],
    })
    const error = thrown(() => policy.check(check, '/p/src/main.ts'))
    expect(error).toBeInstanceOf(DenoPluginError)
    expect(error).toMatchObject({
      code: 'LOCKFILE_FROZEN_DRIFT',
      message:
        'deno.lock is out of date: npm:kleur@^4.1.5 resolved to 4.1.5, but deno.lock has no entry for it (it locks kleur 4.1.4).',
      hint: expect.stringContaining('Run `deno install` to update deno.lock'),
      specifier: 'npm:kleur@^4.1.5',
      importer: '/p/src/main.ts',
    })
    expect((error as DenoPluginError).hint).toContain('`CI` is set')
    expect(policy.describe()).toBe('lockfile /p/deno.lock, mode frozen (`CI` is set)')
    // `lockfile: 'frozen'` without a deno.lock: everything locked is missing.
    const none = new LockfilePolicy({
      decision: { mode: 'frozen', reason: "`lockfile: 'frozen'`" },
      project: policyProject({ lockfile: null }),
      explain: true,
      logger: recordingLogger(),
      jsrRegistries: REGISTRIES,
      denoDirs: [],
    })
    expect(thrown(() => none.check(check))).toMatchObject({
      code: 'LOCKFILE_FROZEN_DRIFT',
      message:
        'The lockfile is frozen, but there is no deno.lock: npm:kleur@^4.1.5 resolved to 4.1.5.',
      hint: expect.stringContaining('Run `deno install` to create deno.lock'),
    })
    expect(none.describe()).toBe("lockfile none, mode frozen (`lockfile: 'frozen'`)")
  })

  it('explains drift once in auto mode, and nothing when off', () => {
    const logger = recordingLogger()
    const policy = new LockfilePolicy({
      decision: { mode: 'auto', reason: "`lockfile: 'auto'`" },
      project: policyProject(),
      explain: true,
      logger,
      jsrRegistries: REGISTRIES,
      denoDirs: [],
    })
    policy.check(check)
    policy.check(check)
    expect(logger.lines).toEqual([
      "debug [lockfile] npm:kleur@^4.1.5 resolved to 4.1.5, but deno.lock has no entry for it (it locks kleur 4.1.4) (NOT_IN_LOCKFILE); allowed by `lockfile: 'auto'`, run `deno install` to update deno.lock",
    ])
    const quiet = recordingLogger()
    new LockfilePolicy({
      decision: { mode: 'off', reason: "`lockfile: 'off'`" },
      project: policyProject(),
      explain: true,
      logger: quiet,
      jsrRegistries: REGISTRIES,
      denoDirs: [],
    }).check(check)
    expect(quiet.lines).toEqual([])
  })

  it('turns a cachedOnly miss of a requirement the lockfile lacks into NOT_IN_LOCKFILE', () => {
    const policy = new LockfilePolicy({
      decision: { mode: 'auto', reason: "`lockfile: 'auto'`" },
      project: policyProject(),
      explain: true,
      logger: recordingLogger(),
      jsrRegistries: REGISTRIES,
      denoDirs: [],
    })
    const miss = new DenoPluginError('CACHED_ONLY_MISS', 'Not cached.', {
      specifier: 'npm:esm-env@1.2.2/browser',
      importer: '/p/src/main.ts',
    })
    expect(policy.explainFailure(miss, 'npm:esm-env@1.2.2/browser')).toMatchObject({
      code: 'NOT_IN_LOCKFILE',
      message: expect.stringContaining('npm:esm-env@1.2.2/browser is not in deno.lock'),
      hint: expect.stringContaining('Run `deno install`'),
      importer: '/p/src/main.ts',
    })
    // Locked requirements keep CACHED_ONLY_MISS; so does everything with checks.lockfile off.
    expect(policy.explainFailure(miss, 'npm:kleur@4.1.4')).toBe(miss)
    const unexplained = new LockfilePolicy({
      decision: { mode: 'auto', reason: "`lockfile: 'auto'`" },
      project: policyProject(),
      explain: false,
      logger: recordingLogger(),
      jsrRegistries: REGISTRIES,
      denoDirs: [],
    })
    expect(unexplained.explainFailure(miss, 'npm:esm-env@1.2.2')).toBe(miss)
  })
})

/** A DENO_DIR with the cached metadata of npm:fresh and jsr:@scope/fresh (versions published around a 2026-09-25 cutoff). */
async function denoDirWithPackument(): Promise<Awaited<ReturnType<typeof tempDir>>> {
  const meta = JSON.stringify({
    versions: {
      '1.0.0': { createdAt: '2026-01-01T00:00:00Z' },
      '1.1.0': { createdAt: '2026-09-25T12:00:00Z' },
      '2.0.0': { createdAt: '2026-09-25T13:00:00Z' },
    },
  })
  return tempDir({
    'npm/registry.npmjs.org/fresh/registry.json': {
      name: 'fresh',
      versions: { '1.0.0': {}, '1.1.0': {}, '1.2.0': {} },
      time: {
        '1.0.0': '2026-01-01T00:00:00.000Z',
        '1.1.0': '2026-09-25T10:00:00.000Z',
        '1.2.0': '2026-09-25T11:00:00.000Z',
      },
    },
    [`remote/https/jsr.io/${sha256Hex('/@scope/fresh/meta.json')}`]: `${meta}\n// denoCacheMetadata={"headers":{},"url":"https://jsr.io/@scope/fresh/meta.json","time":1}`,
  })
}

describe('the minimum dependency age', () => {
  const age = {
    newestDependencyDate: new Date('2026-09-25T00:00:00Z'),
    exclude: [],
  }

  it('lists the versions a range allows that were published after the cutoff', async () => {
    await using dir = await denoDirWithPackument()
    const lookup = { denoDirs: [dir.root], jsrRegistries: REGISTRIES }
    expect(withheldVersions('npm', 'fresh', '^1', age, lookup, '1.0.0')).toEqual({
      cutoff: age.newestDependencyDate,
      versions: [
        { version: '1.2.0', published: '2026-09-25T11:00:00.000Z' },
        { version: '1.1.0', published: '2026-09-25T10:00:00.000Z' },
      ],
    })
    expect(withheldVersions('jsr', '@scope/fresh', '^1', age, lookup)?.versions).toEqual([
      { version: '1.1.0', published: '2026-09-25T12:00:00.000Z' },
    ])
    expect(
      withheldVersions('npm', 'fresh', '^1', { ...age, exclude: ['fresh'] }, lookup),
    ).toBeUndefined()
    expect(
      withheldVersions('npm', 'fresh', '^1', { ...age, newestDependencyDate: null }, lookup),
    ).toBeUndefined()
    expect(withheldVersions('npm', 'missing', '^1', age, lookup)).toBeUndefined()
  })

  it('explains held-back versions in the debug output and on constraint errors', async () => {
    await using dir = await denoDirWithPackument()
    const logger = recordingLogger()
    const policy = new LockfilePolicy({
      decision: { mode: 'auto', reason: 'no deno.lock' },
      project: policyProject({ lockfile: null }),
      explain: true,
      logger,
      jsrRegistries: REGISTRIES,
      denoDirs: [dir.root],
    })
    policy.check({ specifier: 'npm:fresh@^1', resolved: npm('fresh', '1.0.0') })
    expect(logger.lines).toEqual([
      "debug [lockfile] npm:fresh@^1 resolved to 1.0.0, not 1.2.0 (published 2026-09-25T11:00:00.000Z): versions newer than 2026-09-25T00:00:00.000Z are held back by Deno's default minimum dependency age of 24 hours",
    ])
    const constraint = new DenoPluginError(
      'RESOLVE_CONSTRAINT',
      'No version of jsr:@scope/fresh@^1.1 matches.',
      {
        specifier: 'jsr:@scope/fresh@^1.1',
      },
    )
    expect(policy.explainFailure(constraint, 'jsr:@scope/fresh@^1.1')).toMatchObject({
      code: 'RESOLVE_CONSTRAINT',
      message: 'No version of jsr:@scope/fresh@^1.1 matches.',
      hint: expect.stringMatching(
        /^The versions of @scope\/fresh that satisfy \^1\.1 \(1\.1\.0 \(published 2026-09-25T12:00:00\.000Z\)\) are newer than 2026-09-25T00:00:00\.000Z, the cutoff of Deno's default minimum dependency age of 24 hours/,
      ),
    })
  })
})
