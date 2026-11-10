import { describe, expect, it, vi } from 'vitest'
import { woff2 } from './fontFiles.ts'

/**
 * Two uploads of the same face, racing. The embedded dev database runs one
 * query at a time, which hides the race, so storage and the database are
 * stood in for here with writes that take a while: without the per-library
 * queue, each upload would look for the face to replace before the other's
 * row is saved, and both would stay.
 */

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

vi.mock('../server/assets.ts', () => ({
  storeAsset: async (buf: Buffer, type: { mime: string; ext: string }) => ({
    id: `asset${Math.random().toString(36).slice(2, 10)}`,
    mime: type.mime,
    ext: type.ext,
    size: buf.length,
  }),
}))

vi.mock('../server/db/index.ts', () => {
  const tx = {
    insert: () => ({ values: async () => {} }),
    delete: () => ({ where: async () => {} }),
  }
  return {
    db: {
      ...tx,
      select: () => ({ from: async () => [] }),
      transaction: async (work: (t: typeof tx) => Promise<void>) => {
        await delay(20)
        await work(tx)
      },
    },
  }
})

const membership = { member: true }
vi.mock('../server/privateResources.ts', () => ({
  privateCanvas: () => (membership.member ? { id: 'c1' } : undefined),
  requireResourceActor: async () => {},
}))
vi.mock('../server/store.ts', () => ({ store: { getCanvas: () => (membership.member ? { id: 'c1' } : undefined) } }))

describe('addFont', () => {
  it('keeps one entry per face when the same face is uploaded concurrently', async () => {
    const { addFont, listFonts } = await import('../server/fonts.ts')
    const user = { id: 'u1', name: 'U' }
    const face = () => woff2({ family: 'Race Mono', weight: 500 })
    await Promise.all([
      addFont({ canvasId: 'c1' }, user, face(), 'a.woff2'),
      addFont({ canvasId: 'c1' }, user, face(), 'b.woff2'),
      addFont({ canvasId: 'c1' }, user, face(), 'c.woff2'),
    ])
    const list = listFonts({ canvasId: 'c1' }, user.id)
    expect(list).toHaveLength(1)
    expect(list[0]!.fileName).toBe('c.woff2')
  })

  it('publishes no row when canvas access is removed mid-upload, and refuses later uploads', async () => {
    const { addFont, listFonts } = await import('../server/fonts.ts')
    const scope = { canvasId: 'c2' }
    const user = { id: 'u1', name: 'U' }
    membership.member = true
    /* already past its membership check and storing when the deletion lands */
    const inFlight = addFont(scope, user, woff2({ family: 'Gone Sans' }), 'a.woff2')
    await Promise.resolve()
    membership.member = false // current canvas access is revoked
    await expect(inFlight).rejects.toThrow(/no longer available/)
    expect(listFonts(scope, user.id)).toEqual([])
    await expect(addFont(scope, user, woff2({ family: 'Late Sans' }), 'b.woff2')).rejects.toThrow(/not available/)
    expect(listFonts(scope, user.id)).toEqual([])
  })
})
