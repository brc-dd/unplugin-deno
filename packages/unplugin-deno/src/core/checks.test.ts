import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  denoGlobalsMessage,
  displayModule,
  foreignNodeModulesMessage,
  nativeAddonMessage,
  nodeBuiltinMessage,
  PackageVersions,
} from './checks.js'

describe('messages', () => {
  it('shows files relative to the root and URLs as they are', () => {
    const root = join('/', 'app')
    expect(displayModule(join(root, 'src', 'main.ts'), root)).toBe('src/main.ts')
    expect(displayModule('https://jsr.io/@std/fs/1.0.0/mod.ts', root)).toBe(
      'https://jsr.io/@std/fs/1.0.0/mod.ts',
    )
  })

  it('names the import chain of a node: builtin and the file of a native addon', () => {
    expect(nodeBuiltinMessage('src/main.ts', 'node:fs')).toContain('src/main.ts → node:fs')
    expect(nativeAddonMessage('npm:sharp@0.33', '/x/sharp.node')).toContain('/x/sharp.node')
  })

  it('points at the first Deno reference and lists the members once', () => {
    const code = 'const a = 1\nconst b = Deno.cwd() + Deno.cwd()\nDeno.exit()'
    const at = (text: string, from = 0): number => code.indexOf(text, from)
    const references = [
      { start: at('Deno'), end: at('Deno') + 8, member: 'cwd' },
      { start: at('Deno', at('Deno') + 1), end: 0, member: 'cwd' },
      { start: at('Deno.exit'), end: 0, member: 'exit' },
    ]
    const message = denoGlobalsMessage('src/main.ts', code, references)
    expect(message).toMatch(/^src\/main\.ts:2:11 uses `Deno\.cwd`, `Deno\.exit`, /)
    expect(message).toContain("denoGlobals: 'off'")
    const many = ['a', 'b', 'c', 'd', 'e'].map((member) => ({ start: 0, end: 0, member }))
    expect(denoGlobalsMessage('x.ts', 'x', many)).toContain('`Deno.c`, 2 more')
  })

  it('warns about a foreign node_modules only when Deno manages it', () => {
    const info = {
      mode: 'auto' as const,
      explicit: true,
      dir: '/app/node_modules',
      layout: 'pnpm' as const,
      hasJsrDeps: false,
      foreignManager: 'pnpm' as const,
    }
    expect(foreignNodeModulesMessage(info)).toMatch(
      /^\/app\/node_modules was installed by pnpm, but deno\.json sets "nodeModulesDir": "auto"/,
    )
    expect(foreignNodeModulesMessage({ ...info, mode: 'manual' })).toBeUndefined()
    expect(foreignNodeModulesMessage({ ...info, foreignManager: null })).toBeUndefined()
  })
})

describe('PackageVersions', () => {
  it('reports names bundled in several versions per platform, once', () => {
    const packages = new PackageVersions()
    packages.record('browser', 'kleur', '4.1.5')
    packages.record('browser', 'kleur', '3.0.3')
    packages.record('browser', 'kleur', '4.1.5')
    packages.record('browser', 'preact', '10.27.2')
    packages.record('deno', 'kleur', '4.1.5')
    packages.record('deno', 'kleur', '')
    expect(packages.take('deno')).toEqual([])
    const [message, ...rest] = packages.take()
    expect(rest).toEqual([])
    expect(message).toContain('kleur is bundled in 2 versions (3.0.3, 4.1.5) for the browser')
    expect(packages.take()).toEqual([])
  })
})
