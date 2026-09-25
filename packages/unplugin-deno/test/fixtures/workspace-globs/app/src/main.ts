import { shared } from 'shared'
import { pkg, util } from '@fixture/jsr-pkg'
import { linked } from '@fixture/linked'
import { nodePkg } from 'node-pkg'

export const summary: string = [shared, pkg, util, linked, nodePkg].join(' ')
