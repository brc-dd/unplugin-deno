import { format as formatDuration } from '@std/fmt/duration'
import { Hono } from 'hono'
import { html } from 'hono/html'
import { hostname } from 'node:os'
import greeting from './greeting.txt' with { type: 'text' }

const started = Date.now()

export const app = new Hono()

app.get('/', (c) =>
  c.html(html`<!doctype html>
    <title>Hono on Deno</title>
    <h1>${greeting.trim()}</h1>
    <p>Served by <code>${hostname()}</code>. See <a href="/api/status">/api/status</a>.</p>`),
)

app.get('/api/status', (c) =>
  c.json({
    greeting: greeting.trim(),
    uptime: formatDuration(Date.now() - started, { ignoreZero: true }) || '0ms',
  }),
)
