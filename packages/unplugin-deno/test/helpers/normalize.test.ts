import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { toFileUrl } from '../../src/utils/path.js'
import { testDenoDirPath } from './deno-dir.js'
import { normalize } from './normalize.js'

describe('normalize', () => {
  it('replaces the test DENO_DIR in paths and file URLs', () => {
    const dir = testDenoDirPath()
    const file = join(dir, 'npm', 'registry.npmjs.org', 'kleur', '4.1.5', 'index.mjs')
    expect(normalize(file)).toBe('<deno-dir>/npm/registry.npmjs.org/kleur/4.1.5/index.mjs')
    expect(normalize(toFileUrl(file))).toBe(
      'file:///<deno-dir>/npm/registry.npmjs.org/kleur/4.1.5/index.mjs',
    )
  })

  it('replaces extra paths before the defaults and fixes separators after them', () => {
    const root = join(tmpdir(), 'unplugin-deno-project-x')
    const text = `error in ${join(root, 'src', 'main.ts')}:3:1`
    expect(normalize(text, { paths: [[root, '<root>']] })).toBe('error in <root>/src/main.ts:3:1')
    expect(normalize(join(tmpdir(), 'other'))).toBe('<tmp>/other')
  })

  it('replaces content and chunk hashes', () => {
    expect(normalize('node_modules/.unplugin-deno/3fa9c21b/https/jsr.io/x.js')).toBe(
      'node_modules/.unplugin-deno/<hash>/https/jsr.io/x.js',
    )
    expect(
      normalize('integrity e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'),
    ).toBe('integrity <hash>')
    expect(normalize('assets/index-BbN2x4f0.js assets/style-a1B2c3D4.css')).toBe(
      'assets/index-<hash>.js assets/style-<hash>.css',
    )
  })

  it('keeps look-alikes', () => {
    const text =
      'const n = 12345678; const s = "deadbeef"; import "./foo-bar-bazz.js"; <div>\\n</div>'
    expect(normalize(text)).toBe(text)
  })

  it('converts CRLF to LF', () => {
    expect(normalize('a\r\nb\r\n')).toBe('a\nb\n')
  })

  it('is idempotent', () => {
    const text = `${toFileUrl(join(testDenoDirPath(), 'remote'))}\r\nchunk-Xy12_abc.js 0123456789abcdef`
    expect(normalize(normalize(text))).toBe(normalize(text))
  })
})
