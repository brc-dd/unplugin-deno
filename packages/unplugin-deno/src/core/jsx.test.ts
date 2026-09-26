import { describe, expect, it } from 'vitest'
import type { DenoConfig } from '../config/project.js'
import { jsxSettings } from '../config/deno-config.js'
import { jsxDecision, jsxTransformFor, precompileWarning } from './jsx.js'

function project(config: DenoConfig | null, workspaceConfig: DenoConfig | null = null) {
  return {
    disabled: false,
    config,
    workspaceConfig,
    jsx: jsxSettings({
      compilerOptions: { ...workspaceConfig?.compilerOptions, ...config?.compilerOptions },
    }),
  }
}

describe('jsxTransformFor', () => {
  it('maps react-jsx to the automatic runtime with the import source as a specifier', () => {
    const decision = jsxTransformFor(
      project({ compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'preact' } }),
      { jsx: 'auto' },
    )
    expect(decision).toEqual({
      transform: { runtime: 'automatic', importSource: 'preact', development: false },
      precompile: false,
    })
    expect(
      jsxTransformFor(project({ compilerOptions: { jsx: 'react-jsx' } }), { jsx: 'auto' })
        ?.transform,
    ).toEqual({ runtime: 'automatic', importSource: 'react', development: false })
  })

  it('maps react-jsxdev to the development runtime and react to the classic one', () => {
    expect(
      jsxTransformFor(
        project({ compilerOptions: { jsx: 'react-jsxdev', jsxImportSource: 'npm:preact@10' } }),
        { jsx: 'auto' },
      )?.transform,
    ).toEqual({ runtime: 'automatic', importSource: 'npm:preact@10', development: true })
    expect(
      jsxTransformFor(
        project({
          compilerOptions: { jsx: 'react', jsxFactory: 'h', jsxFragmentFactory: 'Fragment' },
        }),
        { jsx: 'auto' },
      )?.transform,
    ).toEqual({ runtime: 'classic', factory: 'h', fragment: 'Fragment' })
    // Deno's defaults for the classic runtime.
    expect(
      jsxTransformFor(project({ compilerOptions: { jsxFactory: 'h' } }), { jsx: 'auto' })
        ?.transform,
    ).toEqual({ runtime: 'classic', factory: 'h', fragment: 'React.Fragment' })
  })

  it('falls back from precompile to the automatic runtime', () => {
    expect(
      jsxTransformFor(
        project({ compilerOptions: { jsx: 'precompile', jsxImportSource: 'preact' } }),
        { jsx: 'auto' },
      ),
    ).toEqual({
      transform: { runtime: 'automatic', importSource: 'preact', development: false },
      precompile: true,
    })
    expect(precompileWarning('Rolldown', 'preact')).toContain('`preact/jsx-runtime`')
  })

  it('reads a member config over the workspace root', () => {
    const decision = jsxTransformFor(
      project(
        { compilerOptions: { jsxImportSource: 'preact' } },
        { compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'react' } },
      ),
      { jsx: 'auto' },
    )
    expect(decision?.transform).toMatchObject({ runtime: 'automatic', importSource: 'preact' })
  })

  it('leaves the host alone without JSX settings, with jsx: host, preserve and disabled projects', () => {
    expect(jsxTransformFor(project({ imports: {} }), { jsx: 'auto' })).toBeNull()
    expect(jsxTransformFor(project(null), { jsx: 'auto' })).toBeNull()
    const configured = project({ compilerOptions: { jsx: 'react-jsx' } })
    expect(jsxTransformFor(configured, { jsx: 'host' })).toBeNull()
    expect(jsxTransformFor({ ...configured, disabled: true }, { jsx: 'auto' })).toBeNull()
    expect(jsxTransformFor(configured, { jsx: 'deno' })).not.toBeNull()
    for (const jsx of ['preserve', 'react-native'] as const) {
      expect(jsxTransformFor(project({ compilerOptions: { jsx } }), { jsx: 'auto' })).toBeNull()
      expect(jsxDecision(jsxSettings({ compilerOptions: { jsx } }))).toBeNull()
    }
  })
})
