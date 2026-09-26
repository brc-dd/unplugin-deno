import { escape } from '@std/html/entities'
import logo from '@/logo.svg?raw'
import { closestTopic, postPath, topics } from './post.ts'

const app = document.querySelector<HTMLElement>('#app')!
app.innerHTML = `
  <h1>${logo} Slugger</h1>
  <label>Title <input name="title" value="Deno modules in a Vite app" /></label>
  <label>Topic <input name="topic" value="bundlr" list="topics" /></label>
  <datalist id="topics">${topics.map((topic) => `<option value="${escape(topic)}">`).join('')}</datalist>
  <output></output>
`

const title = app.querySelector<HTMLInputElement>('[name=title]')!
const topic = app.querySelector<HTMLInputElement>('[name=topic]')!
const output = app.querySelector<HTMLOutputElement>('output')!

function render(): void {
  const path = escape(postPath(title.value))
  output.innerHTML = `<code>${path}</code> filed under <strong>${escape(closestTopic(topic.value))}</strong>`
}

title.addEventListener('input', render)
topic.addEventListener('input', render)
render()
