import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas } from '../shared/types.ts'

const persistence = vi.hoisted(() => ({
  insertCanvas: vi.fn<(canvas: Canvas) => Promise<void>>(),
  saveCanvas: vi.fn(),
  saveFrame: vi.fn(),
  deleteCanvas: vi.fn(),
}))
vi.mock('../server/db/persist.ts', () => persistence)
const { store, CanvasCreationUncertainError } = await import('../server/store.ts')
const { seed } = await import('../server/seed.ts')

beforeEach(() => {
  store.canvases.clear()
  vi.clearAllMocks()
})

function holdInsert() {
  let candidate: Canvas | undefined
  let commit!: () => void
  let fail!: (error: Error) => void
  const held = new Promise<void>((resolve, reject) => {
    commit = resolve
    fail = reject
  })
  persistence.insertCanvas.mockImplementation((canvas) => {
    candidate = canvas
    return held
  })
  return {
    get candidate() {
      return candidate!
    },
    commit,
    fail,
  }
}

describe('one initial canvas publication boundary', () => {
  it('denies candidate reads, lists, child writes and deletion until commit, then publishes once', async () => {
    const insert = holdInsert()
    const creating = store.createCanvas('Held private parent', 'owner')
    const id = insert.candidate.id
    expect(store.getCanvas(id)).toBeUndefined()
    expect(store.listCanvases('owner')).toEqual([])
    expect(store.createFrame(id, { name: 'Premature child', html: '<p>x</p>' }, 'owner')).toBeUndefined()
    expect(await store.deleteCanvas(id)).toBeUndefined()
    expect(persistence.saveFrame).not.toHaveBeenCalled()
    expect(persistence.deleteCanvas).not.toHaveBeenCalled()
    insert.commit()
    const created = await creating
    expect(created).toBe(insert.candidate)
    expect(store.getCanvas(id)).toBe(created)
    expect(store.listCanvases('owner').map((c) => c.id)).toEqual([id])
    expect(store.createFrame(id, { name: 'Committed child', html: '<p>x</p>' }, 'owner')).toBeTruthy()
    expect(persistence.insertCanvas).toHaveBeenCalledOnce()
  })

  it('retains no failed parent/child and exposes only bounded uncertainty', async () => {
    const insert = holdInsert()
    const creating = store.createCanvas('Private title', 'owner')
    const rejected = expect(creating).rejects.toBeInstanceOf(CanvasCreationUncertainError)
    insert.fail(new Error('SQL statement with secret parameters'))
    await rejected
    expect(store.getCanvas(insert.candidate.id)).toBeUndefined()
    expect(store.listCanvases('owner')).toEqual([])
    expect(store.createFrame(insert.candidate.id, { name: 'Phantom', html: '<p>x</p>' }, 'owner')).toBeUndefined()
    expect(persistence.saveCanvas).not.toHaveBeenCalled()
    expect(persistence.saveFrame).not.toHaveBeenCalled()
    expect(persistence.insertCanvas).toHaveBeenCalledOnce()
  })

  it('seed waits for a durable parent before creating either child', async () => {
    const insert = holdInsert()
    const seeding = seed()
    expect(store.canvases.size).toBe(0)
    expect(persistence.saveFrame).not.toHaveBeenCalled()
    persistence.saveFrame.mockImplementation((frame) => {
      expect(store.getCanvas(frame.canvasId)).toBe(insert.candidate)
    })
    insert.commit()
    await seeding
    expect(insert.candidate.frames).toHaveLength(2)
    expect(persistence.saveFrame).toHaveBeenCalledTimes(2)
  })

  it('failed seed rejects startup work without publishing a parent or queuing children', async () => {
    persistence.insertCanvas.mockRejectedValueOnce(new Error('owned database rejection'))
    await expect(seed()).rejects.toBeInstanceOf(CanvasCreationUncertainError)
    expect(store.canvases.size).toBe(0)
    expect(persistence.saveFrame).not.toHaveBeenCalled()
  })
})
