import { extname } from '@std/path'
// An import-map subpath: Deno 2.9.7 cannot map it on this route ("could not be URL-parsed").
import { join } from '@std/path/posix/join'
import { basename } from 'jsr:@std/path@^1/posix/basename'

export const values = {
  ext: extname('/x/y.txt'),
  joined: join('c', 'd'),
  base: basename('/x/y.txt'),
}
