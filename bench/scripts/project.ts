/**
 * The benchmark project: `index.html`, `src/main.ts` and `FEATURES` feature modules that each
 * import three of eight JSR and npm packages by bare specifier. The same sources build in two
 * variants: `npm` resolves them from node_modules (bench/package.json installs the JSR packages
 * from npm.jsr.io), `deno` through the import map in project/deno.json with unplugin-deno.
 */
import { copyFileSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** How many feature modules the project has (plus `main.ts`). */
export const FEATURES = 50

const template = new URL('../project/', import.meta.url)
const benchNodeModules = fileURLToPath(new URL('../node_modules', import.meta.url))

/** One use of a package: its import and an expression over `input` (a string) and `n`. */
const uses: Array<{ imports: string; expression: (n: number) => string }> = [
  {
    imports: "import { toKebabCase } from '@std/text/to-kebab-case'",
    expression: () => 'toKebabCase(input)',
  },
  {
    imports: "import { format as formatBytes } from '@std/fmt/bytes'",
    expression: (n) => `formatBytes(input.length * ${n + 1})`,
  },
  {
    imports: "import { chunk } from '@std/collections/chunk'",
    expression: (n) => `String(chunk([...input], ${(n % 5) + 1}).length)`,
  },
  {
    imports: "import { encodeBase64 } from '@std/encoding/base64'",
    expression: () => 'encodeBase64(input)',
  },
  {
    imports: "import { join } from '@std/path/posix/join'",
    expression: (n) => `join('features', '${n}', input)`,
  },
  {
    imports: "import { marked } from 'marked'",
    expression: () => 'String(marked.parseInline(`*${input}*`))',
  },
  {
    imports: "import { nanoid } from 'nanoid'",
    expression: (n) => `nanoid(${(n % 10) + 5})`,
  },
  {
    imports: "import stringWidth from 'string-width'",
    expression: () => 'String(stringWidth(input))',
  },
]

function feature(n: number): string {
  const picked = [uses[n % 8]!, uses[(n + 3) % 8]!, uses[(n + 5) % 8]!]
  return [
    ...picked.map((use) => use.imports),
    '',
    `export function feature${n}(input: string): string {`,
    `  return [${picked.map((use) => use.expression(n)).join(', ')}].join(' ')`,
    '}',
    '',
  ].join('\n')
}

function main(): string {
  const names = Array.from({ length: FEATURES }, (_, n) => `feature${n}`)
  return [
    // The entry uses two packages itself, so its first request waits for dependency resolution.
    "import { toKebabCase } from '@std/text/to-kebab-case'",
    "import { marked } from 'marked'",
    ...names.map((name) => `import { ${name} } from './features/${name}.ts'`),
    '',
    `const features = [${names.join(', ')}]`,
    "const lines = features.map((feature) => feature('Hello, bench!'))",
    "document.querySelector('#app')!.innerHTML = String(marked.parse(toKebabCase(lines.join(' '))))",
    '',
  ].join('\n')
}

/**
 * Writes the project for `variant` to `dir` (replacing it): the `deno` variant gets deno.json and
 * deno.lock, the `npm` variant a node_modules link to bench/node_modules.
 */
export function writeProject(dir: string, variant: 'npm' | 'deno'): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  mkdirSync(join(dir, 'src', 'features'), { recursive: true })
  copyFileSync(new URL('index.html', template), join(dir, 'index.html'))
  if (variant === 'deno') {
    copyFileSync(new URL('deno.json', template), join(dir, 'deno.json'))
    copyFileSync(new URL('deno.lock', template), join(dir, 'deno.lock'))
  } else {
    symlinkSync(benchNodeModules, join(dir, 'node_modules'), 'junction')
  }
  writeFileSync(join(dir, 'src', 'main.ts'), main())
  for (let n = 0; n < FEATURES; n++) {
    writeFileSync(join(dir, 'src', 'features', `feature${n}.ts`), feature(n))
  }
}
