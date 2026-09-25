import { join } from '@std/path'
import logoUrl from '../assets/logo.png'
import aliasUrl from 'logo'
import bytes from './data.bin' with { type: 'bytes' }
import jsonText from 'data-json' with { type: 'text' }
import json from 'data-json' with { type: 'json' }
import './style.css'

export const values = {
  joined: join('a', 'b'),
  logoUrl,
  aliasUrl,
  bytes: [...bytes],
  jsonText,
  json,
}
