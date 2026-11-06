import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceDetail } from '../shared/types'

/* each call to getWorkspace hands back a promise the test settles by hand */
const pending: Array<(detail: WorkspaceDetail) => void> = []
vi.mock('../src/lib/api', () => ({
  api: {
    getWorkspace: vi.fn(() => new Promise<WorkspaceDetail>((resolve) => pending.push(resolve))),
  },
}))
import { api } from '../src/lib/api'
import { cachedWorkspace, fetchWorkspace, prefetchWorkspace } from '../src/lib/workspaceCache'

function detail(id: string, name: string): WorkspaceDetail {
  return { id, name } as WorkspaceDetail
}

describe('workspaceCache', () => {
  it('refreshes past a warm-up still in flight, and keeps the newer answer', async () => {
    prefetchWorkspace('a')
    const refresh = fetchWorkspace('a')
    expect(api.getWorkspace).toHaveBeenCalledTimes(2)
    pending[1]!(detail('a', 'after the edit'))
    await refresh
    expect(cachedWorkspace('a')?.name).toBe('after the edit')
    /* the warm-up answers last, with what it saw before the edit */
    pending[0]!(detail('a', 'before the edit'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(cachedWorkspace('a')?.name).toBe('after the edit')
  })

  it('shares one warm-up per workspace', () => {
    const calls = vi.mocked(api.getWorkspace).mock.calls.length
    prefetchWorkspace('b')
    prefetchWorkspace('b')
    expect(api.getWorkspace).toHaveBeenCalledTimes(calls + 1)
  })
})
