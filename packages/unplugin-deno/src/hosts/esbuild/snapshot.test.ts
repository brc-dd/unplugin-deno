import { rm, writeFile } from 'node:fs/promises'
import { describe, expect, it, onTestFinished } from 'vitest'
import { tempDir } from '../../../test/helpers/temp-dir.js'
import { changedFile, takeSnapshot } from './snapshot.js'

describe('watch snapshots', () => {
  it('finds the first watched file whose contents changed', async () => {
    const dir = await tempDir({ 'deno.json': '{}', 'package.json': '{}' })
    onTestFinished(() => dir.dispose())
    const files = [dir.path('deno.json'), dir.path('deno.lock'), dir.path('package.json')]
    const snapshot = await takeSnapshot(files)
    expect([...snapshot.values()]).toEqual(['{}', null, '{}'])
    expect(await changedFile(snapshot)).toBeUndefined()

    // Rewriting the same contents is no change.
    await writeFile(dir.path('deno.json'), '{}')
    expect(await changedFile(snapshot)).toBeUndefined()

    await writeFile(dir.path('package.json'), '{ "name": "x" }')
    expect(await changedFile(snapshot)).toBe(dir.path('package.json'))
    await writeFile(dir.path('deno.lock'), '{ "version": "5" }')
    expect(await changedFile(snapshot)).toBe(dir.path('deno.lock'))
    await rm(dir.path('deno.json'))
    expect(await changedFile(snapshot)).toBe(dir.path('deno.json'))
  })
})
