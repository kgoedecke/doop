import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types.ts'

/* every write the store asks the database for, in order */
const writes = vi.hoisted(() => [] as string[])

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: (c: Canvas) => void writes.push(`canvas:${c.id}`),
  deleteCanvas: (id: string) => void writes.push(`delete-canvas:${id}`),
  saveFrame: (f: Frame, now?: boolean) => void writes.push(`frame:${f.id}${now ? ':now' : ''}`),
  deleteFrame: (id: string) => void writes.push(`delete-frame:${id}`),
  saveComponent: (_canvasId: string, def: { id: string; rev: number }) =>
    void writes.push(`component:${def.id}@${def.rev}`),
  deleteComponent: (_canvasId: string, id: string) => void writes.push(`delete-component:${id}`),
  saveToken: (_canvasId: string, token: { name: string }) => void writes.push(`token:${token.name}`),
  deleteToken: (_canvasId: string, name: string) => void writes.push(`delete-token:${name}`),
  saveGuideline: () => void writes.push('guideline'),
  saveMember: () => void writes.push('member'),
  deleteMember: () => void writes.push('delete-member'),
}))

import { blankComponent } from '../server/components.ts'
import { savepoint, transaction, WriteBoundaryError } from '../server/journal.ts'
import { store } from '../server/store.ts'
import { canvasPages } from '../shared/pages.ts'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

let canvas: Canvas
let frame: Frame

beforeEach(() => {
  canvas = store.createCanvas('journal')
  frame = store.createFrame(canvas.id, { name: 'One', html: '<p>one</p>' }, 'Ada')!
  writes.length = 0
})

afterEach(() => {
  unstubAllEnvs()
})

const refuse = (work: () => void) =>
  expect(() =>
    transaction(() => {
      work()
      throw new Error('refused')
    }),
  ).toThrow('refused')

describe('a store write inside a transaction', () => {
  it('changes memory at once and reaches the database only at the commit', () => {
    transaction(() => {
      store.updateFrame(frame.id, { html: '<p>two</p>' }, 'Ada')
      expect(store.getFrame(frame.id)!.html).toBe('<p>two</p>')
      expect(writes).toEqual([])
    })
    expect(writes).toEqual([`frame:${frame.id}`, `canvas:${canvas.id}`])
  })

  it('writes a row once however often the transaction changed it', () => {
    transaction(() => {
      const made = store.createFrame(canvas.id, { name: 'Two' }, 'Ada')!
      store.updateFrame(made.id, { html: '<p>a</p>' }, 'Ada')
      store.updateFrame(made.id, { html: '<p>b</p>' }, 'Ada')
      store.updateFrame(frame.id, { x: 5 }, 'Ada')
    })
    expect(writes.filter((write) => write.startsWith('canvas:'))).toHaveLength(1)
    expect(writes.filter((write) => write.startsWith('frame:'))).toHaveLength(2)
  })

  it('never writes a frame the same transaction went on to delete', () => {
    let id = ''
    transaction(() => {
      id = store.createFrame(canvas.id, { name: 'Gone' }, 'Ada')!.id
      store.deleteFrame(id)
    })
    expect(writes).not.toContain(`frame:${id}:now`)
    expect(writes).toContain(`delete-frame:${id}`)
  })

  it('stores only the definition a component ended the transaction with', () => {
    const def = blankComponent({ name: 'Button', by: 'Ada' })
    transaction(() => {
      store.saveComponent(canvas.id, def)
      store.saveComponent(canvas.id, { ...def, rev: 1 })
      store.saveComponent(canvas.id, { ...def, rev: 2 })
    })
    expect(writes.filter((write) => write.startsWith('component:'))).toEqual([`component:${def.id}@2`])
  })
})

describe('a transaction that is refused', () => {
  it('puts a frame back whole: its html, size, stamp and author, and stores nothing', () => {
    const before = { ...frame }
    refuse(() => {
      store.updateFrame(frame.id, { html: '<p>two</p>', width: 900, rotation: 12 }, 'Grace')
      store.updateFrame(frame.id, { name: 'Renamed' }, 'Grace')
    })
    expect({ ...store.getFrame(frame.id)! }).toEqual(before)
    expect(store.getFrame(frame.id)).toBe(frame)
    expect(writes).toEqual([])
  })

  it('takes a created frame away again and brings a deleted one back in its place', () => {
    const second = store.createFrame(canvas.id, { name: 'Two' }, 'Ada')!
    const order = canvas.frames.map((entry) => entry.id)
    refuse(() => {
      store.createFrame(canvas.id, { name: 'Three' }, 'Ada')
      store.deleteFrame(frame.id)
    })
    expect(canvas.frames.map((entry) => entry.id)).toEqual(order)
    expect(store.getFrame(frame.id)).toBe(frame)
    expect(store.getFrame(second.id)).toBe(second)
  })

  it('puts back the definition a save replaced, and a component that was removed', () => {
    const def = blankComponent({ name: 'Button', by: 'Ada' })
    const other = blankComponent({ name: 'Card', by: 'Ada' })
    store.saveComponent(canvas.id, def)
    store.saveComponent(canvas.id, other)
    refuse(() => {
      store.saveComponent(canvas.id, { ...def, rev: 3 })
      store.deleteComponent(canvas.id, other.id)
      store.saveComponent(canvas.id, blankComponent({ name: 'New', by: 'Ada' }))
    })
    expect(store.getComponents(canvas.id)).toEqual([def, other])
    expect(store.getComponents(canvas.id)[0]).toBe(def)
  })

  it('leaves no page it added, and the tokens as they were, changed ones included', () => {
    store.setTokens(canvas.id, [{ name: '--ink', type: 'color', value: '#111' }], 'Ada')
    const pages = canvasPages(canvas)
    refuse(() => {
      store.setPages(canvas.id, [...pages, { id: 'components', name: 'Components' }])
      store.setTokens(
        canvas.id,
        [
          { name: '--ink', type: 'color', value: '#222' },
          { name: '--paper', type: 'color', value: '#fff' },
        ],
        'Grace',
      )
    })
    expect(canvasPages(canvas)).toEqual(pages)
    expect(store.getTokens(canvas.id).map((token) => [token.name, token.value, token.updatedBy])).toEqual([
      ['--ink', '#111', 'Ada'],
    ])
  })

  it('undoes a new canvas and restores a deleted one', () => {
    let made = ''
    refuse(() => {
      made = store.createCanvas('never').id
      store.deleteCanvas(canvas.id)
    })
    expect(store.getCanvas(made)).toBeUndefined()
    expect(store.getCanvas(canvas.id)).toBe(canvas)
    expect(store.getFrame(frame.id)).toBe(frame)
  })

  it('leaves no row for a frame it made and changed after awaiting', async () => {
    let made = ''
    await expect(
      transaction(async () => {
        made = store.createFrame(canvas.id, { name: 'New', html: '<p>a</p>' }, 'Ada')!.id
        await Promise.resolve()
        store.updateFrame(made, { html: '<p>b</p>' }, 'Ada')
        throw new Error('refused')
      }),
    ).rejects.toThrow('refused')
    expect(store.getFrame(made)).toBeUndefined()
    expect(writes.filter((write) => write.startsWith(`frame:${made}`))).toEqual([])
  })

  it('stores a frame that was there before back once, after every undo has run', async () => {
    await expect(
      transaction(async () => {
        store.updateFrame(frame.id, { html: '<p>two</p>' }, 'Ada')
        await Promise.resolve()
        store.updateFrame(frame.id, { html: '<p>three</p>' }, 'Ada')
        throw new Error('refused')
      }),
    ).rejects.toThrow('refused')
    expect(store.getFrame(frame.id)!.html).toBe('<p>one</p>')
    expect(writes.filter((write) => write.startsWith(`frame:${frame.id}`))).toEqual([`frame:${frame.id}`])
  })
})

describe('an undo and a write someone else made meanwhile', () => {
  it('leaves a frame that was written again since, and stores it once more when it does go back', async () => {
    /* refused after an await during which another request wrote the same frame */
    await expect(
      transaction(async () => {
        store.updateFrame(frame.id, { html: '<p>mine</p>' }, 'Ada')
        await Promise.resolve()
        store.updateFrame(frame.id, { html: '<p>theirs</p>' }, 'Grace')
        throw new Error('refused')
      }),
    ).rejects.toThrow('refused')
    /* both writes were this transaction's here, so both go back */
    expect(store.getFrame(frame.id)!.html).toBe('<p>one</p>')
    /* a debounced write may have stored the frame while it awaited: the row is put right,
       once, after both undos */
    expect(writes).toEqual([`frame:${frame.id}`])

    writes.length = 0
    let release = () => {}
    const waiting = new Promise<void>((resolve) => (release = resolve))
    const mine = transaction(async () => {
      store.updateFrame(frame.id, { html: '<p>mine</p>' }, 'Ada')
      await waiting
      throw new Error('refused')
    })
    await Promise.resolve()
    /* someone else's request, committed while the first awaits */
    transaction(() => store.updateFrame(frame.id, { html: '<p>theirs</p>' }, 'Grace'))
    release()
    await expect(mine).rejects.toThrow('refused')
    expect(store.getFrame(frame.id)!.html).toBe('<p>theirs</p>')
    expect(store.getFrame(frame.id)!.updatedBy).toBe('Grace')
  })

  it('leaves a component that was saved again since', async () => {
    const def = blankComponent({ name: 'Button', by: 'Ada' })
    store.saveComponent(canvas.id, def)
    let release = () => {}
    const waiting = new Promise<void>((resolve) => (release = resolve))
    const mine = transaction(async () => {
      store.saveComponent(canvas.id, { ...def, rev: 1 })
      await waiting
      throw new Error('refused')
    })
    await Promise.resolve()
    const theirs = { ...def, rev: 2 }
    transaction(() => store.saveComponent(canvas.id, theirs))
    release()
    await expect(mine).rejects.toThrow('refused')
    expect(store.getComponents(canvas.id)).toEqual([theirs])
  })
})

describe('a savepoint', () => {
  it('takes back what followed it and keeps what came before', () => {
    transaction(() => {
      store.updateFrame(frame.id, { name: 'Kept' }, 'Ada')
      const before = savepoint()
      store.updateFrame(frame.id, { name: 'Undone' }, 'Ada')
      store.createFrame(canvas.id, { name: 'Undone too' }, 'Ada')
      before.undo()
    })
    expect(store.getFrame(frame.id)!.name).toBe('Kept')
    expect(canvas.frames).toHaveLength(1)
    expect(writes).toEqual([`frame:${frame.id}`, `canvas:${canvas.id}`])
  })
})

describe('a store write outside any boundary', () => {
  it('is refused when the check is set to throw, and allowed inside a transaction', () => {
    stubEnv('DOOP_WRITE_BOUNDARY', 'throw')
    expect(() => store.updateFrame(frame.id, { x: 1 }, 'Ada')).toThrow(WriteBoundaryError)
    expect(() => store.createCanvas('nope')).toThrow(WriteBoundaryError)
    expect(() => store.saveComponent(canvas.id, blankComponent({ name: 'B', by: 'Ada' }))).toThrow(WriteBoundaryError)
    expect(() => transaction(() => store.updateFrame(frame.id, { x: 1 }, 'Ada'))).not.toThrow()
    expect(store.getFrame(frame.id)!.x).toBe(1)
  })
})
