import { format as formatDuration } from '@std/fmt/duration'
import { Marked } from 'marked'
import { toKebabCase } from 'https://deno.land/std@0.224.0/text/case.ts'

/** Reading speed for the reading-time estimate. */
const WORDS_PER_MINUTE = 200

const marked = new Marked({
  renderer: {
    // Headings get an id, so they can be linked to.
    heading({ tokens, depth }) {
      const text = this.parser.parseInline(tokens)
      return `<h${depth} id="${toKebabCase(text)}">${text}</h${depth}>\n`
    },
  },
})

/** A rendered Markdown document. */
export interface Preview {
  html: string
  readingTime: string
}

/** Renders Markdown to HTML and estimates how long it takes to read. */
export function preview(markdown: string): Preview {
  const words = markdown.split(/\s+/).filter((word) => word !== '').length
  const seconds = Math.ceil((words / WORDS_PER_MINUTE) * 60)
  return {
    html: marked.parse(markdown, { async: false }),
    readingTime: formatDuration(seconds * 1000, { ignoreZero: true }) || '0s',
  }
}

// In a browser, preview the editor's text as it is typed.
if (typeof document !== 'undefined') {
  const editor = document.querySelector<HTMLTextAreaElement>('#editor')!
  const output = document.querySelector<HTMLElement>('#preview')!
  const readingTime = document.querySelector<HTMLElement>('#reading-time')!
  const render = (): void => {
    const result = preview(editor.value)
    output.innerHTML = result.html
    readingTime.textContent = result.readingTime
  }
  editor.addEventListener('input', render)
  render()
}
