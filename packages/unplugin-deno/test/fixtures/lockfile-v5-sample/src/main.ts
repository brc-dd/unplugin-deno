import { join } from '@std/path'
import { red } from 'colors'
import stripAnsi from 'strip-ansi'

export const message: string = stripAnsi(red(join('hello', 'world')))
