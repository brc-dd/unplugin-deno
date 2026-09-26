import kleur from 'kleur'
import BROWSER from 'esm-env/browser'

export const message: string = kleur.green(String(BROWSER))
