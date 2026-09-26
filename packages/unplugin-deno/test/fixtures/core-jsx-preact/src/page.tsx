import { renderToString } from 'preact-render-to-string'
// Used by the classic runtime (`"jsx": "react"` with `"jsxFactory": "h"`); the automatic runtime
// imports its own helpers from `preact/jsx-runtime`.
import { Fragment, h } from 'preact'

export { Fragment, h }

function Greeting({ name }: { name: string }) {
  return (
    <p class="greeting">
      Hello, <b>{name}</b>!
    </p>
  )
}

export function page(name: string): string {
  return renderToString(
    <>
      <Greeting name={name} />
      <ul>
        {[1, 2].map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </>,
  )
}
