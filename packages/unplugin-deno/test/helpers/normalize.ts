import { realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { normalizeDriveLetter, toFileUrl } from '../../src/utils/path.js'
import { testDenoDirPath } from './deno-dir.js'

/** Options of {@link normalize}. */
export interface NormalizeOptions {
  /** Extra absolute paths to replace, e.g. `[[project.root, '<root>']]`. */
  paths?: ReadonlyArray<readonly [path: string, placeholder: string]>
}

const packageDir = fileURLToPath(new URL('../../', import.meta.url))
const repoDir = fileURLToPath(new URL('../../../../', import.meta.url))

/** Machine-specific paths replaced by default, most specific first after sorting. */
function defaultPaths(): Array<readonly [string, string]> {
  return [
    [testDenoDirPath(), '<deno-dir>'],
    [packageDir, '<pkg>'],
    [repoDir, '<repo>'],
    [tmpdir(), '<tmp>'],
    [homedir(), '<home>'],
  ]
}

/**
 * Makes text stable across machines and operating systems, for snapshots:
 * - known absolute paths (test `DENO_DIR`, package, repository, temp and home directories, plus
 *   `options.paths`) become placeholders such as `<deno-dir>/npm/…` or `file:///<deno-dir>/npm/…`,
 *   with `/` separators after the placeholder;
 * - hex runs of 8+ characters (content hashes, mirror generations) become `<hash>`, and bundler
 *   chunk hashes (`chunk-Ab3dE9_x.js`) become `chunk-<hash>.js`;
 * - CRLF becomes LF.
 * Idempotent: normalizing normalized text changes nothing.
 */
export function normalize(text: string, options: NormalizeOptions = {}): string {
  let result = text.replaceAll('\r\n', '\n')
  const paths = [...(options.paths ?? []), ...defaultPaths()]
  const replacements = paths
    .flatMap(([path, placeholder]) =>
      variants(path).map((variant) => [variant, placeholder] as const),
    )
    .toSorted((a, b) => b[0].length - a[0].length)
  for (const [variant, placeholder] of replacements) {
    const isUrl = variant.startsWith('file:')
    result = result.replaceAll(variant, isUrl ? `file:///${placeholder}` : placeholder)
  }
  const placeholders = [...new Set(paths.map(([, placeholder]) => placeholder))]
  const tails = new RegExp(`(${placeholders.map(escapeRegExp).join('|')})([^\\s'"\`<>()]*)`, 'g')
  result = result.replace(
    tails,
    (_match, placeholder: string, tail: string) => `${placeholder}${tail.replaceAll('\\', '/')}`,
  )
  result = result.replace(/\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/g, '<hash>')
  result = result.replace(
    /-(?=[\w-]{0,7}[A-Z\d])[\w-]{8}(?=\.(?:m?js|cjs|css|map|wasm)\b)/g,
    '-<hash>',
  )
  return result
}

/** The spellings of an absolute path that may appear in output. */
function variants(path: string): string[] {
  const trimmed = path.replace(/[\\/]+$/, '')
  if (trimmed === '') return []
  const paths = new Set([trimmed])
  try {
    paths.add(realpathSync(trimmed))
  } catch {
    // the path does not exist (yet); only its literal spelling can appear
  }
  const result = new Set<string>()
  for (const candidate of paths) {
    const forms = [candidate, candidate.replaceAll('\\', '/')]
    if (/^[a-zA-Z]:/.test(candidate)) {
      forms.push(...forms.map((form) => form.charAt(0).toLowerCase() + form.slice(1)))
      forms.push(...forms.map(normalizeDriveLetter))
    }
    for (const form of forms) result.add(form)
    const url = toFileUrl(candidate)
    result.add(url)
    result.add(
      url.replace(
        /^file:\/\/\/([A-Z]):/,
        (_m, letter: string) => `file:///${letter.toLowerCase()}:`,
      ),
    )
  }
  return [...result]
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
