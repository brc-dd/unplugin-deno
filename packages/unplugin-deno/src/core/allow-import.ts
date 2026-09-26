/**
 * The remote-import allow-list (docs/architecture.md §5.2, plan R15): Deno's `--allow-import`
 * for the `https:`/`http:` modules the plugin downloads. The `allowImport` option gives the hosts
 * (Deno's defaults unless set); the hosts of the remote modules `deno.lock` records, of the URLs
 * the import maps name and of the JSR registry are always allowed, because the project already
 * depends on them. Checked before anything is downloaded: the resolver checks the URLs it is
 * asked for, the mirror the imports of remote modules, and both the final URLs of redirects.
 *
 * Entry syntax (as Deno 2.9.7 matches it): `host` (any port), `host:port`, `*.domain` (the domain
 * and its subdomains), IPv4 addresses, bracketed IPv6 addresses (`[::1]:8000`), `*` (everything).
 * Host names compare case-insensitively (IDNs as punycode); a URL without a port has its scheme's
 * default port (`https:` 443, `http:` 80), so Deno's defaults (`deno.land:443`, …) allow HTTPS only.
 *
 * @module
 */
import type { Project } from '../config/project.js'
import { DenoPluginError } from '../diagnostics/errors.js'

/** One parsed `allowImport` entry. */
export interface AllowImportRule {
  /** Lower-case host name (punycode), IP address or bracketed IPv6 address; for a wildcard the domain. */
  host: string
  /** `*.domain`: the domain and every subdomain. */
  wildcard: boolean
  /** Only this port; `undefined` for any port. */
  port: number | undefined
}

/** The default JSR registry (Deno's, unless `JSR_URL` names another). */
export const DEFAULT_JSR_REGISTRY = 'https://jsr.io/'

/**
 * The JSR registry URL: `JSR_URL` when set (with a trailing slash), else `https://jsr.io/`. The
 * vendored loader always uses `https://jsr.io/`; the `deno` engine follows `JSR_URL`.
 */
export function jsrRegistryUrl(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const value = env.JSR_URL
  if (value === undefined || value === '') return DEFAULT_JSR_REGISTRY
  const url = URL.parse(value)
  if (url === null || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    return DEFAULT_JSR_REGISTRY
  }
  return url.href.endsWith('/') ? url.href : `${url.href}/`
}

/**
 * Parses an `allowImport` entry; `'all'` for `*`, `undefined` for an entry that is not a host
 * (`resolveOptions` rejects those).
 */
export function parseAllowImportEntry(entry: string): AllowImportRule | 'all' | undefined {
  if (entry === '*') return 'all'
  const wildcard = entry.startsWith('*.')
  const rest = wildcard ? entry.slice(2) : entry
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/.exec(rest)
  if (match === null) return undefined
  const [, rawHost = '', rawPort] = match
  const url = URL.parse(`http://${rawHost}/`)
  if (url === null || url.hostname === '') return undefined
  const port = rawPort === undefined ? undefined : Number(rawPort)
  if (port !== undefined && port > 65_535) return undefined
  return { host: url.hostname, wildcard, port }
}

/** The port a URL connects to: its own, or the default of `https:` (443) and `http:` (80). */
export function effectivePort(url: URL): number | undefined {
  if (url.port !== '') return Number(url.port)
  if (url.protocol === 'https:') return 443
  if (url.protocol === 'http:') return 80
  return undefined
}

/** `host` or `host:port` as Deno prints it (`deno.land:443`). */
export function hostLabel(url: URL): string {
  const port = effectivePort(url)
  return port === undefined ? url.hostname : `${url.hostname}:${port}`
}

function matches(rule: AllowImportRule, url: URL): boolean {
  if (rule.port !== undefined && rule.port !== effectivePort(url)) return false
  const host = url.hostname
  if (!rule.wildcard) return host === rule.host
  return host === rule.host || host.endsWith(`.${rule.host}`)
}

/** Where the always-allowed hosts come from. */
export interface AllowImportSources {
  /** The `allowImport` option (validated). */
  allowImport: readonly string[]
  /** Remote URLs the project already depends on: `deno.lock` and the import maps. */
  projectUrls?: readonly string[]
  /**
   * The JSR registries (`https://jsr.io/`, which the vendored loader always uses, and
   * {@link jsrRegistryUrl}): `jsr:` packages are not remote imports the option is about.
   */
  jsrRegistries?: readonly string[]
}

/** Where a checked URL came from, for the error message. */
export interface AllowImportContext {
  /** The module that imports it. */
  importer?: string | undefined
  /** The URL that redirected to it. */
  redirectedFrom?: string | undefined
}

/** The allow-list of one build; see the module documentation. */
export interface ImportAllowList {
  /** Whether every host is allowed (`allowImport: ['*']`). */
  readonly allowsAll: boolean
  /** Whether the remote URL `url` may be downloaded (non-`http(s):` URLs always may). */
  allows(url: string): boolean
  /**
   * Throws `DISALLOWED_HOST` unless {@link ImportAllowList.allows} `url`.
   *
   * @throws {DenoPluginError} `DISALLOWED_HOST`.
   */
  check(url: string, context?: AllowImportContext): void
  /** A one-line description for the debug summary. */
  describe(): string
}

/** Creates the allow-list of a build from the option and the project's URLs. */
export function createImportAllowList(sources: AllowImportSources): ImportAllowList {
  const configured: AllowImportRule[] = []
  let allowsAll = false
  for (const entry of sources.allowImport) {
    const rule = parseAllowImportEntry(entry)
    if (rule === 'all') allowsAll = true
    else if (rule !== undefined) configured.push(rule)
  }
  const derived: AllowImportRule[] = []
  const derivedLabels = new Set<string>()
  const addUrl = (value: string): void => {
    const url = URL.parse(value)
    if (url === null || (url.protocol !== 'https:' && url.protocol !== 'http:')) return
    const label = hostLabel(url)
    if (derivedLabels.has(label)) return
    derivedLabels.add(label)
    derived.push({ host: url.hostname, wildcard: false, port: effectivePort(url) })
  }
  for (const url of sources.projectUrls ?? []) addUrl(url)
  for (const url of sources.jsrRegistries ?? [DEFAULT_JSR_REGISTRY]) addUrl(url)
  const rules = [...configured, ...derived]

  const allows = (value: string): boolean => {
    if (allowsAll) return true
    const url = URL.parse(value)
    if (url === null || (url.protocol !== 'https:' && url.protocol !== 'http:')) return true
    return rules.some((rule) => matches(rule, url))
  }

  return {
    allowsAll,
    allows,
    check(value, context = {}) {
      if (allows(value)) return
      const url = new URL(value)
      const label = hostLabel(url)
      const suggestion =
        effectivePort(url) === (url.protocol === 'https:' ? 443 : 80) ? url.hostname : label
      const redirect =
        context.redirectedFrom === undefined ? '' : ` (redirected from ${context.redirectedFrom})`
      throw new DenoPluginError(
        'DISALLOWED_HOST',
        `Importing ${value}${redirect} is not allowed: ${label} is not in \`allowImport\`.`,
        {
          hint: `Add "${suggestion}" to allowImport (\`allowImport: [...DEFAULT_ALLOW_IMPORT, '${suggestion}']\`, or \`['*']\` for every host); Deno needs \`--allow-import=${suggestion}\` to run it too.`,
          specifier: value,
          importer: context.importer,
        },
      )
    },
    describe() {
      if (allowsAll) return 'allowImport: every host'
      const configuredText = sources.allowImport.join(', ') || 'none'
      const derivedText = [...derivedLabels].join(', ')
      return `allowImport: ${configuredText}; from deno.lock, the import maps and the JSR registry: ${derivedText}`
    },
  }
}

/**
 * The remote URLs a project already depends on: the `remote` entries and `redirects` of
 * `deno.lock`, and the `http(s):` targets of every import map (root, members, links, scopes).
 */
export function projectRemoteUrls(project: Pick<Project, 'lockfile' | 'importMap'>): string[] {
  const urls = new Set<string>()
  const lockfile = project.lockfile
  if (lockfile !== null) {
    for (const url of Object.keys(lockfile.remote)) urls.add(url)
    for (const [from, to] of Object.entries(lockfile.redirects)) {
      urls.add(from)
      urls.add(to)
    }
  }
  const { map } = project.importMap
  for (const specifierMap of [map.imports, ...map.scopes.map((scope) => scope.map)]) {
    for (const entry of specifierMap.entries) {
      if (entry.address !== null && /^https?:/.test(entry.address)) urls.add(entry.address)
    }
  }
  return [...urls].toSorted()
}
