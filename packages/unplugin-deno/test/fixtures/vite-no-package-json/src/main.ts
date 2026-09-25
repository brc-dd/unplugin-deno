import kleur from 'kleur'
import ms from 'ms'
import stripAnsi from 'strip-ansi'

export const values = {
  green: typeof kleur.green,
  ms: ms('2d'),
  stripped: stripAnsi('\u001B[4mcake\u001B[0m'),
}
