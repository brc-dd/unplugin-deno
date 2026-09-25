import { describe, expect, it } from 'vitest'
import { EMPTY_MODULE_ID } from '../../core/id.js'
import { displayPath, virtualDisplayPath } from './paths.js'

describe('displayPath', () => {
  it('makes marker ids relative to the root (POSIX)', () => {
    expect(displayPath('/p', '/p/src/data.txt?deno-type=text', 'posix')).toBe(
      'src/data.txt?deno-type=text',
    )
    expect(displayPath('/p', '/p/a.txt?raw&deno-type=bytes', 'posix')).toBe(
      'a.txt?raw&deno-type=bytes',
    )
    expect(displayPath('/p/app', '/cache/deno/npm/x/readme.md?deno-type=text', 'posix')).toBe(
      '../../cache/deno/npm/x/readme.md?deno-type=text',
    )
  })

  it('makes marker ids relative to the root with / separators (Windows)', () => {
    expect(displayPath('C:\\p', 'C:\\p\\src\\style.css?deno-type=css', 'win32')).toBe(
      'src/style.css?deno-type=css',
    )
    expect(displayPath('c:\\p\\app', 'C:\\p\\data.txt?deno-type=text', 'win32')).toBe(
      '../data.txt?deno-type=text',
    )
    // Another drive has no relative path.
    expect(displayPath('C:\\p', 'D:\\x\\data.bin?deno-type=bytes', 'win32')).toBe(
      'D:/x/data.bin?deno-type=bytes',
    )
  })
})

describe('virtualDisplayPath', () => {
  it('drops the \\0 prefix of the plugin virtual ids', () => {
    expect(virtualDisplayPath(EMPTY_MODULE_ID)).toBe('empty')
    expect(virtualDisplayPath('other')).toBe('other')
  })
})
