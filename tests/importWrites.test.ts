import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Actor, ServerMessage } from '../shared/types'

/* persistence is not under test: what the canvas write entry does with an import's writes is.
   Frame rows are only counted, to show what an undone write never stored */
const rows = vi.hoisted(() => ({ saved: [] as string[] }))
vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveActivity: () => {},
  saveCanvas: () => {},
  refreshAssetRefs: () => {},
  saveFrame: (frame: { html: string }) => void rows.saved.push(frame.html),
  saveFrameNow: async (frame: { html: string }) => void rows.saved.push(frame.html),
  saveFrameVersion: () => {},
  deleteFrame: () => {},
  frameWritePending: () => false,
  getFrameVersion: async () => undefined,
  saveToken: () => {},
  deleteToken: () => {},
  saveComponent: () => {},
  deleteComponent: () => {},
  settleActorFrame: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveCommentNow: async () => {},
  saveDecision: () => {},
  saveProposal: () => {},
}))
vi.mock('../server/fonts.ts', () => ({ fontsForCanvas: () => [] }))
/* no browser: a webpage capture is handed in */
const captured = vi.hoisted(() => ({
  page: { title: 'Captured', width: 800, height: 600, html: '<html><body><p>captured</p></body></html>' },
}))
vi.mock('../server/importer.ts', async (original) => ({
  ...(await original<typeof import('../server/importer.ts')>()),
  importPage: async () => captured.page,
}))
const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { isImportWriteFailure, landImportFrame, runCanvasWrite, runImportWrite } =
  await import('../server/canvasWrites.ts')
const { WorkBudgetError } = await import('../server/workBudget.ts')
const { refundUnlessDone } = await import('../server/chargedWork.ts')
const { createImportedWebpageFrame } = await import('../server/webpageImport.ts')
const { openTransaction } = await import('../server/journal.ts')

/* Imports and ingest write through the canvas write entry (server/canvasWrites.ts): inside a
   request or a tool call a refused write undoes everything that call wrote, and tells nobody;
   run in the background, each frame lands committed by itself. */

const person: Actor = { name: 'Ada', kind: 'user', color: '#2743ee' }
let sent: ServerMessage[]
let canvasId: string

beforeEach(() => {
  vi.restoreAllMocks()
  sent = []
  actions.wire(
    /* this test's canvas only: an earlier test's late messages are not this one's */
    (to, message) => void (to === canvasId && sent.push(message)),
    () => {},
  )
  canvasId = store.createCanvas('imports', 'ada').id
})

const framesOn = (id: string) => store.getCanvas(id)?.frames ?? []

/** The store refuses the `nth` frame it is asked to make from now on, as storage might. */
function refuseCreate(nth: number) {
  const create = store.createFrame.bind(store)
  let calls = 0
  return vi.spyOn(store, 'createFrame').mockImplementation((...args) => {
    if (++calls === nth) throw new Error('storage refused')
    return create(...args)
  })
}

describe('an import that writes inside a request or a tool call', () => {
  it('a refused write rejects, is told apart from a failed capture, and the request undoes every frame it made', async () => {
    /* as the HTTP middleware opens a request's transaction, and undoRequest rolls it back */
    const request = openTransaction()
    const failure = await request
      .run(async () => {
        await runImportWrite('website import', canvasId, {
          type: 'create-frame',
          input: { name: 'First page' },
          actor: person,
        })
        refuseCreate(1)
        await createImportedWebpageFrame({ canvasId, url: 'https://example.com', actor: person })
      })
      .catch((error: unknown) => error)
    expect(isImportWriteFailure(failure)).toBe(true)
    expect((failure as Error).message).toBe('storage refused')
    request.rollback()
    expect(framesOn(canvasId)).toEqual([])
    expect(sent).toEqual([])
    /* what the importer itself throws is the import's own failure, answered by the route */
    expect(isImportWriteFailure(new Error('could not load the page'))).toBe(false)
  })

  it('a landed import answers the frame as its write left it', async () => {
    const request = openTransaction()
    const { frame } = await request.run(() =>
      createImportedWebpageFrame({ canvasId, url: 'example.com', actor: person }),
    )
    request.commit()
    expect(frame).toBe(store.getFrame(frame!.id))
    expect(frame).toMatchObject({ name: 'Captured', width: 800, height: 600 })
    expect(sent.map((message) => message.type)).toContain('frame:created')
  })
})

describe('an import that lands frame after frame in the background', () => {
  it('commits each frame by itself; one refused is answered, not thrown, and the ones before it stand', async () => {
    const land = (name: string) =>
      landImportFrame('Meta pull', canvasId, { type: 'create-frame', input: { name }, actor: person })
    const first = await land('One')
    refuseCreate(1)
    const second = await land('Two')
    vi.restoreAllMocks()
    const third = await land('Three')
    expect(first.ok && first.result?.name).toBe('One')
    expect(second.ok ? undefined : second.error.message).toBe('storage refused')
    expect(third.ok && third.result?.name).toBe('Three')
    expect(framesOn(canvasId).map((frame) => frame.name)).toEqual(['One', 'Three'])
    expect(sent.filter((message) => message.type === 'frame:created')).toHaveLength(2)
  })

  it('inside a request too, a refused page is answered and the pages before it stay', async () => {
    /* a website's pages, as the REST import lands them */
    const request = openTransaction()
    const landed = await request.run(async () => {
      const land = (name: string) =>
        landImportFrame('website import', canvasId, { type: 'create-frame', input: { name }, actor: person })
      const first = await land('One')
      refuseCreate(1)
      const second = await land('Two')
      return [first, second]
    })
    request.commit()
    expect(landed.map((page) => page.ok)).toEqual([true, false])
    expect(framesOn(canvasId).map((frame) => frame.name)).toEqual(['One'])
  })

  it('inside a request, a spent work budget is not a page’s refusal: it rejects, and the request is undone', async () => {
    const request = openTransaction()
    const failure = await request
      .run(async () => {
        await landImportFrame('website import', canvasId, {
          type: 'create-frame',
          input: { name: 'One' },
          actor: person,
        })
        vi.spyOn(store, 'createFrame').mockImplementationOnce(() => {
          throw new WorkBudgetError('test', canvasId, 'bytes')
        })
        await landImportFrame('website import', canvasId, {
          type: 'create-frame',
          input: { name: 'Two' },
          actor: person,
        })
      })
      .catch((error: unknown) => error)
    request.rollback()
    expect(failure).toBeInstanceOf(WorkBudgetError)
    expect(framesOn(canvasId)).toEqual([])
    expect(sent).toEqual([])
  })
})

describe('the element-id backfill command', () => {
  const page = '<main><p>one</p><p>two</p></main>'

  it('saves and tells the room only when its operation commits: undone, it leaves both untouched', async () => {
    const frame = actions.createFrame(canvasId, { name: 'Commented', html: page }, person)!
    await new Promise((resolve) => setTimeout(resolve, 0))
    rows.saved = []
    sent = []
    const request = openTransaction()
    const written = await request.run(() =>
      runCanvasWrite(canvasId, { type: 'stamp-element-ids', frameId: frame.id, selectors: ['body > main > p'] }),
    )
    expect(written?.stamps).toEqual([{ id: expect.any(String) }])
    expect(sent).toEqual([])
    request.rollback()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(store.getFrame(frame.id)?.html).toBe(page)
    expect(sent).toEqual([])
    /* the undo may store the frame again as it was, never with the stamp */
    expect(rows.saved.filter((html) => html.includes('data-doop-id'))).toEqual([])
  })

  it('refuses a frame that is being streamed into', async () => {
    const frame = actions.createFrame(canvasId, { name: 'Streaming', html: page }, person)!
    actions.appendFrameHtml(frame.id, '<main><p>one</p>', person, { start: true })
    const html = store.getFrame(frame.id)!.html
    expect(
      await runCanvasWrite(canvasId, { type: 'stamp-element-ids', frameId: frame.id, selectors: ['body > main > p'] }),
    ).toBeUndefined()
    expect(store.getFrame(frame.id)?.html).toBe(html)
  })
})

describe('a comment that was charged a resident task', () => {
  it('gives the task back when the comment is refused or not posted, and keeps it when it is', async () => {
    const refunded: string[] = []
    const refund = async (gate: string) => void refunded.push(gate)
    await expect(
      refundUnlessDone('refused', refund, () => Promise.reject(new Error('stamp refused')), 'ada'),
    ).rejects.toThrow('stamp refused')
    expect(await refundUnlessDone('not posted', refund, async () => undefined, 'ada')).toBeUndefined()
    expect(await refundUnlessDone('posted', refund, async () => 'comment', 'ada')).toBe('comment')
    /* nothing charged, nothing given back; a refund that fails is logged, not the request's failure */
    await expect(refundUnlessDone(undefined, refund, () => Promise.reject(new Error('x')), 'ada')).rejects.toThrow('x')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(
      await refundUnlessDone(
        'broken',
        () => Promise.reject(new Error('db down')),
        async () => undefined,
        'ada',
      ),
    ).toBeUndefined()
    expect(error).toHaveBeenCalled()
    expect(refunded).toEqual(['refused', 'not posted'])
  })
})
