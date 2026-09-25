import { transform } from 'esbuild'
import type { Plugin } from 'rollup'

/** Transpiles local TypeScript for Rollup tests (Rollup has no TypeScript support of its own). */
export function rollupTypeScript(): Plugin {
  return {
    name: 'test-typescript',
    async transform(code, id) {
      const path = id.split('?')[0] ?? id
      if (id.startsWith('\0') || !/\.[cm]?tsx?$/.test(path)) return null
      const result = await transform(code, {
        loader: path.endsWith('x') ? 'tsx' : 'ts',
        format: 'esm',
        target: 'esnext',
        sourcemap: true,
        sourcefile: path,
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
