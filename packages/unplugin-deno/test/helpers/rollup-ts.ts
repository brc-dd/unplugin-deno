import { transform } from 'esbuild'
import type { Plugin } from 'rollup'

/**
 * Transpiles local TypeScript for Rollup tests (Rollup has no TypeScript support of its own). JSX
 * is preserved, like a TypeScript plugin with `"jsx": "preserve"`: Rollup's own `jsx` option
 * (which unplugin-deno sets from deno.json) compiles it.
 */
export function rollupTypeScript(): Plugin {
  return {
    name: 'test-typescript',
    async transform(code, id) {
      const path = id.split('?')[0] ?? id
      if (id.startsWith('\0') || !/\.[cm]?tsx?$/.test(path)) return null
      const tsx = path.endsWith('x')
      const result = await transform(code, {
        loader: tsx ? 'tsx' : 'ts',
        format: 'esm',
        target: 'esnext',
        sourcemap: true,
        sourcefile: path,
        ...(tsx ? { jsx: 'preserve' as const } : {}),
      })
      return { code: result.code, map: result.map }
    },
  }
}

/** Loads `.json` modules for Rollup tests (the job of `@rollup/plugin-json`). */
export function rollupJson(): Plugin {
  return {
    name: 'test-json',
    transform(code, id) {
      if (id.startsWith('\0') || !(id.split('?')[0] ?? id).endsWith('.json')) return null
      return { code: `export default ${JSON.stringify(JSON.parse(code))};\n`, map: null }
    },
  }
}
