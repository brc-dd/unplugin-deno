import kleur from 'kleur'
import { green } from 'npm:kleur@^4/colors'
import { join } from '@std/path/posix'
import { basename } from 'jsr:@std/path@^1/basename'
import { closestString } from 'https://deno.land/std@0.224.0/text/closest_string.ts'
import { local } from '@app/local'
import unmapped from 'unmapped-package'

export const values = {
  bold: typeof kleur.bold,
  green: typeof green,
  joined: join('a', 'b'),
  base: basename('/x/y.ts'),
  closest: closestString('hello', ['help', 'world']),
  local,
  unmapped,
}
