import kleur from 'npm:kleur@^4'
import { join } from '@std/path/posix'
import { readFileSync } from 'fs'
import { closestString } from 'https://deno.land/std@0.224.0/text/closest_string.ts'

export const values = {
  joined: join('a', 'b'),
  closest: closestString('hello', ['help', 'world']),
  read: typeof readFileSync,
  bold: typeof kleur.bold,
}
