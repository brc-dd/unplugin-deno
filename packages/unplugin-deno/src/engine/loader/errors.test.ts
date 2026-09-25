import { beforeAll, describe, expect, it } from 'vitest'
import type { ErrorCode } from '../../diagnostics/errors.js'
import { DenoPluginError } from '../../diagnostics/errors.js'
import type { VendoredDenoLoader } from '../../vendored-deno-loader.js'
import { loadVendoredDenoLoader } from '../../vendored-deno-loader.js'
import { EngineResolveError, isOptionalDependencyError } from '../errors.js'
import type { LoaderErrorContext } from './errors.js'
import {
  classifyUnresolved,
  HINTS,
  lastResortHint,
  toDenoPluginError,
  unresolvedRequirementError,
} from './errors.js'

let ResolveError: VendoredDenoLoader['ResolveError']

beforeAll(async () => {
  ;({ ResolveError } = await loadVendoredDenoLoader())
})

/** A `ResolveError` built the way the vendored loader builds them (prototype swapped in). */
function resolveError(
  message: string,
  fields: { code?: string; specifier?: string; isOptionalDependency?: boolean } = {},
): Error {
  const error = Object.assign(new Error(message), fields)
  Object.setPrototypeOf(error, ResolveError.prototype)
  return error
}

const MAIN = 'file:///project/src/main.ts'

function context(overrides: Partial<LoaderErrorContext> = {}): LoaderErrorContext {
  return { specifier: 'x', referrer: MAIN, resolveErrorClass: ResolveError, ...overrides }
}

describe('toDenoPluginError', () => {
  it('returns DenoPluginErrors unchanged', () => {
    const error = new DenoPluginError('RESOLVE_FAILED', 'already mapped')
    expect(toDenoPluginError(error, context())).toBe(error)
  })

  it('maps ERR_MODULE_NOT_FOUND to RESOLVE_NOT_FOUND and keeps isOptionalDependency', () => {
    const plain = toDenoPluginError(
      resolveError("[ERR_MODULE_NOT_FOUND] Cannot find module 'file:///x/index.js'", {
        code: 'ERR_MODULE_NOT_FOUND',
        specifier: 'file:///x/index.js',
      }),
      context({ specifier: 'npm:x@1' }),
    )
    expect(plain).toBeInstanceOf(EngineResolveError)
    expect(plain).toMatchObject({
      code: 'RESOLVE_NOT_FOUND',
      isOptionalDependency: false,
      hint: HINTS.notFound,
      specifier: 'npm:x@1',
      importer: MAIN,
    })
    expect(plain.message).toBe(
      `Cannot resolve "npm:x@1" from "${MAIN}": [ERR_MODULE_NOT_FOUND] Cannot find module 'file:///x/index.js'`,
    )
    expect(isOptionalDependencyError(plain)).toBe(false)

    const optional = toDenoPluginError(
      resolveError('Cannot find package', {
        code: 'ERR_MODULE_NOT_FOUND',
        isOptionalDependency: true,
      }),
      context({ specifier: 'fsevents' }),
    )
    expect(optional).toMatchObject({
      code: 'RESOLVE_NOT_FOUND',
      isOptionalDependency: true,
      hint: HINTS.optionalDependency,
    })
    expect(isOptionalDependencyError(optional)).toBe(true)
  })

  it('maps ERR_PACKAGE_PATH_NOT_EXPORTED to RESOLVE_NOT_EXPORTED', () => {
    const error = toDenoPluginError(
      resolveError("[ERR_PACKAGE_PATH_NOT_EXPORTED] Package subpath './nope' is not defined", {
        code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
      }),
      context({ specifier: 'npm:kleur@^4/nope' }),
    )
    expect(error).toMatchObject({ code: 'RESOLVE_NOT_EXPORTED', hint: HINTS.notExported })
  })

  it('maps other Node.js codes to RESOLVE_FAILED', () => {
    const error = toDenoPluginError(
      resolveError(
        '[ERR_PACKAGE_IMPORT_NOT_DEFINED] Package import specifier "#x" is not defined',
        {
          code: 'ERR_PACKAGE_IMPORT_NOT_DEFINED',
        },
      ),
      context({ specifier: '#x' }),
    )
    expect(error.code).toBe('RESOLVE_FAILED')
    expect(error.message).toContain('ERR_PACKAGE_IMPORT_NOT_DEFINED')
  })

  it.each<[string, Partial<LoaderErrorContext>, { specifier?: string }, ErrorCode]>([
    ['an unmapped bare specifier', { specifier: 'left-pad' }, {}, 'RESOLVE_UNMAPPED_BARE'],
    ['a bare subpath', { specifier: '@scope/pkg/sub' }, {}, 'RESOLVE_UNMAPPED_BARE'],
    ['an npm: version constraint', { specifier: 'npm:kleur@^99' }, {}, 'RESOLVE_CONSTRAINT'],
    [
      'an npm: subpath with a constraint',
      { specifier: 'npm:kleur@^99/colors' },
      {},
      'RESOLVE_CONSTRAINT',
    ],
    [
      'the npm: requirement from the error',
      { specifier: 'kleur' },
      { specifier: 'npm:kleur@^99' },
      'RESOLVE_CONSTRAINT',
    ],
    [
      'the requirement a bare specifier maps to',
      { specifier: '@std/path', mapped: 'jsr:@std/path@^99' },
      {},
      'RESOLVE_CONSTRAINT',
    ],
    [
      'a jsr: subpath (maybe an unknown export)',
      { specifier: 'jsr:@std/path@^1/nope' },
      {},
      'RESOLVE_FAILED',
    ],
    [
      'a mapped jsr: subpath',
      { specifier: '@std/path/nope', mapped: 'jsr:/@std/path@^1/nope' },
      {},
      'RESOLVE_FAILED',
    ],
    ['a requirement without a version', { specifier: 'npm:left-pad' }, {}, 'RESOLVE_FAILED'],
    ['a relative specifier', { specifier: './x.ts' }, {}, 'RESOLVE_FAILED'],
    ['a URL', { specifier: 'https://x.test/a.ts' }, {}, 'RESOLVE_FAILED'],
  ])('classifies a ResolveError without a code for %s', (_name, overrides, fields, code) => {
    const error = toDenoPluginError(resolveError('failed', fields), context(overrides))
    expect(error.code).toBe(code)
  })

  it('suggests adding unmapped bare specifiers to the import map', () => {
    const error = toDenoPluginError(
      resolveError('Import "@scope/pkg/sub" not a dependency and not in import map'),
      context({ specifier: '@scope/pkg/sub' }),
    )
    expect(error.hint).toBe(
      'Add "@scope/pkg" to `imports` in deno.json (`deno add jsr:@scope/pkg` or `deno add npm:@scope/pkg`), or import it with a `jsr:`/`npm:` specifier.',
    )
  })

  it('treats errors that are not ResolveErrors as RESOLVE_FAILED', () => {
    const error = toDenoPluginError(new Error("Import 'https://x.test/a.ts' failed, not found."), {
      specifier: 'https://x.test/a.ts',
      operation: 'load',
      resolveErrorClass: ResolveError,
    })
    expect(error).toMatchObject({
      code: 'RESOLVE_FAILED',
      message:
        'Cannot load "https://x.test/a.ts": Import \'https://x.test/a.ts\' failed, not found.',
      hint: 'Check that the module exists at that path or URL.',
      importer: undefined,
    })
    expect(toDenoPluginError('boom', { specifier: 'x' }).message).toBe('Cannot resolve "x": boom')
    // Without the class, even a ResolveError is a generic failure.
    const coded = resolveError('x', { code: 'ERR_MODULE_NOT_FOUND' })
    expect(toDenoPluginError(coded, { specifier: 'x' }).code).toBe('RESOLVE_FAILED')
  })

  it('reports cache misses when cachedOnly blocked the module', () => {
    const error = toDenoPluginError(
      resolveError('Cannot find module', { code: 'ERR_MODULE_NOT_FOUND' }),
      context({ specifier: 'kleur', cachedOnlyMiss: true }),
    )
    expect(error).toMatchObject({
      code: 'CACHED_ONLY_MISS',
      hint: HINTS.cachedOnly,
      message: `Cannot resolve "kleur" from "${MAIN}": it is not in the Deno cache and \`cachedOnly\` is set.`,
    })
  })

  it('prefers the graph detail and strips terminal colors', () => {
    const error = toDenoPluginError(
      resolveError("Could not find constraint 'kleur@^99' in the list of packages."),
      context({
        specifier: 'npm:kleur@^99',
        detail: "Could not find npm package 'kleur' matching '^99'.\u001b[0m\n",
      }),
    )
    expect(error.message).toBe(
      `Cannot resolve "npm:kleur@^99" from "${MAIN}": Could not find npm package 'kleur' matching '^99'.`,
    )
    const colored = toDenoPluginError(new Error('at \u001b[36mfile:///x.ts\u001b[0m:1:1'), {
      specifier: 'x',
      referrer: undefined,
    })
    expect(colored.message).toBe('Cannot resolve "x": at file:///x.ts:1:1')
    expect(colored.cause).toBeInstanceOf(Error)
  })
})

describe('unresolvedRequirementError', () => {
  it('classifies requirements the loader returned unresolved', () => {
    const constraint = unresolvedRequirementError('jsr:@std/path@^99', {
      specifier: '@std/path',
      referrer: MAIN,
      detail:
        "Could not find version of '@std/path' that matches specified version constraint '^99'",
    })
    expect(constraint).toMatchObject({
      code: 'RESOLVE_CONSTRAINT',
      specifier: '@std/path',
      importer: MAIN,
      hint: HINTS.constraint,
      message: `Cannot resolve "@std/path" from "${MAIN}": Could not find version of '@std/path' that matches specified version constraint '^99'`,
    })
    const unknownExport = unresolvedRequirementError('jsr:@std/path@^1/nope', {
      specifier: 'jsr:@std/path@^1/nope',
      detail: "Unknown export './nope' for '@std/path@1.1.6'.",
    })
    expect(unknownExport).toMatchObject({ code: 'RESOLVE_FAILED', hint: HINTS.notExported })
    const unknownPackage = unresolvedRequirementError('jsr:@nope/nope@^1', {
      specifier: 'jsr:@nope/nope@^1',
      detail: 'JSR package not found: @nope/nope',
    })
    expect(unknownPackage).toMatchObject({
      code: 'RESOLVE_CONSTRAINT',
      hint: 'Check the package name and that it is published to the registry.',
    })
    const missing = unresolvedRequirementError('jsr:@nope/nope', { specifier: 'jsr:@nope/nope' })
    expect(missing).toMatchObject({
      code: 'RESOLVE_FAILED',
      message: 'Cannot resolve "jsr:@nope/nope": the loader could not resolve jsr:@nope/nope.',
    })
    const blocked = unresolvedRequirementError('jsr:@std/path@^1', {
      specifier: '@std/path',
      cachedOnlyMiss: true,
    })
    expect(blocked.code).toBe('CACHED_ONLY_MISS')
  })
})

describe('classifyUnresolved', () => {
  it.each<[string, ErrorCode]>([
    ['kleur', 'RESOLVE_UNMAPPED_BARE'],
    ['npm:kleur@^99', 'RESOLVE_CONSTRAINT'],
    ['npm:kleur@^99/colors', 'RESOLVE_CONSTRAINT'],
    ['jsr:@std/path@^99', 'RESOLVE_CONSTRAINT'],
    ['jsr:@std/path@^99/join', 'RESOLVE_FAILED'],
    ['jsr:@std/path', 'RESOLVE_FAILED'],
    ['npm:kleur', 'RESOLVE_FAILED'],
    ['./x.ts', 'RESOLVE_FAILED'],
    ['node:fs', 'RESOLVE_FAILED'],
  ])('%s -> %s', (target, code) => {
    expect(classifyUnresolved(target)).toBe(code)
  })
})

describe('lastResortHint', () => {
  it.each<[string, string | undefined]>([
    ["Unknown export './nope' for '@std/path@1.1.6'.", HINTS.notExported],
    [
      "Could not find version of '@std/path' that matches specified version constraint '^99'",
      HINTS.constraint,
    ],
    ["Could not find npm package 'kleur' matching '^99'.", HINTS.constraint],
    [
      'JSR package not found: @nope/nope',
      'Check the package name and that it is published to the registry.',
    ],
    [
      "npm package 'nope' does not exist.",
      'Check the package name and that it is published to the registry.',
    ],
    [
      "Could not find a matching package for 'npm:x@1' in the node_modules directory.",
      HINTS.notFound,
    ],
    [
      'Relative import path "x" not prefixed with / or ./ or ../',
      'Relative imports must start with `./` or `../`; bare names must be mapped in deno.json `imports`.',
    ],
    [
      'Unsupported scheme "bun" for module "bun:sqlite".',
      'Deno cannot load this scheme; mark the import as external.',
    ],
    [
      'error sending request for url (https://x.test/a.ts)',
      'Check the network connection and proxy settings (a custom `fetch` can be passed to the plugin).',
    ],
    [
      'Module not found "https://x.test/a.ts".',
      'Check that the module exists at that path or URL.',
    ],
    ['something else entirely', undefined],
  ])('%s', (message, hint) => {
    expect(lastResortHint(message)).toBe(hint)
  })
})
