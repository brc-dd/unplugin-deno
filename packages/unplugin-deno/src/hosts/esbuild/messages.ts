/**
 * Errors and warnings in esbuild's message format (docs/architecture.md §5.8, §6.4). esbuild
 * shows the plugin name and, for messages returned from `onResolve`, the location of the import;
 * the `DenoPluginError` itself is kept in `detail` so tools can read its `code`.
 *
 * @module
 */
import type { PartialMessage } from 'esbuild'
import { isDenoPluginError } from '../../diagnostics/errors.js'
import type { HostLogTarget } from '../shared.js'

/**
 * The esbuild message for an error: `<message> (<code>)` with the hint as a note for a
 * `DenoPluginError`, the message alone otherwise.
 */
export function toMessage(error: unknown): PartialMessage {
  if (isDenoPluginError(error)) {
    return {
      text: `${error.message} (${error.code})`,
      notes: error.hint === undefined ? [] : [{ text: `hint: ${error.hint}` }],
      detail: error,
    }
  }
  return { text: error instanceof Error ? error.message : String(error), detail: error }
}

/**
 * The log target of the esbuild adapter: warnings (and logged errors) are kept until the next
 * `onStart` or `onEnd` returns them to esbuild, which prints them with the build's other warnings
 * and lists them in the build result. esbuild has no channel for informational plugin output, so
 * the target has no `info`: debug lines (`debug: true`) go to stderr.
 */
export class WarningBuffer implements HostLogTarget {
  #messages: PartialMessage[] = []

  /** Records a warning. */
  warn = (message: string): void => {
    this.#messages.push({ text: message })
  }

  /** Returns the recorded warnings and forgets them. */
  drain(): PartialMessage[] {
    const messages = this.#messages
    this.#messages = []
    return messages
  }
}
