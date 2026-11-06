import { beforeEach, describe, expect, it, vi } from 'vitest'

/* Page and frame writes persist and broadcast like any canvas change; these
   tests only care about the canvas the tools leave behind, so both are stubbed. */
vi.mock('../server/db/persist.ts', () => ({
  saveFrame: () => {},
  saveFrameNow: async () => {},
  saveCanvas: () => {},
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
}))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { deliveredWork, execTool } = await import('../server/resident.ts')
const { canvasPages, framePageId } = await import('../shared/pages.ts')
const { DEFAULT_ROLE_ID, roleName } = await import('../shared/agents.ts')

const actor = () => actions.resolveActor({ name: roleName(DEFAULT_ROLE_ID), kind: 'agent' })
const run = () => ({
  mutatedFrames: new Set<string>(),
  sourceFrames: new Set<string>(),
  verificationFrames: new Set<string>(),
  verifiedFrames: new Set<string>(),
  rewriteDrafts: new Map<string, string>(),
  vision: false,
  imagesGenerated: 0,
  repliedThreads: new Set<string>(),
  awaitingThreads: new Set<string>(),
  tokenWrites: 0,
  arrangeWrites: 0,
})
const call = (name: string, input: unknown) => ({ type: 'tool_use' as const, id: 't1', name, input })
const html = '<!doctype html><html><body>hi</body></html>'

let canvasId: string
let frameId: string

const canvas = () => store.getCanvas(canvasId)!
const pages = () => canvasPages(canvas()).map(({ id, name }) => ({ id, name }))

async function addPage(name: string) {
  const result = await execTool(call('create_canvas_page', { name }), canvasId, actor(), run())
  expect(result.is_error).toBeUndefined()
  return (JSON.parse(String(result.content)) as { page: { id: string } }).page.id
}

beforeEach(() => {
  actions.wire(
    () => {},
    () => {},
  )
  canvasId = store.createCanvas('pages', 'kevin').id
  frameId = actions.createFrame(canvasId, { name: 'Home', width: 390, height: 844, html, x: 10, y: 20 }, actor())!.id
})

describe('the resident agent reorganizes pages', () => {
  it('adds a page and moves a frame onto it in one update_frame call, keeping its position', async () => {
    const pageId = await addPage('Mobile')
    const runState = run()
    const result = await execTool(call('update_frame', { frame_id: frameId, pageId }), canvasId, actor(), runState)
    expect(result.is_error).toBeUndefined()
    const frame = store.getFrame(frameId)!
    expect(framePageId(canvas(), frame)).toBe(pageId)
    expect([frame.x, frame.y]).toEqual([10, 20])
    expect(deliveredWork(runState)).toBe(true)
    expect(runState.mutatedFrames.size).toBe(0)
  })

  it('refuses a page that is not on the canvas and names the real ones', async () => {
    const result = await execTool(call('update_frame', { frame_id: frameId, pageId: 'nope' }), canvasId, actor(), run())
    expect(result.is_error).toBe(true)
    expect(String(result.content)).toContain('no page nope')
    expect(String(result.content)).toContain(pages()[0]!.id)
  })

  it('counts a resize as a design change to verify', async () => {
    const runState = run()
    await execTool(call('update_frame', { frame_id: frameId, width: 1280 }), canvasId, actor(), runState)
    expect(store.getFrame(frameId)!.width).toBe(1280)
    expect(runState.mutatedFrames.has(frameId)).toBe(true)
  })

  it('reorders and renames pages from the list it last saw', async () => {
    await addPage('Mobile')
    const before = pages()
    const next = [{ ...before[1]!, name: 'Phone' }, before[0]!]
    const result = await execTool(
      call('set_canvas_pages', { expectedPages: before, pages: next }),
      canvasId,
      actor(),
      run(),
    )
    expect(result.is_error).toBeUndefined()
    expect(pages()).toEqual(next)
  })

  it('refuses a stale list and hands back the current one', async () => {
    const stale = pages()
    await addPage('Mobile')
    const result = await execTool(
      call('set_canvas_pages', { expectedPages: stale, pages: stale }),
      canvasId,
      actor(),
      run(),
    )
    expect(result.is_error).toBe(true)
    expect(String(result.content)).toContain('Mobile')
    expect(pages()).toHaveLength(2)
  })

  it('does not count a frame save that changed nothing as delivered work', async () => {
    const runState = run()
    const frame = store.getFrame(frameId)!
    const result = await execTool(
      call('update_frame', { frame_id: frameId, name: frame.name, x: frame.x, y: frame.y, width: frame.width }),
      canvasId,
      actor(),
      runState,
    )
    expect(result.is_error).toBeUndefined()
    expect(runState.arrangeWrites).toBe(0)
    expect(deliveredWork(runState)).toBe(false)
  })

  it('does not count a page list saved unchanged as delivered work', async () => {
    const runState = run()
    const result = await execTool(
      call('set_canvas_pages', { expectedPages: pages(), pages: pages() }),
      canvasId,
      actor(),
      runState,
    )
    expect(result.is_error).toBeUndefined()
    expect(runState.arrangeWrites).toBe(0)
    expect(deliveredWork(runState)).toBe(false)
  })

  it('will not delete a page that still holds frames', async () => {
    const pageId = await addPage('Mobile')
    const before = pages()
    const result = await execTool(
      call('set_canvas_pages', { expectedPages: before, pages: before.filter((p) => p.id === pageId) }),
      canvasId,
      actor(),
      run(),
    )
    expect(result.is_error).toBe(true)
    expect(String(result.content)).toContain('Home')
    expect(pages()).toHaveLength(2)
  })
})
