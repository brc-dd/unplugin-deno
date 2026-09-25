import { expect } from 'vitest'
import { normalizingSerializer } from './snapshot-serializer.js'

expect.addSnapshotSerializer(normalizingSerializer)
