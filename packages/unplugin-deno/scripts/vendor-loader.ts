/**
 * Vendors `@deno/loader` from JSR's npm-compatible registry into `vendor/deno-loader/`.
 *
 * Usage (from `packages/unplugin-deno/`, Node >= 22.18 for type stripping):
 *
 *     node scripts/vendor-loader.ts [version]     # default: the `latest` dist-tag
 *
 * The script downloads `@jsr/deno__loader@<version>` from https://npm.jsr.io, verifies the
 * tarball integrity, copies the files the Node.js code path needs, applies the patches below and
 * writes `VERSION` and `NOTICE.md`. Every patch asserts how often its pattern occurs, so
 * re-vendoring a version whose glue changed fails loudly instead of silently shipping unpatched
 * code. Re-running it for the same version reproduces the committed files byte for byte.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REGISTRY = 'https://npm.jsr.io'
const NPM_NAME = '@jsr/deno__loader'
const JSR_NAME = '@deno/loader'
const UPSTREAM_REPO = 'https://github.com/denoland/deno-js-loader'

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const vendorDir = join(packageDir, 'vendor', 'deno-loader')
const overlayDir = join(packageDir, 'scripts', 'deno-loader-overlay')

interface Patch {
  /** What the patch does; listed in NOTICE.md. */
  description: string
  /** Pattern that must occur exactly `count` times before the patch is applied. */
  find: string | RegExp
  /** Replacement; `$&` is not interpreted for string patterns. */
  replace: string
  /** Expected number of occurrences (default 1). */
  count?: number
}

interface VendoredFile {
  /** Path inside the extracted tarball (`package/…`), or `null` for files added by this script. */
  from: string | null
  /** Path inside `vendor/deno-loader/`, with `/` separators. */
  to: string
  patches?: Patch[]
  /** Assertions on the final file content (patterns that must not occur). */
  forbid?: RegExp[]
}

interface DistInfo {
  tarball: string
  integrity?: string
  shasum?: string
}

const NO_CONSOLE = /\bconsole\./
/** `console.` outside JSDoc lines (`mod.js` keeps its `@example` block, which mentions `console.log`). */
const NO_CONSOLE_IN_CODE = /^[^*\n]*\bconsole\./m
const NO_DENO_BRANCH = /typeof Deno\b/
const NO_WASM_ESM_IMPORT = /from\s+["'][^"']*\.wasm["']/

function modJsPatches(): Patch[] {
  return [
    {
      description:
        'Always load the wasm through `rs_lib_node.js` (`readFileSync` + synchronous `WebAssembly.Module`/`Instance`) ' +
        'on every runtime, instead of `import * as wasm from "./rs_lib.wasm"` when `typeof Deno !== "undefined"`. ' +
        'The Deno-only `lib/rs_lib.js` is not vendored.',
      find: /let _lib;\s*if \(typeof Deno !== "undefined"\) \{\s*_lib = await import\("\.\/lib\/rs_lib\.js"\);\s*\} else \{\s*_lib = await import\("\.\/rs_lib_node\.js"\);\s*\}/,
      replace:
        '// [unplugin-deno] patched: one wasm loading path on Node.js, Deno and Bun (see NOTICE.md).\n' +
        'import * as _lib from "./rs_lib_node.js";\n' +
        'import { emitDebug } from "./hooks.js";',
    },
    {
      description: 'Route the `debug: true` output of `Loader` (`console.error`) to `emitDebug`.',
      find: 'console.error(',
      replace: 'emitDebug(',
      count: 5,
    },
    {
      description: 'Drop the `sourceMappingURL` comment (the map and `mod.ts` are not vendored).',
      find: /\n\/\/# sourceMappingURL=mod\.js\.map\s*$/,
      replace: '\n',
    },
  ]
}

function internalJsPatches(): Patch[] {
  return [
    {
      description: 'Import the hooks module.',
      find: /^import \{ fetch_specifier \} from "\.\/snippets\/rs_lib-[0-9a-f]+\/helpers\.js";$/m,
      replace: 'import { emitLog, emitRustLog } from "../hooks.js";\n$&',
    },
    {
      description:
        'Route Rust panic messages (`console_error_panic_hook`, `console.error(String)`) to the logger as `kind: "panic"`.',
      find: /console\.error\(getStringFromWasm0\(arg0, arg1\)\);/,
      replace: 'emitLog({ kind: "panic", message: getStringFromWasm0(arg0, arg1) });',
    },
    {
      description:
        'Route Rust `log` records (`<LEVEL> RS - …`) and reporter lines (`Blocking …`, `Initialize …`) to the logger.',
      find: /(export function __wbg_error_[0-9a-f]+\(arg0\) \{\s*)console\.error\(arg0\);/,
      replace: '$1emitRustLog(arg0);',
    },
  ]
}

function helpersJsPatches(): Patch[] {
  return [
    {
      description: 'Import the hooks module.',
      find: /^export async function fetch_specifier\(/m,
      replace: 'import { emitLog, fetchWithRetry } from "../../../hooks.js";\n\n$&',
    },
    {
      description: 'Route `console.error("Downloading", url)` to the logger as `kind: "download"`.',
      find: 'console.error("Downloading", specifier);',
      replace: 'emitLog({ kind: "download", url: specifier });',
    },
    {
      description:
        'Fetch through the injectable fetch (default `globalThis.fetch` at call time) with 3 jittered retries ' +
        'on network errors, HTTP 429 and HTTP 5xx (upstream has no retries).',
      find: 'const response = await fetch(specifier, options);',
      replace: 'const response = await fetchWithRetry(specifier, options);',
    },
  ]
}

async function main(): Promise<void> {
  const requested = process.argv[2]
  const metadata = await fetchJson(`${REGISTRY}/${NPM_NAME}`)
  const version = requested ?? readLatest(metadata)
  const dist = readDist(metadata, version)

  const workDir = await mkdtemp(join(tmpdir(), 'unplugin-deno-vendor-'))
  try {
    console.log(`Downloading ${NPM_NAME}@${version} from ${dist.tarball}`)
    const tarball = await fetchBytes(dist.tarball)
    verifyIntegrity(tarball, dist)
    await writeFile(join(workDir, 'package.tgz'), tarball)
    // Relative paths only: GNU tar (e.g. from Git for Windows) treats `C:` as a remote host.
    execFileSync('tar', ['-xzf', 'package.tgz'], { cwd: workDir, stdio: 'inherit' })
    const extracted = join(workDir, 'package')

    const helpers = await findSnippet(extracted, /^rs_lib-[0-9a-f]+$/, 'helpers.js')
    const snippetFiles = await listFiles(join(extracted, 'src', 'lib', 'snippets'))
    const files: VendoredFile[] = [
      {
        from: 'src/mod.js',
        to: 'mod.js',
        patches: modJsPatches(),
        forbid: [NO_CONSOLE_IN_CODE, NO_DENO_BRANCH, NO_WASM_ESM_IMPORT, /rs_lib\.js"/],
      },
      { from: '_dist/src/mod.d.ts', to: 'mod.d.ts', patches: modDtsPatches() },
      { from: 'src/rs_lib_node.js', to: 'rs_lib_node.js', forbid: [NO_DENO_BRANCH, NO_CONSOLE] },
      {
        from: 'src/lib/rs_lib.internal.js',
        to: 'lib/rs_lib.internal.js',
        patches: internalJsPatches(),
        forbid: [NO_CONSOLE, NO_WASM_ESM_IMPORT],
      },
      { from: 'src/lib/rs_lib.wasm', to: 'lib/rs_lib.wasm' },
      { from: 'src/lib/rs_lib.d.ts', to: 'lib/rs_lib.d.ts' },
      ...snippetFiles.map((file): VendoredFile => {
        const path = `src/lib/snippets/${file}`
        return path === helpers
          ? {
              from: path,
              to: `lib/snippets/${file}`,
              patches: helpersJsPatches(),
              forbid: [NO_CONSOLE, /(?<![\w.])fetch\(/],
            }
          : { from: path, to: `lib/snippets/${file}`, forbid: [NO_CONSOLE] }
      }),
      { from: 'LICENSE', to: 'LICENSE' },
      { from: null, to: 'hooks.js' },
      { from: null, to: 'hooks.d.ts' },
    ]

    await assertNodePath(extracted)
    await rm(vendorDir, { recursive: true, force: true })
    for (const file of files) {
      await vendorFile(extracted, file)
    }
    await writeFile(join(vendorDir, 'VERSION'), `${version}\n`)
    await writeFile(join(vendorDir, 'NOTICE.md'), await renderNotice(version, dist, files))

    await smokeTest()
    await printSummary()
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

function modDtsPatches(): Patch[] {
  return [
    {
      description: 'Drop the `sourceMappingURL` comment (the map is not vendored).',
      find: /\n?\/\/# sourceMappingURL=mod\.d\.ts\.map\s*$/,
      replace: '\n',
    },
  ]
}

async function vendorFile(extracted: string, file: VendoredFile): Promise<void> {
  const target = join(vendorDir, ...file.to.split('/'))
  await mkdir(dirname(target), { recursive: true })
  if (file.from === null) {
    await copyFile(join(overlayDir, file.to), target)
    await chmod(target, 0o644)
    return
  }
  const source = join(extracted, ...file.from.split('/'))
  if (!file.patches && !file.forbid) {
    // The tarball marks every file executable; git should not record that.
    await copyFile(source, target)
    await chmod(target, 0o644)
    return
  }
  let text = await readFile(source, 'utf8')
  for (const patch of file.patches ?? []) {
    text = applyPatch(file.to, text, patch)
  }
  for (const pattern of file.forbid ?? []) {
    if (pattern.test(text)) {
      throw new Error(`${file.to}: still contains ${pattern} after patching; update the patches.`)
    }
  }
  await writeFile(target, text)
}

function applyPatch(file: string, text: string, patch: Patch): string {
  const expected = patch.count ?? 1
  if (typeof patch.find === 'string') {
    const found = text.split(patch.find).length - 1
    assertCount(file, patch, found, expected)
    return text.split(patch.find).join(patch.replace)
  }
  const flags = patch.find.flags.includes('g') ? patch.find.flags : `${patch.find.flags}g`
  const pattern = new RegExp(patch.find.source, flags)
  const found = [...text.matchAll(pattern)].length
  assertCount(file, patch, found, expected)
  return text.replace(pattern, patch.replace)
}

function assertCount(file: string, patch: Patch, found: number, expected: number): void {
  if (found !== expected) {
    throw new Error(
      `${file}: expected ${expected} occurrence(s) of ${String(patch.find)} but found ${found}.\n` +
        `Upstream changed; review the patch "${patch.description}".`,
    )
  }
}

/** The Node.js code path the patched `mod.js` relies on must look like 0.5.0's. */
async function assertNodePath(extracted: string): Promise<void> {
  const nodeGlue = await readFile(join(extracted, 'src', 'rs_lib_node.js'), 'utf8')
  const expectations = [
    /readFileSync\(wasmPath\)/,
    /join\(__dirname, "lib", "rs_lib\.wasm"\)/,
    /new WebAssembly\.Module\(wasmBytes\)/,
    /new WebAssembly\.Instance\(wasmModule,/,
    /__wbindgen_start\(\)/,
  ]
  for (const pattern of expectations) {
    if (!pattern.test(nodeGlue)) {
      throw new Error(
        `src/rs_lib_node.js: expected ${pattern}; the Node.js wasm loading path changed.`,
      )
    }
  }
}

async function smokeTest(): Promise<void> {
  const mod: unknown = await import(pathToFileURL(join(vendorDir, 'mod.js')).href)
  const exports = mod as Record<string, unknown>
  for (const name of ['Workspace', 'Loader', 'ResolveError', 'MediaType', 'ResolutionMode']) {
    if (exports[name] === undefined) {
      throw new Error(`vendor/deno-loader/mod.js does not export ${name}.`)
    }
  }
  console.log('Smoke test: vendored mod.js imports and instantiates the wasm.')
}

async function renderNotice(
  version: string,
  dist: DistInfo,
  files: VendoredFile[],
): Promise<string> {
  const rows: string[] = []
  for (const file of files) {
    const size = (await stat(join(vendorDir, ...file.to.split('/')))).size
    const origin = file.from === null ? 'added by unplugin-deno' : `\`package/${file.from}\``
    rows.push(`| \`${file.to}\` | ${origin} | ${size.toLocaleString('en-US')} B |`)
  }
  const patches = files.flatMap((file) =>
    (file.patches ?? []).map(
      (patch) =>
        `- \`${file.to}\`: ${patch.description} Asserted pattern (x${patch.count ?? 1}): ` +
        `\`${String(patch.find).replaceAll('`', '\\`')}\``,
    ),
  )
  return [
    '# Vendored `@deno/loader`',
    '',
    `This directory is a patched copy of [\`${JSR_NAME}\`](https://jsr.io/${JSR_NAME}) **${version}**,`,
    'generated by `scripts/vendor-loader.ts`. Do not edit it by hand: change the script and run',
    `\`node scripts/vendor-loader.ts ${version}\` from \`packages/unplugin-deno/\`.`,
    '',
    `- Upstream: ${UPSTREAM_REPO} (MIT, see \`LICENSE\`)`,
    `- Package: \`${NPM_NAME}@${version}\` from ${REGISTRY}`,
    `- Tarball: ${dist.tarball}`,
    `- Integrity: \`${dist.integrity ?? `sha1-${dist.shasum ?? 'unknown'}`}\``,
    '',
    '## Files',
    '',
    '| File | Origin | Size |',
    '| --- | --- | --- |',
    ...rows,
    '',
    'Only the Node.js code path is vendored; `src/lib/rs_lib.js` (Deno-only Wasm ESM import), the',
    'TypeScript sources, the Rust sources and source maps are omitted.',
    '',
    '## Patches',
    '',
    ...patches,
    '',
    '## Added files',
    '',
    '- `hooks.js` / `hooks.d.ts`: `setLogger(fn)` and `setFetch(fn)` injection points used by the',
    '  patched glue (default: no output, `globalThis.fetch`). Source: `scripts/deno-loader-overlay/`.',
    '- `VERSION`, `NOTICE.md`: provenance.',
    '',
  ].join('\n')
}

async function printSummary(): Promise<void> {
  const files = await listFiles(vendorDir)
  let total = 0
  for (const file of files) {
    const size = (await stat(join(vendorDir, ...file.split('/')))).size
    total += size
    console.log(`  ${file.padEnd(52)} ${size.toLocaleString('en-US').padStart(12)} B`)
  }
  console.log(`  ${'total'.padEnd(52)} ${total.toLocaleString('en-US').padStart(12)} B`)
}

async function findSnippet(
  extracted: string,
  dirPattern: RegExp,
  fileName: string,
): Promise<string> {
  const snippetsDir = join(extracted, 'src', 'lib', 'snippets')
  const dirs = (await readdir(snippetsDir)).filter((name) => dirPattern.test(name))
  if (dirs.length !== 1) {
    throw new Error(
      `Expected one snippets directory matching ${dirPattern}, found: ${dirs.join(', ')}`,
    )
  }
  return `src/lib/snippets/${dirs[0]}/${fileName}`
}

/** Lists files under `dir` recursively as sorted `/`-separated relative paths. */
async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .toSorted()
}

function readLatest(metadata: unknown): string {
  const latest = getPath(metadata, ['dist-tags', 'latest'])
  if (typeof latest !== 'string') throw new Error(`${NPM_NAME}: no "latest" dist-tag`)
  return latest
}

function readDist(metadata: unknown, version: string): DistInfo {
  const dist = getPath(metadata, ['versions', version, 'dist'])
  const tarball = getPath(dist, ['tarball'])
  if (typeof tarball !== 'string')
    throw new Error(`${NPM_NAME}@${version} not found on ${REGISTRY}`)
  const integrity = getPath(dist, ['integrity'])
  const shasum = getPath(dist, ['shasum'])
  return {
    tarball,
    ...(typeof integrity === 'string' ? { integrity } : {}),
    ...(typeof shasum === 'string' ? { shasum } : {}),
  }
}

function verifyIntegrity(bytes: Uint8Array, dist: DistInfo): void {
  if (dist.integrity) {
    const [algorithm, expected] = dist.integrity.split('-', 2)
    if (!algorithm || !expected) throw new Error(`Malformed integrity ${dist.integrity}`)
    const actual = createHash(algorithm).update(bytes).digest('base64')
    if (actual !== expected) throw new Error(`Tarball integrity mismatch: ${algorithm}-${actual}`)
  } else if (dist.shasum) {
    const actual = createHash('sha1').update(bytes).digest('hex')
    if (actual !== dist.shasum) throw new Error(`Tarball shasum mismatch: ${actual}`)
  } else {
    throw new Error('The registry returned no integrity or shasum for the tarball.')
  }
}

function getPath(value: unknown, path: string[]): unknown {
  let current = value
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`)
  return response.json()
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

await main()
