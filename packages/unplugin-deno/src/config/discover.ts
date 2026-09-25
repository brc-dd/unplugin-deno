import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse as parsePath, resolve, sep } from 'node:path'
import { glob } from 'tinyglobby'
import { DenoPluginError } from '../diagnostics/errors.js'
import { parseJson } from '../utils/fs.js'
import { isSubpath, toDirUrl, toFileUrl, toPath } from '../utils/path.js'
import type { DenoConfig } from './deno-config.js'
import {
  memberConfigWarnings,
  normalizeLinks,
  normalizeNodeModulesDir,
  normalizeWorkspace,
  parseDenoConfig,
  readError,
  resolveConfigPath,
} from './deno-config.js'
import type { PackageJson } from './package-json.js'
import { parsePackageJson } from './package-json.js'

/** Where an import map's entries come from (docs/architecture.md §3.1 step 5). */
export interface ImportMapSource {
  /** Keys and values are resolved against this URL (the deno.json or the external file). */
  baseUrl: string
  /** The raw `{ imports?, scopes? }` object. */
  value: unknown
  /** Path of the file holding the entries. */
  path: string
  /**
   * `true` for `imports`/`scopes` written in a deno.json: Deno expands their `jsr:`/`npm:`
   * package entries to subpaths. External `importMap` files follow the import-map standard.
   */
  inline: boolean
}

/** A `deno.json(c)` that was read. */
export interface DenoJsonFile {
  path: string
  url: string
  config: DenoConfig
  /** The config's import map (inline or external), or `null` when it has none. */
  importMap: ImportMapSource | null
}

/** A `package.json` that was read. */
export interface PackageJsonFile {
  path: string
  url: string
  json: PackageJson
}

/** A directory with a `deno.json(c)`, a `package.json`, or both (Deno's "config folder"). */
export interface ConfigFolder {
  /** Absolute path, as discovered (symlinks not resolved). */
  dir: string
  /** `file:` URL of {@link ConfigFolder.dir}, ending in `/`. */
  dirUrl: string
  /** {@link ConfigFolder.dir} with symlinks resolved; hosts usually report real paths. */
  realDir: string
  denoJson: DenoJsonFile | null
  packageJson: PackageJsonFile | null
}

/** A package added through `links` (or automatically, see {@link Discovery.links}). */
export interface LinkFolder extends ConfigFolder {
  /** The `links` entry it comes from, or `null` for an automatic link. */
  link: string | null
}

/** A problem Deno reports as a warning; the caller logs it. */
export interface ConfigWarning {
  message: string
  /** The file the warning is about. */
  file: string
}

/** The result of {@link discoverProject}. */
export interface Discovery {
  /** Absolute host root discovery started from. */
  root: string
  /** `true` when discovery was disabled (`config: false`). */
  disabled: boolean
  /** The `deno.json(c)` to hand to the engine (nearest config, or the workspace root's), if any. */
  configPath: string | null
  configUrl: string | null
  /** Workspace root directory (the root itself when no config was found). */
  workspaceRoot: string
  /** `file:` URL of {@link Discovery.workspaceRoot}, ending in `/`. */
  workspaceRootUrl: string
  /** The workspace root's config folder, or `null` when no config was found. */
  rootFolder: ConfigFolder | null
  /** Workspace members, excluding the root, sorted by directory. */
  members: ConfigFolder[]
  /**
   * Linked packages: `links` entries (with the other members of a linked workspace), then the
   * directories Deno links automatically because a path in an import map points into another
   * `deno.json` directory (Deno 2.8.3+, denoland/deno#34803).
   */
  links: LinkFolder[]
  /**
   * The `deno.json(c)`, `package.json` and external import map files of the workspace root,
   * members and links, sorted (`loadProject` adds the lockfile).
   */
  watchFiles: string[]
  warnings: ConfigWarning[]
}

/** Options of {@link discoverProject}. */
export interface DiscoverOptions {
  /**
   * Path of the `deno.json(c)` to use (absolute or relative to `root`), `false` to disable
   * config discovery, or `undefined` to discover it.
   */
  config?: string | false | undefined
  /** Read `package.json` files (default `true`; `false` matches `DENO_NO_PACKAGE_JSON=1`). */
  packageJson?: boolean | undefined
}

const CONFIG_FILE_NAMES = ['deno.json', 'deno.jsonc'] as const
const MEMBER_FILE_NAMES = ['deno.json', 'deno.jsonc', 'package.json'] as const
/** File system errors Deno skips while looking for config files (`is_skippable_io_error`). */
const SKIPPABLE_ERRORS: ReadonlySet<string> = new Set([
  'ENOENT',
  'ENOTDIR',
  'EISDIR',
  'EACCES',
  'EPERM',
  'EINVAL',
  'ENAMETOOLONG',
])

/**
 * Finds the Deno configuration for a host root (docs/architecture.md §3.1 steps 1–5), following
 * Deno 2.9's `discover_workspace_config_files`:
 *
 * 1. `config: false` → nothing is read.
 * 2. Walk up from `root` (never inside `node_modules`); in each directory `deno.json` wins over
 *    `deno.jsonc`, and a `package.json` makes a directory a config folder too. An explicit
 *    `config` path is used instead of the walk.
 * 3. The first ancestor folder that declares members (`workspace` in deno.json, `workspaces` in
 *    package.json) is the workspace root if its expanded members include the nearest folder;
 *    otherwise the nearest folder stands alone (with a warning for deno workspaces).
 * 4. `links` (or the deprecated `patch`) are expanded, including globs and linked workspaces.
 * 5. External `importMap` files are read (strict JSON, like Deno).
 *
 * @throws {DenoPluginError} `CONFIG_NOT_FOUND` for a missing explicit config, `CONFIG_INVALID`
 *   for invalid files or workspace definitions, `IMPORT_MAP_INVALID` for unreadable import maps.
 */
export async function discoverProject(
  root: string,
  options: DiscoverOptions = {},
): Promise<Discovery> {
  const absoluteRoot = resolve(root)
  const loader = new FolderLoader(options.packageJson ?? true)
  if (options.config === false) return emptyDiscovery(absoluteRoot, true)
  const found =
    typeof options.config === 'string'
      ? await discoverFromConfigFile(resolve(absoluteRoot, options.config), loader)
      : await discoverFromDirectory(absoluteRoot, loader)
  if (found === null) return emptyDiscovery(absoluteRoot, false)
  const { rootFolder, members, first } = found
  const links = await resolveLinks(rootFolder, members, loader)
  const all = [rootFolder, ...members, ...links]
  await Promise.all(all.map((folder) => loader.attachImportMap(folder)))
  const autoLinks = await resolveAutoLinks(all, loader)
  await Promise.all(autoLinks.map((folder) => loader.attachImportMap(folder)))
  collectWarnings(rootFolder, members, loader)
  const configFile = first.denoJson ?? rootFolder.denoJson
  const watchFiles = [first, ...all, ...autoLinks].flatMap((folder) => [
    ...(folder.denoJson === null ? [] : [folder.denoJson.path]),
    ...(folder.denoJson?.importMap?.inline === false ? [folder.denoJson.importMap.path] : []),
    ...(folder.packageJson === null ? [] : [folder.packageJson.path]),
  ])
  return {
    root: absoluteRoot,
    disabled: false,
    configPath: configFile?.path ?? null,
    configUrl: configFile?.url ?? null,
    workspaceRoot: rootFolder.dir,
    workspaceRootUrl: rootFolder.dirUrl,
    rootFolder,
    members,
    links: [...links, ...autoLinks],
    watchFiles: [...new Set(watchFiles)].toSorted(),
    warnings: loader.warnings,
  }
}

function emptyDiscovery(root: string, disabled: boolean): Discovery {
  return {
    root,
    disabled,
    configPath: null,
    configUrl: null,
    workspaceRoot: root,
    workspaceRootUrl: toDirUrl(root),
    rootFolder: null,
    members: [],
    links: [],
    watchFiles: [],
    warnings: [],
  }
}

interface FoundWorkspace {
  rootFolder: ConfigFolder
  members: ConfigFolder[]
  /** The folder nearest to the start (the explicit config's folder, or the first one found). */
  first: ConfigFolder
}

async function discoverFromConfigFile(path: string, loader: FolderLoader): Promise<FoundWorkspace> {
  const denoJson = await loader.readDenoJson(path, true)
  if (denoJson === null) throw new TypeError('unreachable: a required config was not read')
  const dir = dirname(path)
  const natural = await loader.load(dir)
  if (natural?.denoJson?.path === path) {
    if (hasMembers(natural)) return resolveWorkspace(natural, natural, new Map(), loader)
    return (await walkUp(dirname(dir), natural, loader)) ?? standalone(natural)
  }
  // Loading the directory would pick another file (e.g. `--config custom.json`): Deno uses the
  // file on its own, without an ancestor workspace or the directory's package.json.
  const folder = await loader.folder(dir, denoJson, null)
  if (hasMembers(folder)) return resolveWorkspace(folder, folder, new Map(), loader)
  return standalone(folder)
}

async function discoverFromDirectory(
  root: string,
  loader: FolderLoader,
): Promise<FoundWorkspace | null> {
  return walkUp(stripNodeModules(root), null, loader)
}

/** Deno never discovers configs inside `node_modules`: start above the first such component. */
function stripNodeModules(path: string): string {
  const { root } = parsePath(path)
  const parts = path.slice(root.length).split(sep)
  const index = parts.indexOf('node_modules')
  return index === -1 ? path : join(root, ...parts.slice(0, index))
}

async function walkUp(
  start: string,
  initial: ConfigFolder | null,
  loader: FolderLoader,
): Promise<FoundWorkspace | null> {
  let first = initial
  const found = new Map<string, ConfigFolder>()
  if (initial !== null) found.set(initial.dir, initial)
  for (let dir = start; ; dir = dirname(dir)) {
    const folder = await loader.load(dir)
    if (folder !== null) {
      if (hasMembers(folder)) return resolveWorkspace(folder, first ?? folder, found, loader)
      first ??= folder
      found.set(folder.dir, folder)
    }
    if (dirname(dir) === dir) break
  }
  return first === null ? null : standalone(first)
}

function standalone(folder: ConfigFolder): FoundWorkspace {
  return { rootFolder: folder, members: [], first: folder }
}

function hasMembers(folder: ConfigFolder): boolean {
  return (
    (folder.denoJson !== null && normalizeWorkspace(folder.denoJson.config) !== undefined) ||
    folder.packageJson?.json.workspaces !== undefined
  )
}

async function resolveWorkspace(
  rootFolder: ConfigFolder,
  first: ConfigFolder,
  found: Map<string, ConfigFolder>,
  loader: FolderLoader,
): Promise<FoundWorkspace> {
  const members = await resolveMembers(rootFolder, loader)
  const memberDirs = new Set(members.map((member) => member.dir))
  const isDenoWorkspace =
    rootFolder.denoJson !== null && normalizeWorkspace(rootFolder.denoJson.config) !== undefined
  if (first !== rootFolder && !memberDirs.has(first.dir)) {
    if (isDenoWorkspace) {
      loader.warn(
        configFileOf(first),
        `Config file ${configFileOf(first)} is not a member of the workspace at ${rootFolder.dir}; ignoring the parent workspace config.`,
      )
    }
    return standalone(first)
  }
  if (isDenoWorkspace) {
    for (const folder of found.values()) {
      if (folder !== rootFolder && !memberDirs.has(folder.dir)) {
        throw new DenoPluginError(
          'CONFIG_INVALID',
          `Config file ${configFileOf(folder)} is not a member of the workspace at ${rootFolder.dir}.`,
          { hint: `Add its directory to "workspace" in ${configFileOf(rootFolder)} or remove it.` },
        )
      }
    }
  }
  checkDuplicateNames([rootFolder, ...members])
  return { rootFolder, members, first }
}

function configFileOf(folder: ConfigFolder): string {
  return folder.denoJson?.path ?? folder.packageJson?.path ?? folder.dir
}

function checkDuplicateNames(folders: ConfigFolder[]): void {
  const seen = new Map<string, string>()
  for (const folder of folders) {
    const name = folder.denoJson?.config.name
    if (name === undefined || folder.denoJson === null) continue
    const other = seen.get(name)
    if (other !== undefined) {
      throw new DenoPluginError(
        'CONFIG_INVALID',
        `The package "${name}" in ${folder.denoJson.path} has the same name as the package in ${other}.`,
        { hint: 'Give each workspace member a unique "name".' },
      )
    }
    seen.set(name, folder.denoJson.path)
  }
}

/** Deno treats `*` and `?` as glob characters (not `[]` or `{}`), and `!x` as an exclusion. */
function isGlobEntry(entry: string): boolean {
  if (/^(?:https?:\/\/|file:\/\/|npm:|jsr:)/.test(entry)) return false
  return /[*?]/.test(entry) || entry.startsWith('!')
}

async function resolveMembers(
  rootFolder: ConfigFolder,
  loader: FolderLoader,
): Promise<ConfigFolder[]> {
  const members = new Map<string, ConfigFolder>()
  const denoMembers =
    rootFolder.denoJson === null ? undefined : normalizeWorkspace(rootFolder.denoJson.config)
  if (denoMembers !== undefined && rootFolder.denoJson !== null) {
    const vendor = rootFolder.denoJson.config.vendor === true ? ['vendor/**'] : []
    const entries = await expandEntries(rootFolder.dir, denoMembers, MEMBER_FILE_NAMES, vendor)
    const seen = new Set<string>()
    for (const { raw, dir } of entries) {
      const key = `${raw}\0${dir}`
      if (seen.has(key)) continue
      seen.add(key)
      if (dir === rootFolder.dir) {
        throw new DenoPluginError(
          'CONFIG_INVALID',
          `The workspace member "${raw}" in ${rootFolder.denoJson.path} refers to the workspace root itself.`,
          { hint: 'Remove it from "workspace".' },
        )
      }
      const folder = await loadMember(rootFolder, raw, dir, loader, false)
      if (folder === null) continue
      if (members.has(folder.dir)) {
        throw new DenoPluginError(
          'CONFIG_INVALID',
          `The workspace member ${folder.dir} is specified twice in ${rootFolder.denoJson.path}.`,
          { hint: 'Remove the duplicate entry from "workspace".' },
        )
      }
      members.set(folder.dir, folder)
    }
  }
  const npmMembers = rootFolder.packageJson?.json.workspaces
  if (npmMembers !== undefined) {
    const entries = await expandEntries(rootFolder.dir, npmMembers, ['package.json'], [])
    for (const { raw, dir } of entries) {
      if (dir === rootFolder.dir) continue
      const folder = await loadMember(rootFolder, raw, dir, loader, true)
      if (folder !== null) members.set(folder.dir, folder)
    }
  }
  return [...members.values()].toSorted((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0))
}

async function loadMember(
  rootFolder: ConfigFolder,
  raw: string,
  dir: string,
  loader: FolderLoader,
  requirePackageJson: boolean,
): Promise<ConfigFolder | null> {
  const rootFile = configFileOf(rootFolder)
  if (!isSubpath(rootFolder.dir, dir)) {
    throw new DenoPluginError(
      'CONFIG_INVALID',
      `The workspace member ${dir} in ${rootFile} is not inside the workspace directory ${rootFolder.dir}.`,
      {
        hint: 'Workspace members must be nested under the workspace root; use "links" for others.',
      },
    )
  }
  const folder = await loader.load(dir)
  if (folder === null || (requirePackageJson && folder.packageJson === null)) {
    if (!(await isDirectory(dir))) {
      loader.warn(rootFile, `Workspace member "${raw}" not found at ${dir}; skipping it.`)
      return null
    }
    throw new DenoPluginError(
      'CONFIG_INVALID',
      `The workspace member ${dir} in ${rootFile} has no ${requirePackageJson ? 'package.json' : 'deno.json, deno.jsonc or package.json'}.`,
      { hint: 'Add a config file to the member or remove it from the workspace.' },
    )
  }
  return folder
}

interface ExpandedEntry {
  /** The entry as written for paths, the matched directory for glob results (Deno's "raw member"). */
  raw: string
  /** The entry (path or glob) that produced the directory. */
  entry: string
  dir: string
}

/**
 * Expands workspace/link entries relative to `baseDir`: plain paths are resolved, glob entries
 * (and `!` exclusions) match directories that contain one of `fileNames` (Deno matches
 * `<entry>/deno.json` etc.), skipping `node_modules`, `.git` and dot directories.
 */
async function expandEntries(
  baseDir: string,
  entries: readonly string[],
  fileNames: readonly string[],
  extraIgnore: readonly string[],
): Promise<ExpandedEntry[]> {
  const result: ExpandedEntry[] = []
  const globs: Array<{ entry: string; patterns: string[] }> = []
  const ignore = ['**/node_modules/**', '**/.git/**', ...extraIgnore]
  for (const entry of entries) {
    if (!isGlobEntry(entry)) {
      result.push({ raw: entry, entry, dir: resolveEntryPath(baseDir, entry) })
      continue
    }
    const negated = entry.startsWith('!')
    const body = toGlobBody(baseDir, negated ? entry.slice(1) : entry)
    const patterns = fileNames.map((name) => (body === '' ? name : `${body}/${name}`))
    if (!negated) globs.push({ entry, patterns })
    else if (/[*?]/.test(body)) ignore.push(...patterns)
    else ignore.push(body === '' ? '**' : `${body}/**`)
  }
  const seen = new Set<string>()
  for (const { entry, patterns } of globs) {
    const files = await glob(patterns, {
      cwd: baseDir,
      ignore,
      absolute: false,
      expandDirectories: false,
      onlyFiles: true,
    })
    const dirs = [...new Set(files.map((file) => dirname(resolve(baseDir, file))))].toSorted()
    for (const dir of dirs) {
      if (seen.has(dir)) continue
      seen.add(dir)
      result.push({ raw: dir, entry, dir })
    }
  }
  return result
}

function resolveEntryPath(baseDir: string, entry: string): string {
  const path = entry.startsWith('file:')
    ? toPath(entry)
    : isAbsolute(entry)
      ? entry
      : resolve(baseDir, entry)
  return path.length > 1 && /[\\/]$/.test(path) && !/^[a-zA-Z]:[\\/]$/.test(path)
    ? path.slice(0, -1)
    : path
}

/**
 * A tinyglobby pattern for a Deno glob entry: `/`-separated, without a leading `./` or a trailing
 * `/`, with glob syntax Deno does not support (`()[]{}`) escaped. Absolute entries are made
 * relative to `baseDir` when possible.
 */
function toGlobBody(baseDir: string, entry: string): string {
  let body = entry.replaceAll('\\', '/')
  if (isAbsolute(entry)) {
    const base = baseDir.replaceAll('\\', '/')
    body = body.startsWith(`${base}/`) ? body.slice(base.length + 1) : body
  }
  body = body.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '')
  if (body === '.') body = ''
  return body.replace(/[()[\]{}|]|[!+@](?=\()/g, '\\$&')
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function resolveLinks(
  rootFolder: ConfigFolder,
  members: ConfigFolder[],
  loader: FolderLoader,
): Promise<LinkFolder[]> {
  if (rootFolder.denoJson === null) return []
  const { links, deprecatedPatch } = normalizeLinks(rootFolder.denoJson.config)
  if (deprecatedPatch)
    loader.warn(rootFolder.denoJson.path, '"patch" property was renamed to "links".')
  const taken = new Set([rootFolder.dir, ...members.map((member) => member.dir)])
  const result = new Map<string, LinkFolder>()
  const entries = await expandEntries(rootFolder.dir, links, MEMBER_FILE_NAMES, [])
  for (const { entry: raw, dir } of entries) {
    const folders = await linkedFolders(dir, loader)
    if (folders === null) {
      throw new DenoPluginError(
        'CONFIG_INVALID',
        `The link "${raw}" in ${rootFolder.denoJson.path} has no deno.json, deno.jsonc or package.json at ${dir}.`,
        { hint: 'Point "links" at a directory with a package config.' },
      )
    }
    for (const folder of folders) {
      if (folder.dir === rootFolder.dir) {
        throw new DenoPluginError(
          'CONFIG_INVALID',
          `The link "${raw}" in ${rootFolder.denoJson.path} points at this workspace or one of its members.`,
          { hint: 'Workspace members resolve without "links"; remove the entry.' },
        )
      }
      if (!taken.has(folder.dir) && !result.has(folder.dir)) {
        result.set(folder.dir, { ...folder, link: raw })
      }
    }
  }
  return [...result.values()]
}

/**
 * The folders a link to `dir` brings in (Deno's `resolve_link_member_config_folders`): a linked
 * workspace root brings all its members, and a linked workspace member brings its whole
 * workspace. Returns `null` when `dir` has no config.
 */
async function linkedFolders(dir: string, loader: FolderLoader): Promise<ConfigFolder[] | null> {
  const folder = await loader.load(dir)
  if (folder === null) return null
  if (hasMembers(folder)) return [folder, ...(await resolveMembers(folder, loader))]
  for (let ancestor = dirname(dir); ; ancestor = dirname(ancestor)) {
    const candidate = await loader.load(ancestor)
    if (candidate !== null && hasMembers(candidate)) {
      const members = await resolveMembers(candidate, loader).catch(() => null)
      if (members?.some((member) => member.dir === folder.dir)) return [candidate, ...members]
    }
    if (dirname(ancestor) === ancestor) break
  }
  return [folder]
}

/**
 * Deno 2.8.3+ links a directory automatically when a path value in an import map points into a
 * directory governed by another `deno.json` (denoland/deno#34803), so that directory's own import
 * map applies to its files. Repeats until no new directories are found.
 */
async function resolveAutoLinks(
  known: ConfigFolder[],
  loader: FolderLoader,
): Promise<LinkFolder[]> {
  const visited = new Set(known.map((folder) => folder.dir))
  const queue = [...known]
  const result: LinkFolder[] = []
  for (let folder = queue.shift(); folder !== undefined; folder = queue.shift()) {
    const source = folder.denoJson?.importMap
    if (source === undefined || source === null) continue
    for (const target of importMapPathTargets(source)) {
      const governing = await governingConfigDir(target, loader)
      if (governing === null || visited.has(governing)) continue
      const folders = await linkedFolders(governing, loader).catch(() => null)
      if (folders === null) {
        visited.add(governing)
        continue
      }
      for (const linked of folders) {
        if (visited.has(linked.dir)) continue
        visited.add(linked.dir)
        await loader.attachImportMap(linked)
        const link: LinkFolder = { ...linked, link: null }
        result.push(link)
        queue.push(link)
      }
    }
  }
  return result
}

/** Absolute paths of the `./`, `../`, `/` and `file:` values of an import map. */
function importMapPathTargets(source: ImportMapSource): string[] {
  const values: string[] = []
  const collect = (map: unknown): void => {
    if (typeof map !== 'object' || map === null) return
    for (const value of Object.values(map)) if (typeof value === 'string') values.push(value)
  }
  const { imports, scopes } = (source.value ?? {}) as { imports?: unknown; scopes?: unknown }
  collect(imports)
  if (typeof scopes === 'object' && scopes !== null)
    for (const scope of Object.values(scopes)) collect(scope)
  const targets: string[] = []
  for (const value of values) {
    if (!/^(?:\.{1,2}\/|\/|file:)/.test(value)) continue
    try {
      const url = new URL(value, source.baseUrl)
      if (url.protocol !== 'file:') continue
      targets.push(url.pathname.endsWith('/') ? resolve(toPath(url)) : dirname(toPath(url)))
    } catch {
      // not a valid path; the import map reports it
    }
  }
  return targets
}

/** The nearest directory at or above `dir` with a `deno.json(c)`. */
async function governingConfigDir(dir: string, loader: FolderLoader): Promise<string | null> {
  for (let current = dir; ; current = dirname(current)) {
    const folder = await loader.load(current)
    if (folder?.denoJson) return folder.dir
    if (dirname(current) === current) return null
  }
}

function collectWarnings(
  rootFolder: ConfigFolder,
  members: ConfigFolder[],
  loader: FolderLoader,
): void {
  const rootConfig = rootFolder.denoJson
  if (rootConfig !== null && typeof rootConfig.config.nodeModulesDir === 'boolean') {
    const mode = normalizeNodeModulesDir(rootConfig.config.nodeModulesDir)
    loader.warn(
      rootConfig.path,
      `"nodeModulesDir": ${String(rootConfig.config.nodeModulesDir)} is deprecated; use "nodeModulesDir": "${mode}" instead.`,
    )
  }
  for (const member of members) {
    if (member.denoJson === null) continue
    for (const message of memberConfigWarnings(member.denoJson.config)) {
      loader.warn(member.denoJson.path, message)
    }
  }
}

/** Reads config folders once per discovery and collects warnings. */
class FolderLoader {
  readonly warnings: ConfigWarning[] = []
  private readonly folders = new Map<string, Promise<ConfigFolder | null>>()
  private readonly packageJson: boolean

  constructor(packageJson: boolean) {
    this.packageJson = packageJson
  }

  warn(file: string, message: string): void {
    if (!this.warnings.some((warning) => warning.file === file && warning.message === message)) {
      this.warnings.push({ file, message })
    }
  }

  /** The config folder at `dir` (cached), or `null` when it has no config file. */
  load(dir: string): Promise<ConfigFolder | null> {
    const key = resolve(dir)
    let folder = this.folders.get(key)
    if (folder === undefined) {
      folder = this.loadUncached(key)
      this.folders.set(key, folder)
    }
    return folder
  }

  private async loadUncached(dir: string): Promise<ConfigFolder | null> {
    let denoJson: DenoJsonFile | null = null
    for (const name of CONFIG_FILE_NAMES) {
      denoJson = await this.readDenoJson(join(dir, name), false)
      if (denoJson !== null) break
    }
    const packageJson = this.packageJson
      ? await this.readPackageJson(join(dir, 'package.json'))
      : null
    if (denoJson === null && packageJson === null) return null
    return this.folder(dir, denoJson, packageJson)
  }

  async folder(
    dir: string,
    denoJson: DenoJsonFile | null,
    packageJson: PackageJsonFile | null,
  ): Promise<ConfigFolder> {
    const realDir = await realpath(dir).catch(() => dir)
    return { dir, dirUrl: toDirUrl(dir), realDir, denoJson, packageJson }
  }

  async readDenoJson(path: string, required: boolean): Promise<DenoJsonFile | null> {
    const text = await this.readText(path, required)
    if (text === null) return null
    const config = parseDenoConfig(text, path)
    return { path, url: toFileUrl(path), config, importMap: null }
  }

  private async readPackageJson(path: string): Promise<PackageJsonFile | null> {
    const text = await this.readText(path, false)
    if (text === null) return null
    return { path, url: toFileUrl(path), json: parsePackageJson(text, path) }
  }

  private async readText(path: string, required: boolean): Promise<string | null> {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      const code: unknown =
        typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
      if (!required && typeof code === 'string' && SKIPPABLE_ERRORS.has(code)) return null
      throw readError(path, error)
    }
  }

  /**
   * Sets `folder.denoJson.importMap`: the inline `imports`/`scopes`, or the external `importMap`
   * file (strict JSON, not expanded). Inline entries win over `importMap` (with a warning).
   */
  async attachImportMap(folder: ConfigFolder): Promise<void> {
    const denoJson = folder.denoJson
    if (denoJson === null || denoJson.importMap !== null) return
    const { imports, scopes, importMap } = denoJson.config
    if (imports !== undefined || scopes !== undefined) {
      if (importMap !== undefined) {
        this.warn(
          denoJson.path,
          '"importMap" field is ignored when "imports" or "scopes" are specified in the config file.',
        )
      }
      denoJson.importMap = {
        baseUrl: denoJson.url,
        value: {
          ...(imports === undefined ? {} : { imports }),
          ...(scopes === undefined ? {} : { scopes }),
        },
        path: denoJson.path,
        inline: true,
      }
      return
    }
    if (importMap === undefined) return
    denoJson.importMap = await this.readExternalImportMap(importMap, denoJson)
  }

  private async readExternalImportMap(
    value: string,
    denoJson: DenoJsonFile,
  ): Promise<ImportMapSource> {
    if (
      /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(value) &&
      !value.startsWith('file:') &&
      !/^[a-zA-Z]:[\\/]/.test(value)
    ) {
      throw new DenoPluginError(
        'CONFIG_INVALID',
        `The "importMap" of ${denoJson.path} must be a local file, got ${value}.`,
        { hint: 'Download the import map and reference it by path.' },
      )
    }
    const path = resolveConfigPath(dirname(denoJson.path), value)
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      throw new DenoPluginError(
        'IMPORT_MAP_INVALID',
        `Cannot read the import map ${path} referenced by ${denoJson.path}.`,
        { hint: 'Fix the "importMap" path.', cause: error },
      )
    }
    return {
      baseUrl: toFileUrl(path),
      value: parseJson(text, path, 'IMPORT_MAP_INVALID'),
      path,
      inline: false,
    }
  }
}
