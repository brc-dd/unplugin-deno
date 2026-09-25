/**
 * `unplugin-deno/register`: a Node.js module hook (`node --import unplugin-deno/register`) that
 * will let `vite.config.ts`, scripts and tests import `jsr:`/`npm:` specifiers and import-map
 * aliases under Node.js. Planned for a later release (docs/plan.md, E1); importing it currently
 * throws.
 *
 * @module
 */
import { DenoPluginError } from './diagnostics/errors.js'

throw new DenoPluginError(
  'ENGINE_UNAVAILABLE',
  '`unplugin-deno/register` is not implemented in this version.',
  {
    hint: 'It is planned for a later release (docs/plan.md, E1). Run the tool under Deno meanwhile.',
  },
)
