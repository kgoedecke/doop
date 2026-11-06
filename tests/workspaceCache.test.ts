import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceDetail } from '../shared/types'

/* each call to getWorkspace hands back a promise the test settles by hand */
const pending: Array<{ resolve: (detail: WorkspaceDetail) => void; reject: (error: Error) => void }> = []
vi.mock('../src/lib/api', () => ({
  api: {
    getWorkspace: vi.fn(() => new Promise<WorkspaceDetail>((resolve, reject) => pending.push({ resolve, reject }))),
  },
}))
import { api } from '../src/lib/api'
import { cachedWorkspace, fetchWorkspace, prefetchWorkspace } from '../src/lib/workspaceCache'

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function detail(id: string, name: string): WorkspaceDetail {
  return { id, name } as WorkspaceDetail
}

describe('workspaceCache', () => {
  it('refreshes past a warm-up still in flight, and keeps the newer answer', async () => {
    prefetchWorkspace('a')
    const refresh = fetchWorkspace('a')
    expect(api.getWorkspace).toHaveBeenCalledTimes(2)
    pending[1]!.resolve(detail('a', 'after the edit'))
    await refresh
    expect(cachedWorkspace('a')?.name).toBe('after the edit')
    /* the warm-up answers last, with what it saw before the edit */
    pending[0]!.resolve(detail('a', 'before the edit'))
    await settle()
    expect(cachedWorkspace('a')?.name).toBe('after the edit')
  })

  it('keeps fresh details when an older request fails, and a failure keeps out older answers', async () => {
    const start = pending.length
    prefetchWorkspace('c')
    const refresh = fetchWorkspace('c')
    pending[start + 1]!.resolve(detail('c', 'fresh'))
    await refresh
    pending[start]!.reject(new Error('offline'))
    await settle()
    expect(cachedWorkspace('c')?.name).toBe('fresh')

    const older = fetchWorkspace('c')
    const newer = fetchWorkspace('c').catch(() => undefined)
    pending[start + 3]!.reject(new Error('gone'))
    await newer
    expect(cachedWorkspace('c')).toBeNull()
    pending[start + 2]!.resolve(detail('c', 'stale'))
    await older
    expect(cachedWorkspace('c')).toBeNull()
  })

  it('shares one warm-up per workspace', () => {
    const calls = vi.mocked(api.getWorkspace).mock.calls.length
    prefetchWorkspace('b')
    prefetchWorkspace('b')
    expect(api.getWorkspace).toHaveBeenCalledTimes(calls + 1)
  })
})
