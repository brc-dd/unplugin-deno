import { green } from 'npm:kleur@^4/colors'
import ms from 'ms'
import { chunk } from 'lodash-es'
import stripAnsi from 'strip-ansi'

export const values = {
  green: typeof green,
  ms: ms('2 days'),
  chunked: chunk([1, 2, 3, 4], 2),
  stripped: stripAnsi('\u001B[4mcake\u001B[0m'),
}
