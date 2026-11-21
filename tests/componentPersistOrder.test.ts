import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentDef } from '../shared/components.ts'

/*
 * A pooled database: each write lands when its own connection finishes, so two writes sent
 * back to back can land in either order. `landed` is the row as the database ends up with it.
 * A create saves a blank definition and then the filled one; before writes to a component
 * row were queued, the blank one could land last (2026-11-11: 236 hollow definitions).
 */
const pool = vi.hoisted(() => ({
  landed: new Map<string, unknown>(),
  delays: [] as number[],
  failures: 0,
  sent: 0,
}))

vi.mock('../server/db/index.ts', () => {
  const send = (land: () => void) => {
    const delay = pool.delays.shift() ?? 0
    pool.sent++
    return new Promise<void>((resolve, reject) =>
      setTimeout(() => {
        if (pool.failures > 0) {
          pool.failures--
          reject(new Error('connection reset'))
          return
        }
        land()
        resolve()
      }, delay),
    )
  }
  const db = {
    insert: () => ({
      values: (row: { id: string }) => ({
        onConflictDoUpdate: () => send(() => pool.landed.set(row.id, row)),
      }),
    }),
    delete: () => ({ where: () => send(() => pool.landed.clear()) }),
  }
  return { db }
})

const persist = await import('../server/db/persist.ts')

const def = (patch: Partial<ComponentDef>): ComponentDef => ({
  id: 'cmp-1',
  name: 'Button',
  description: '',
  template: '',
  css: '',
  rawCss: '',
  head: [],
  props: [],
  slots: [],
  rev: 0,
  mainFrameId: null,
  history: [],
  createdAt: 1,
  updatedAt: 1,
  updatedBy: 'Ada',
  ...patch,
})

const blank = def({})
const filled = def({ template: '<button>Buy</button>', rev: 1, mainFrameId: 'frame-1', updatedAt: 2 })

const stored = () => pool.landed.get('cmp-1') as { template: string; rev: number } | undefined

beforeEach(() => {
  pool.landed.clear()
  pool.delays.length = 0
  pool.failures = 0
  pool.sent = 0
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('writes to one component row', () => {
  it('land in the order they were made, even when the first is slow', async () => {
    pool.delays.push(30, 0)
    persist.saveComponent('canvas-1', blank)
    persist.saveComponent('canvas-1', filled)
    await persist.pendingComponentWrites()
    expect(stored()?.template).toBe('<button>Buy</button>')
    expect(stored()?.rev).toBe(1)
  })

  it('send only the latest of the states that waited behind a write in flight', async () => {
    pool.delays.push(20)
    persist.saveComponent('canvas-1', blank)
    persist.saveComponent('canvas-1', def({ rev: 1, template: '<b>one</b>' }))
    persist.saveComponent('canvas-1', filled)
    await persist.pendingComponentWrites()
    expect(pool.sent).toBe(2)
    expect(stored()?.template).toBe('<button>Buy</button>')
  })

  it('keep a delete after the save it follows', async () => {
    pool.delays.push(20)
    persist.saveComponent('canvas-1', filled)
    persist.deleteComponent('canvas-1', 'cmp-1')
    await persist.pendingComponentWrites()
    expect(stored()).toBeUndefined()
  })

  it('retry a write that failed, and say so', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.useFakeTimers()
    pool.failures = 1
    persist.saveComponent('canvas-1', filled)
    await vi.runAllTimersAsync()
    await persist.pendingComponentWrites()
    expect(stored()?.rev).toBe(1)
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('retrying'), expect.any(Error))
  })

  it('give a failed write up for a newer state rather than retry it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    pool.failures = 1
    pool.delays.push(20)
    persist.saveComponent('canvas-1', blank)
    persist.saveComponent('canvas-1', filled)
    await persist.pendingComponentWrites()
    expect(pool.sent).toBe(2)
    expect(stored()?.template).toBe('<button>Buy</button>')
  })

  /* last: a drained module stays drained */
  it('reach the database at shutdown, a retry waiting out its delay included', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    pool.failures = 1
    persist.saveComponent('canvas-1', filled)
    await vi.waitFor(() => expect(pool.sent).toBe(1))
    const started = Date.now()
    await persist.flush(() => undefined)
    expect(Date.now() - started).toBeLessThan(400)
    expect(stored()?.rev).toBe(1)
  })
})
