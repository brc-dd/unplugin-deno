import { describe, expect, it } from 'vitest'
import { isWasmModuleId, synthesizeWasmModule } from './wasm.js'

/** The magic number (`\0asm`) and version 1. */
const WASM_HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]

/** A string as a length-prefixed Wasm name. */
function name(text: string): number[] {
  return [text.length, ...new TextEncoder().encode(text)]
}

/** A Wasm section: id, size, body. */
function section(id: number, body: number[]): number[] {
  return [id, body.length, ...body]
}

/**
 * `(module (import "<from>" "offset" (func (result i32)))
 *   (func (export "add") (param i32 i32) (result i32) local.get 0 local.get 1 i32.add call 0 i32.add))`
 * plus the exports named in `extra` (each the same function).
 */
function addModule(from: string, extra: string[] = []): Uint8Array {
  return Uint8Array.from([
    ...WASM_HEADER,
    ...section(1, [2, 0x60, 0, 1, 0x7f, 0x60, 2, 0x7f, 0x7f, 1, 0x7f]),
    ...section(2, [1, ...name(from), ...name('offset'), 0x00, 0]),
    ...section(3, [1, 1]),
    ...section(7, [
      1 + extra.length,
      ...name('add'),
      0x00,
      1,
      ...extra.flatMap((item) => [...name(item), 0x00, 1]),
    ]),
    ...section(10, [1, 10, 0, 0x20, 0, 0x20, 1, 0x6a, 0x10, 0, 0x6a, 0x0b]),
  ])
}

/** Evaluates a synthesised module with its imports replaced by `modules`. */
async function evaluate(
  code: string,
  modules: Record<string, object>,
): Promise<Record<string, unknown>> {
  const imports = new Map<string, object>()
  const body = code.replace(
    /^import \* as (\w+) from ("[^"]*");$/gm,
    (_line, local: string, specifier: string) => {
      imports.set(local, modules[JSON.parse(specifier) as string] ?? {})
      return ''
    },
  )
  const exported: string[] = []
  const withoutExports = body
    .replace(/^export const (\w+) = /gm, (_match, local: string) => {
      exported.push(`${JSON.stringify(local)}: ${local}`)
      return `const ${local} = `
    })
    .replace(/^export \{ (\w+) as ("[^"]*") \};$/gm, (_match, local: string, alias: string) => {
      exported.push(`${alias}: ${local}`)
      return ''
    })
  const run = new Function(
    ...imports.keys(),
    `${withoutExports}\nreturn { ${exported.join(', ')} }`,
  )
  return run(...imports.values()) as Record<string, unknown>
}

describe('synthesizeWasmModule', () => {
  it('instantiates the module with its imports and exports its exports', async () => {
    const module = synthesizeWasmModule(addModule('./offset.js'), '/app/src/add.wasm', 'posix')
    expect(module.moduleType).toBe('js')
    expect(module.code).toContain('import * as __wasm_import_0 from "/app/src/offset.js";')
    expect(module.code).toContain('new WebAssembly.Module(__wasm_bytes)')
    expect(module.code).toContain('{ "./offset.js": __wasm_import_0 }')
    expect(module.code).toContain('export const add = __wasm_instance.exports["add"];')
    expect(module.code).not.toContain('fromBase64')
    const exports = await evaluate(module.code, { '/app/src/offset.js': { offset: () => 100 } })
    expect((exports.add as (a: number, b: number) => number)(1, 2)).toBe(103)
  })

  it('keeps bare import names and uses / on Windows for relative ones', () => {
    expect(synthesizeWasmModule(addModule('env'), '/app/add.wasm', 'posix').code).toContain(
      'import * as __wasm_import_0 from "env";',
    )
    expect(
      synthesizeWasmModule(addModule('../lib/offset.js'), 'C:\\app\\src\\add.wasm', 'win32').code,
    ).toContain('from "C:/app/lib/offset.js";')
  })

  it('exports names that are not identifiers, and default, under string names', async () => {
    const code = synthesizeWasmModule(
      addModule('./offset.js', ['default', 'my-add', 'class']),
      '/a.wasm',
      'posix',
    ).code
    expect(code).toContain('export { __wasm_export_1 as "default" };')
    expect(code).toContain('export { __wasm_export_2 as "my-add" };')
    expect(code).toContain('export { __wasm_export_3 as "class" };')
    const exports = await evaluate(code, { '/offset.js': { offset: () => 0 } })
    expect(Object.keys(exports).toSorted()).toEqual(['add', 'class', 'default', 'my-add'])
  })

  it('rejects bytes that are not Wasm', () => {
    expect(() => synthesizeWasmModule(Uint8Array.of(1, 2, 3), '/a.wasm', 'posix')).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_MEDIA_TYPE' }),
    )
  })
})

describe('isWasmModuleId', () => {
  it('matches .wasm files without a query', () => {
    expect(isWasmModuleId('/app/add.wasm')).toBe(true)
    expect(isWasmModuleId('C:\\app\\ADD.WASM')).toBe(true)
    expect(isWasmModuleId('/app/add.wasm?init')).toBe(false)
    expect(isWasmModuleId('/app/add.wasm?deno-type=bytes')).toBe(false)
    expect(isWasmModuleId('\0virtual.wasm')).toBe(false)
    expect(isWasmModuleId('/app/add.wasm.js')).toBe(false)
  })
})
