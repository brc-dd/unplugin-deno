// Writes src/add.wasm (72 bytes): run `node make-add-wasm.mjs` in this directory.
//
// (module
//   (import "./offset.js" "offset" (func $offset (result i32)))
//   (func (export "add") (param i32 i32) (result i32)
//     local.get 0 local.get 1 i32.add call $offset i32.add))
import { writeFileSync } from 'node:fs'

/** A string as a length-prefixed name. */
const name = (text) => [text.length, ...new TextEncoder().encode(text)]
/** A section: id, size (one LEB128 byte suffices here), body. */
const section = (id, body) => [id, body.length, ...body]

const bytes = Uint8Array.from([
  ...[0x00, 0x61, 0x73, 0x6d], // magic "\0asm"
  ...[0x01, 0x00, 0x00, 0x00], // version 1
  // type section: 2 types, () -> i32 and (i32, i32) -> i32
  ...section(1, [2, 0x60, 0, 1, 0x7f, 0x60, 2, 0x7f, 0x7f, 1, 0x7f]),
  // import section: "./offset.js" "offset", a function of type 0
  ...section(2, [1, ...name('./offset.js'), ...name('offset'), 0x00, 0]),
  // function section: 1 function of type 1
  ...section(3, [1, 1]),
  // export section: "add", function 1 (function 0 is the import)
  ...section(7, [1, ...name('add'), 0x00, 1]),
  // code section: 1 body of 10 bytes, no locals:
  // local.get 0, local.get 1, i32.add, call 0, i32.add, end
  ...section(10, [1, 10, 0, 0x20, 0, 0x20, 1, 0x6a, 0x10, 0, 0x6a, 0x0b]),
])

writeFileSync(new URL('src/add.wasm', import.meta.url), bytes)
