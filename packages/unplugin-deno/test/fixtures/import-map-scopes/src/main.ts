import { config } from 'config'
import { button } from 'ui/button.ts'
import { admin } from './admin/page.ts'
import { legacy } from 'legacy'

export const page: string = [config, button, admin, legacy].join(' ')
