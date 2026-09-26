import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { denoDir } from '../../../test/helpers/deno-dir.js'
import { tempDir } from '../../../test/helpers/temp-dir.js'
import type { JsxTransform } from '../../core/jsx.js'
import type { Options } from '../../core/options.js'
import { PluginState } from '../../core/state.js'
import type { HostLogTarget } from '../shared.js'
import { applyJsxToRules, configureJsx, describeJsx, jsxHint, jsxLoaderOf } from './jsx.js'

const AUTOMATIC: JsxTransform = { runtime: 'automatic', importSource: 'preact', development: false }
const DEVELOPMENT: JsxTransform = {
  runtime: 'automatic',
  importSource: 'preact',
  development: true,
}
const CLASSIC: JsxTransform = { runtime: 'classic', factory: 'h', fragment: 'Fragment' }

const ESBUILD_LOADER =
  '/root/node_modules/.pnpm/esbuild-loader@4.5.0/node_modules/esbuild-loader/dist/index.cjs'

describe('jsxLoaderOf', () => {
  it('recognises esbuild-loader and the SWC loaders by name or path', () => {
    expect(jsxLoaderOf('esbuild-loader')).toBe('esbuild-loader')
    expect(jsxLoaderOf(ESBUILD_LOADER)).toBe('esbuild-loader')
    expect(jsxLoaderOf('C:\\app\\node_modules\\esbuild-loader\\dist\\index.cjs')).toBe(
      'esbuild-loader',
    )
    expect(jsxLoaderOf('builtin:swc-loader')).toBe('builtin:swc-loader')
    expect(jsxLoaderOf('swc-loader')).toBe('swc-loader')
    expect(jsxLoaderOf('/root/node_modules/swc-loader/src/index.js')).toBe('swc-loader')
    expect(jsxLoaderOf('esbuild-loader?{"jsx":"automatic"}')).toBe('esbuild-loader')
    for (const other of [
      'babel-loader',
      'ts-loader',
      'builtin:lightningcss-loader',
      'my-esbuild-loader',
    ]) {
      expect(jsxLoaderOf(other)).toBeUndefined()
    }
  })
})

describe('applyJsxToRules', () => {
  it('sets esbuild-loader options of every rule shape, copying what it changes', () => {
    const shared = { test: /\.tsx?$/, loader: 'esbuild-loader', options: { target: 'esnext' } }
    const useObject = { loader: ESBUILD_LOADER, options: { target: 'es2022' } }
    const rules: unknown[] = [
      shared,
      { test: /\.jsx$/, use: 'esbuild-loader' },
      { test: /\.mts$/, use: useObject },
      { test: /\.cts$/, use: ['babel-loader', { loader: 'esbuild-loader' }] },
      {
        oneOf: [
          { resourceQuery: /raw/, type: 'asset/source' },
          { rules: [{ loader: 'esbuild-loader' }] },
        ],
      },
      '...',
      false,
    ]
    const report = applyJsxToRules(rules, AUTOMATIC)
    expect(report).toEqual({ applied: ['esbuild-loader'], configured: [] })
    const jsx = { jsx: 'automatic', jsxImportSource: 'preact' }
    expect(rules[0]).toEqual({ ...shared, options: { target: 'esnext', ...jsx } })
    expect(rules[1]).toEqual({ test: /\.jsx$/, use: { loader: 'esbuild-loader', options: jsx } })
    expect(rules[2]).toEqual({
      test: /\.mts$/,
      use: { ...useObject, options: { target: 'es2022', ...jsx } },
    })
    expect(rules[3]).toEqual({
      test: /\.cts$/,
      use: ['babel-loader', { loader: 'esbuild-loader', options: jsx }],
    })
    expect(rules[4]).toEqual({
      oneOf: [
        { resourceQuery: /raw/, type: 'asset/source' },
        { rules: [{ loader: 'esbuild-loader', options: jsx }] },
      ],
    })
    expect(rules.slice(5)).toEqual(['...', false])
    // The original objects are unchanged (configs share rule objects).
    expect(shared.options).toEqual({ target: 'esnext' })
    expect(useObject.options).toEqual({ target: 'es2022' })
  })

  it('maps the development and classic runtimes to esbuild options', () => {
    const development: unknown[] = [{ loader: 'esbuild-loader' }]
    applyJsxToRules(development, DEVELOPMENT)
    expect(development[0]).toEqual({
      loader: 'esbuild-loader',
      options: { jsx: 'automatic', jsxImportSource: 'preact', jsxDev: true },
    })
    const classic: unknown[] = [{ loader: 'esbuild-loader' }]
    applyJsxToRules(classic, CLASSIC)
    expect(classic[0]).toEqual({
      loader: 'esbuild-loader',
      options: { jsx: 'transform', jsxFactory: 'h', jsxFragment: 'Fragment' },
    })
  })

  it('sets jsc.transform.react of builtin:swc-loader and swc-loader, keeping other settings', () => {
    const options = {
      jsc: {
        parser: { syntax: 'typescript', tsx: true },
        transform: { decoratorVersion: '2022-03', react: { refresh: true } },
      },
      env: { targets: 'chrome 100' },
    }
    const rules: unknown[] = [
      { test: /\.tsx$/, loader: 'builtin:swc-loader', options },
      { test: /\.jsx$/, use: [{ loader: '/root/node_modules/swc-loader/src/index.js' }] },
    ]
    expect(applyJsxToRules(rules, DEVELOPMENT)).toEqual({
      applied: ['builtin:swc-loader', 'swc-loader'],
      configured: [],
    })
    expect(rules[0]).toEqual({
      test: /\.tsx$/,
      loader: 'builtin:swc-loader',
      options: {
        jsc: {
          parser: { syntax: 'typescript', tsx: true },
          transform: {
            decoratorVersion: '2022-03',
            react: {
              refresh: true,
              runtime: 'automatic',
              importSource: 'preact',
              development: true,
            },
          },
        },
        env: { targets: 'chrome 100' },
      },
    })
    expect(rules[1]).toEqual({
      test: /\.jsx$/,
      use: [
        {
          loader: '/root/node_modules/swc-loader/src/index.js',
          options: {
            jsc: {
              transform: {
                react: { runtime: 'automatic', importSource: 'preact', development: true },
              },
            },
          },
        },
      ],
    })
    expect(options.jsc.transform.react).toEqual({ refresh: true })
    const classic: unknown[] = [{ loader: 'builtin:swc-loader' }]
    applyJsxToRules(classic, CLASSIC)
    expect(classic[0]).toEqual({
      loader: 'builtin:swc-loader',
      options: {
        jsc: { transform: { react: { runtime: 'classic', pragma: 'h', pragmaFrag: 'Fragment' } } },
      },
    })
  })

  it('leaves loaders that configure JSX themselves, and loaders it cannot read', () => {
    const rules: unknown[] = [
      { loader: 'esbuild-loader', options: { jsxFactory: 'h' } },
      {
        loader: 'esbuild-loader',
        options: { tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } } },
      },
      {
        loader: 'esbuild-loader',
        options: { tsconfigRaw: '{"compilerOptions":{"jsxImportSource":"x"}}' },
      },
      {
        loader: 'builtin:swc-loader',
        options: { jsc: { transform: { react: { runtime: 'automatic' } } } },
      },
      { loader: 'swc-loader', options: { jsc: { transform: { react: { pragma: 'h' } } } } },
      { loader: 'esbuild-loader?{"jsx":"automatic"}' },
      { loader: 'esbuild-loader', options: 'jsx=automatic' },
      { use: () => [{ loader: 'esbuild-loader' }] },
      { loader: 'babel-loader', options: { presets: [] } },
    ]
    const before = JSON.stringify(rules)
    const originals = [...rules]
    expect(applyJsxToRules(rules, AUTOMATIC)).toEqual({
      applied: [],
      configured: ['esbuild-loader', 'builtin:swc-loader', 'swc-loader'],
    })
    expect(JSON.stringify(rules)).toBe(before)
    expect(rules.every((rule, index) => rule === originals[index])).toBe(true)
  })
})

describe('messages', () => {
  it('describes the transform and the options to set', () => {
    expect(describeJsx(AUTOMATIC)).toBe('the automatic runtime with importSource `preact`')
    expect(describeJsx(DEVELOPMENT)).toBe(
      'the automatic runtime in development mode with importSource `preact`',
    )
    expect(describeJsx(CLASSIC)).toBe(
      'the classic runtime with factory `h` and fragment `Fragment`',
    )
    expect(jsxHint(AUTOMATIC)).toBe(
      'esbuild-loader `{ jsx: "automatic", jsxImportSource: "preact" }`, swc-loader `jsc.transform.react: { runtime: "automatic", importSource: "preact" }`',
    )
    expect(jsxHint(CLASSIC)).toBe(
      'esbuild-loader `{ jsx: "transform", jsxFactory: "h", jsxFragment: "Fragment" }`, swc-loader `jsc.transform.react: { runtime: "classic", pragma: "h", pragmaFrag: "Fragment" }`',
    )
  })
})

/** A loaded plugin state for a project with `config` as its deno.json, logging into `logs`. */
async function loadedState(
  config: object,
  options: Options = {},
): Promise<{ state: PluginState; logs: string[] }> {
  vi.stubEnv('DENO_DIR', await denoDir())
  const dir = await tempDir({ 'deno.json': config })
  onTestFinished(() => dir.dispose())
  const state = new PluginState({ cwd: dir.root, debug: true, ...options }, 'webpack')
  onTestFinished(() => state.close())
  const logs: string[] = []
  const target: HostLogTarget = {
    warn: (message) => logs.push(`warn ${message}`),
    info: (message) => logs.push(`info ${message}`),
  }
  state.setLogTarget(target)
  await state.prepare()
  logs.length = 0
  return { state, logs }
}

const PREACT = { compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'preact' } }

describe('configureJsx', () => {
  it('applies the deno.json settings and says so at debug level', async () => {
    const { state, logs } = await loadedState(PREACT)
    const rules: unknown[] = [{ loader: 'esbuild-loader' }]
    expect(configureJsx(state, rules, 'webpack')).toEqual({
      applied: ['esbuild-loader'],
      configured: [],
    })
    expect(logs).toEqual([
      'info [webpack] deno.json JSX settings (the automatic runtime with importSource `preact`) applied to esbuild-loader',
    ])
  })

  it('says what to set when it finds no JSX loader', async () => {
    const { state, logs } = await loadedState(PREACT)
    expect(configureJsx(state, [{ loader: 'babel-loader' }], 'webpack')).toEqual({
      applied: [],
      configured: [],
    })
    expect(logs).toEqual([
      expect.stringMatching(
        /^info \[webpack\] deno\.json configures JSX \(the automatic runtime with importSource `preact`\), but module\.rules has no esbuild-loader or swc-loader rule .* webpack's experiments\.typescript does not compile JSX\.$/,
      ),
    ])
    logs.length = 0
    configureJsx(state, [], 'rspack')
    expect(logs[0]).not.toContain('experiments.typescript')
  })

  it('warns once for jsx: "precompile", compiled with the automatic runtime', async () => {
    const { state, logs } = await loadedState({
      compilerOptions: { jsx: 'precompile', jsxImportSource: 'preact' },
    })
    configureJsx(state, [{ loader: 'builtin:swc-loader' }], 'rspack')
    configureJsx(state, [{ loader: 'builtin:swc-loader' }], 'rspack')
    expect(logs.filter((line) => line.startsWith('warn '))).toEqual([
      expect.stringContaining("is not supported by SWC's JSX transform"),
    ])
  })

  it('does nothing without JSX settings or with jsx: host', async () => {
    const plain = await loadedState({})
    const rules: unknown[] = [{ loader: 'esbuild-loader' }]
    expect(configureJsx(plain.state, rules, 'webpack')).toBeNull()
    const host = await loadedState(PREACT, { jsx: 'host' })
    expect(configureJsx(host.state, rules, 'webpack')).toBeNull()
    expect(rules).toEqual([{ loader: 'esbuild-loader' }])
    expect([...plain.logs, ...host.logs]).toEqual([])
  })
})
