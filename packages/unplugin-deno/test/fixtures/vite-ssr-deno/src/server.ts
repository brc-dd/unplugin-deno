import kleur from 'npm:kleur@^4'
import { join } from '@std/path/posix'
import { existsSync } from 'node:fs'
import { answer } from './answer.ts'

export const values = {
  joined: join('a', 'b'),
  answer,
  exists: typeof existsSync,
  bold: typeof kleur.bold,
}
