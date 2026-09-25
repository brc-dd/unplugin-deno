import kleur from 'kleur'
import stubOnly from 'stub-only-pkg'

export const values = {
  stub: 'stub' in kleur,
  red: typeof kleur.red,
  stubOnly,
}
