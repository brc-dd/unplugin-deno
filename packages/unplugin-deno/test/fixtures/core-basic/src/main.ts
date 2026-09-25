import { join } from '@std/path'
import kleur from 'kleur'
import { closestString } from 'https://deno.land/std@0.224.0/text/closest_string.ts'
import answer from 'data:text/javascript,export default 42'
import { posix } from 'node:path'
import { twice } from './util.ts'
import { greet } from '@app/greet'
import message from './message.txt?raw'

export const values = {
  joined: join('a', 'b'),
  colored: kleur.red('x'),
  closest: closestString('hello', ['help', 'world']),
  answer: twice(answer),
  sep: posix.sep,
  greeting: greet('deno'),
  message,
}
