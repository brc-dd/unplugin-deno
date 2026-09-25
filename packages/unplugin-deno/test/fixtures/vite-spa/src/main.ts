import { join } from '@std/path'
import { red } from 'npm:kleur@^4/colors'
import { closestString } from 'https://deno.land/std@0.224.0/text/closest_string.ts'
import answer from 'data:text/javascript,export default 42'
import icon from '@/icon.svg?raw'
import text from './message.txt' with { type: 'text' }
import bytes from './data.bin' with { type: 'bytes' }
import data from './data.json'

export const values = {
  joined: join('a', 'b'),
  red: typeof red,
  closest: closestString('hello', ['help', 'world']),
  answer,
  icon,
  text,
  bytes: [...bytes],
  data,
}
