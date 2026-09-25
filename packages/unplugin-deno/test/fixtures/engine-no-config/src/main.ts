import { join } from 'jsr:@std/path@1.1.6'
import kleur from 'npm:kleur@4.1.5'

export const message: string = kleur.green(join('a', 'b'))
