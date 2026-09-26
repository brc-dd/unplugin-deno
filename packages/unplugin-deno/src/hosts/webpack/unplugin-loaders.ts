/**
 * The file paths of unplugin's `load` and `transform` loaders for webpack and Rspack
 * (`unplugin/<host>/loaders/{load,transform}`), which the adapters put into `module.rules`. They
 * are located with `require.resolve` from this module, lazily: a `createRequire(import.meta.url)`
 * at module load would throw when the package runs from a URL (Deno loading it from JSR), and
 * that would break every host entry that shares this chunk, not only webpack and Rspack.
 *
 * @module
 */
import { createRequire } from 'node:module'
import { DenoPluginError } from '../../diagnostics/errors.js'

type LoaderHost = 'webpack' | 'rspack'
type LoaderKind = 'load' | 'transform'

const resolved = new Map<string, string>()
let requireFromHere: NodeJS.Require | undefined

/**
 * The absolute path of unplugin's `kind` loader for `host`, cached per process.
 *
 * @throws {DenoPluginError} `ENGINE_UNAVAILABLE` when this module does not run from a file (the
 *   webpack and Rspack adapters need the npm installation of `unplugin-deno`, whose `unplugin`
 *   dependency provides the loader files).
 */
export function unpluginLoaderPath(host: LoaderHost, kind: LoaderKind): string {
  const key = `${host}/${kind}`
  let path = resolved.get(key)
  if (path === undefined) {
    if (!import.meta.url.startsWith('file:')) {
      throw new DenoPluginError(
        'ENGINE_UNAVAILABLE',
        `The ${host} adapter of unplugin-deno needs unplugin's loader files on disk, but the plugin runs from ${import.meta.url}.`,
        {
          hint: 'Install unplugin-deno from npm (`npm install unplugin-deno`) for webpack, Rspack and Rsbuild; the JSR package works with Vite, Rolldown, Rollup and esbuild.',
        },
      )
    }
    requireFromHere ??= createRequire(import.meta.url)
    path = requireFromHere.resolve(`unplugin/${host}/loaders/${kind}`)
    resolved.set(key, path)
  }
  return path
}
