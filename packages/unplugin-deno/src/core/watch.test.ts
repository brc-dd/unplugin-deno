import { describe, expect, it } from 'vitest'
import type { Project } from '../config/project.js'
import { createSilentLogger } from '../diagnostics/logger.js'
import { invalidateProject, isWatchedFile, watchFiles } from './watch.js'

describe('watchFiles / isWatchedFile', () => {
  const project = { watchFiles: ['/p/deno.json', '/p/deno.lock', '/p/packages/a/package.json'] }

  it('lists the project watch files', () => {
    expect(watchFiles(project)).toEqual(project.watchFiles)
    expect(watchFiles(project)).not.toBe(project.watchFiles)
  })

  it('matches watched files, ignoring queries and normalising paths', () => {
    expect(isWatchedFile(project, '/p/deno.json', 'posix')).toBe(true)
    expect(isWatchedFile(project, '/p/./deno.lock?t=1', 'posix')).toBe(true)
    expect(isWatchedFile(project, '/p/src/main.ts', 'posix')).toBe(false)
    expect(isWatchedFile(project, '/P/deno.json', 'posix')).toBe(false)
  })

  it('compares Windows paths case-insensitively', () => {
    const windows = { watchFiles: ['C:\\p\\deno.json'] }
    expect(isWatchedFile(windows, 'c:\\P\\deno.json', 'win32')).toBe(true)
    expect(isWatchedFile(windows, 'C:/p/deno.json', 'win32')).toBe(true)
    expect(isWatchedFile(windows, 'C:\\p\\deno.jsonc', 'win32')).toBe(false)
  })
})

describe('invalidateProject', () => {
  it('flushes, disposes the engines, reloads and reconfigures, in that order', async () => {
    const steps: string[] = []
    const project = { watchFiles: [] } as unknown as Project
    const reloaded = await invalidateProject(
      {
        logger: createSilentLogger(),
        flush: async () => {
          steps.push('flush')
        },
        disposeEngines: async () => {
          steps.push('dispose')
        },
        loadProject: async () => {
          steps.push('load')
          return project
        },
        configure: async (loaded) => {
          expect(loaded).toBe(project)
          steps.push('configure')
        },
      },
      '/p/deno.json',
    )
    expect(reloaded).toBe(project)
    expect(steps).toEqual(['flush', 'dispose', 'load', 'configure'])
  })
})
