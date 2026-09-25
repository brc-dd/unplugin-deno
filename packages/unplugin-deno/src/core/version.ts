import packageJson from '../../package.json' with { type: 'json' }

/** The version of unplugin-deno; part of the mirror generation (docs/architecture.md §5.3). */
export const PLUGIN_VERSION: string = packageJson.version
