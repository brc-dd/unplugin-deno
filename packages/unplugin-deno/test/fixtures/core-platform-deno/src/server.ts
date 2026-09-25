import kleur from 'npm:kleur@^4'
import { join } from '@std/path'
import { existsSync } from 'node:fs'
import { closestString } from 'https://deno.land/std@0.224.0/text/closest_string.ts'
import { answer } from './answer.ts'

export const values = {
  joined: join('a', 'b'),
  closest: closestString('hello', ['help', 'world']),
  answer,
  exists: typeof existsSync,
  bold: typeof kleur.bold,
}
