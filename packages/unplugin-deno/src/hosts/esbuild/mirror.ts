/**
 * Mirror files in esbuild (docs/architecture.md §5.10, §6.4). esbuild loads mirror files itself
 * (`file` namespace, reading their linked source maps) and has no transform hook, so the plugin
 * loads only the mirror files that contain `import.meta.main` (and are not entry points): it
 * replaces it with `false` (L7) and inlines the mirror's source map composed with that edit.
 *
 * @module
 */
import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SourceMapInput } from '@jridgewell/remapping'
import remapping from '@jridgewell/remapping'
import type { OnLoadResult } from 'esbuild'
import { MagicString } from 'magic-string'
import { stripSourceMappingComment } from '../../core/mirror.js'
import { applySourceTransforms, scanTokens } from '../../core/source.js'

/**
 * The esbuild `onLoad` result for the mirror file at `path` with `import.meta.main` replaced by
 * `false`, or `undefined` when it has none (esbuild then loads the file itself).
 */
export async function loadMirrorModule(path: string): Promise<OnLoadResult | undefined> {
  let code: string
  try {
    code = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  if (!code.includes('import.meta.main')) return undefined
  const source = stripSourceMappingComment(code)
  const scan = scanTokens(source)
  if (scan.importMetaMain.length === 0) return undefined
  const magic = new MagicString(source)
  applySourceTransforms(magic, scan, { importMetaMain: true })
  let contents = magic.toString()
  const mirrorMap = await readFile(`${path}.map`, 'utf8').then(
    (text) => JSON.parse(text) as SourceMapInput,
    () => null,
  )
  if (mirrorMap !== null) {
    const edit = magic.generateMap({ source: path, hires: 'boundary', includeContent: false })
    const map = remapping([{ ...edit, version: 3 } as SourceMapInput, mirrorMap], () => null)
    const encoded = Buffer.from(JSON.stringify(map)).toString('base64')
    contents += `\n//# sourceMappingURL=data:application/json;base64,${encoded}\n`
  }
  return { contents, loader: 'js', resolveDir: dirname(path) }
}
