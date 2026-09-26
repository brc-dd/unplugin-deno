import { describe, expect, it } from 'vitest'
import { SCHEME, SyntheticModules, syntheticPath } from './synthetic.js'

describe('syntheticPath', () => {
  it('names a marker by its file relative to the context, with the query', () => {
    expect(syntheticPath('/root', '/root/src/data.txt?deno-type=text', 'posix')).toBe(
      'src/data.txt?deno-type=text',
    )
    expect(syntheticPath('/root', '/root/src/a.txt?raw&deno-type=bytes', 'posix')).toBe(
      'src/a.txt?raw&deno-type=bytes',
    )
    expect(syntheticPath('/root/app', '/cache/deno/npm/x/a.css?deno-type=css', 'posix')).toBe(
      '../../cache/deno/npm/x/a.css?deno-type=css',
    )
  })

  it('uses / separators on Windows', () => {
    expect(syntheticPath('C:\\root', 'C:\\root\\src\\data.txt?deno-type=text', 'win32')).toBe(
      'src/data.txt?deno-type=text',
    )
    expect(syntheticPath('C:\\root', 'D:\\other\\x.bin?deno-type=bytes', 'win32')).toBe(
      'D:/other/x.bin?deno-type=bytes',
    )
  })

  it("names the plugin's virtual ids", () => {
    expect(syntheticPath('/root', '\0deno:empty', 'posix')).toBe('virtual/empty')
  })
})

describe('SyntheticModules', () => {
  it('gives each id a scheme request and maps the resource back to the id', () => {
    const modules = new SyntheticModules('/root', 'posix')
    const request = modules.request('/root/src/data.txt?deno-type=text')
    expect(request).toBe(`${SCHEME}:src/data.txt?deno-type=text`)
    expect(modules.idOf(request)).toBe('/root/src/data.txt?deno-type=text')
    expect(modules.idOf(`${SCHEME}:src/other.txt?deno-type=text`)).toBeUndefined()
  })
})
