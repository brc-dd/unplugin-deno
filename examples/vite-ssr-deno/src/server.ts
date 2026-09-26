import { app } from './app.ts'

Deno.serve({ port: Number(Deno.env.get('PORT') ?? 8000) }, app.fetch)
