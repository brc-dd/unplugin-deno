import { join } from '@std/path/posix'

self.onmessage = (event: MessageEvent<string[]>) => {
  self.postMessage(join(...event.data))
}
