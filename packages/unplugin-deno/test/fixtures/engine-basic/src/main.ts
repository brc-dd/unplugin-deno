import { join } from '@std/path'
import kleur from 'kleur'
import { bold } from 'fmt-colors'
import { readFileSync } from 'node:fs'
import answer from 'data:text/javascript,export default 42'
import { twice } from './util.ts'

export const message: string = bold(kleur.green(join('a', String(twice(answer)))))
export const read: typeof readFileSync = readFileSync
