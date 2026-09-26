/**
 * Wasm module imports (docs/architecture.md §5.12, plan L6): `import { add } from "./add.wasm"`
 * (no attribute) instantiates the module and exposes its exports, as in Deno (and `deno bundle`).
 * The plugin loads `.wasm` modules as JavaScript it synthesises: the bytes inlined as base64
 * (decoded with `atob`, so no `Uint8Array.fromBase64` is needed), a synchronous
 * `new WebAssembly.Module`/`new WebAssembly.Instance`, one namespace import per module the Wasm
 * imports from (read with `WebAssembly.Module.imports` at build time; relative names resolve
 * against the `.wasm` file, like Deno), and one export per instance export
 * (`WebAssembly.Module.exports`). Browsers limit synchronous compilation on the main thread to
 * small modules (4 KB in Chromium); workers and server runtimes have no such limit.
 *
 * @module
 */
import { Buffer } from 'node:buffer'
import { posix, win32 } from 'node:path'
import { DenoPluginError } from '../diagnostics/errors.js'
import type { PathFlavor } from '../utils/path.js'
import { HOST_PATH_FLAVOR } from '../utils/path.js'
import type { MarkerModule } from './attributes.js'
import { splitQuery } from './id.js'

/** Ids of Wasm modules the plugin loads: `.wasm` files without a query (`?init`, `?url` are the host's). */
export const WASM_MODULE_ID_FILTER: RegExp = /\.wasm$/i

/** Whether `id` is a Wasm module import the plugin loads (see {@link WASM_MODULE_ID_FILTER}). */
export function isWasmModuleId(id: string): boolean {
  return !id.startsWith('\0') && splitQuery(id).query === '' && WASM_MODULE_ID_FILTER.test(id)
}

/**
 * The part of the `WebAssembly` global the plugin uses (Node.js, Deno and Bun have it; the
 * TypeScript libraries the package builds with do not declare it).
 */
interface WebAssemblyApi {
  Module: {
    new (bytes: Uint8Array): object
    imports(module: object): Array<{ module: string; name: string; kind: string }>
    exports(module: object): Array<{ name: string; kind: string }>
  }
}

function webAssembly(): WebAssemblyApi | undefined {
  return (globalThis as { WebAssembly?: WebAssemblyApi }).WebAssembly
}

/** Identifier names the synthesised module can export as they are. */
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

/** Reserved words that cannot be `export const` names. */
const RESERVED: ReadonlySet<string> = new Set(
  (
    'await break case catch class const continue debugger default delete do else enum export ' +
    'extends false finally for function if implements import in instanceof interface let new ' +
    'null package private protected public return static super switch this throw true try ' +
    'typeof var void while with yield'
  ).split(' '),
)

/**
 * The JavaScript module of the Wasm module at `path` (see the module documentation). Import
 * module names starting with `./` or `../` become absolute paths (hosts resolve them like any
 * import, also from virtual ids); other names (`env`, `npm:x`) are imported as written.
 *
 * @throws {DenoPluginError} `UNSUPPORTED_MEDIA_TYPE` when the bytes are not a valid Wasm module.
 */
export function synthesizeWasmModule(
  bytes: Uint8Array,
  path: string,
  flavor: PathFlavor = HOST_PATH_FLAVOR,
): MarkerModule {
  const Module = webAssembly()?.Module
  let module: object
  try {
    if (Module === undefined) throw new Error('WebAssembly is not available in this runtime.')
    module = new Module(bytes)
  } catch (error) {
    throw new DenoPluginError('UNSUPPORTED_MEDIA_TYPE', `${path} is not a valid Wasm module.`, {
      hint: 'Import other binary files with `with { type: "bytes" }`.',
      specifier: path,
      cause: error,
    })
  }
  const syntax = flavor === 'win32' ? win32 : posix
  const lines: string[] = []
  const importNames = [...new Set(Module.imports(module).map((entry) => entry.module))]
  importNames.forEach((name, index) => {
    const relative = /^\.{1,2}\//.test(name)
    const target = relative ? syntax.resolve(syntax.dirname(path), name) : name
    const specifier = flavor === 'win32' && relative ? target.replaceAll('\\', '/') : target
    lines.push(`import * as __wasm_import_${index} from ${JSON.stringify(specifier)};`)
  })
  const base64 = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
  lines.push(
    `const __wasm_data = atob(${JSON.stringify(base64)});`,
    'const __wasm_bytes = new Uint8Array(__wasm_data.length);',
    'for (let i = 0; i < __wasm_data.length; i++) __wasm_bytes[i] = __wasm_data.charCodeAt(i);',
    'const __wasm_module = new WebAssembly.Module(__wasm_bytes);',
    `const __wasm_instance = new WebAssembly.Instance(__wasm_module, {${importNames
      .map((name, index) => ` ${JSON.stringify(name)}: __wasm_import_${index}`)
      .join(',')}${importNames.length > 0 ? ' ' : ''}});`,
  )
  Module.exports(module).forEach(({ name }, index) => {
    const value = `__wasm_instance.exports[${JSON.stringify(name)}]`
    if (IDENTIFIER.test(name) && !RESERVED.has(name)) {
      lines.push(`export const ${name} = ${value};`)
    } else {
      lines.push(
        `const __wasm_export_${index} = ${value};`,
        `export { __wasm_export_${index} as ${JSON.stringify(name)} };`,
      )
    }
  })
  return { code: `${lines.join('\n')}\n`, moduleType: 'js' }
}
