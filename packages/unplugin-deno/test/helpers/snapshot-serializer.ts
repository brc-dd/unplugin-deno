import type { SnapshotSerializer } from 'vitest'
import { normalize } from './normalize.js'

/** Snapshot serializer that runs strings through {@link normalize}; registered in `setup.ts`. */
export const normalizingSerializer: SnapshotSerializer = {
  test: (value: unknown) => typeof value === 'string' && normalize(value) !== value,
  serialize: (value: string, config, indentation, depth, refs, printer) =>
    printer(normalize(value), config, indentation, depth, refs),
}
