import * as path from 'node:path'
import { nanoid } from 'nanoid'
import { nanoid as nanoidV3 } from 'nanoid-v3'

export const values = {
  // Only the namespace: Vite replaces builtins with a stub that throws on property access.
  path: typeof path,
  v5: nanoid().length,
  v3: nanoidV3().length,
}
