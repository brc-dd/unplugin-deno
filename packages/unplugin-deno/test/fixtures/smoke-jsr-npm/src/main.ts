import { join } from '@std/path'
import kleur from 'kleur'

export const greeting: string = kleur.green(join('hello', 'world'))
