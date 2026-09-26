import { greet } from 'jsr:@fixture/greet@^1'
import { shout } from '@fixture/shout'
import { loud } from 'jsr:@fixture/shout@0.3/loud'

export const message: string = loud(shout(greet('links')))
