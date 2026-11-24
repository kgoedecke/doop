import { beforeEach, describe, expect, it, vi } from 'vitest'

/* Page and frame writes persist and broadcast like any canvas change; these
   tests only care about the canvas the tools leave behind, so both are stubbed. */
vi.mock('../server/db/persist.ts', () => ({
  refreshAssetRefs: () => {},
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
vi.mock('../server/screenshot.ts', async (importOriginal) =>
  (await import('./measureGate.ts')).gatedScreenshot(await importOriginal()),
)

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { deliveredWork, execTool, newRunState } = await import('../server/resident.ts')
const { findBrowserPath } = await import('../server/screenshot.ts')
const { holdNextMeasure } = await import('./measureGate.ts')
const { canvasPages, framePageId, MAX_CANVAS_NAME } = await import('../shared/pages.ts')
const { DEFAULT_ROLE_ID, roleName } = await import('../shared/agents.ts')

const actor = () => actions.resolveActor({ name: roleName(DEFAULT_ROLE_ID), kind: 'agent' })
const run = () => newRunState()
const call = (name: string, input: unknown) => ({ type: 'tool_use' as const, id: 't1', name, input })
const html = '<!doctype html><html><body>hi</body></html>'

let canvasId: string
let frameId: string

const canvas = () => store.getCanvas(canvasId)!
const pages = () => canvasPages(canvas()).map(({ id, name }) => ({ id, name }))

async function addPage(name: string) {
  const result = await execTool(call('create_canvas_page', { name }), canvasId, actor(), newRunState())
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
    const runState = newRunState()
    const result = await execTool(call('update_frame', { frame_id: frameId, pageId }), canvasId, actor(), runState)
    expect(result.is_error).toBeUndefined()
    const frame = store.getFrame(frameId)!
    expect(framePageId(canvas(), frame)).toBe(pageId)
    expect([frame.x, frame.y]).toEqual([10, 20])
    expect(deliveredWork(runState)).toBe(true)
    expect(runState.mutatedFrames.size).toBe(0)
  })

  it('refuses a page that is not on the canvas and names the real ones', async () => {
    const result = await execTool(
      call('update_frame', { frame_id: frameId, pageId: 'nope' }),
      canvasId,
      actor(),
      newRunState(),
    )
    expect(result.is_error).toBe(true)
    expect(String(result.content)).toContain('no page nope')
    expect(String(result.content)).toContain(pages()[0]!.id)
  })

  it('counts a resize as a design change to verify', async () => {
    const runState = newRunState()
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
      newRunState(),
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
      newRunState(),
    )
    expect(result.is_error).toBe(true)
    expect(String(result.content)).toContain('Mobile')
    expect(pages()).toHaveLength(2)
  })

  it('renames the canvas, and counts it as delivered only when the name changed', async () => {
    const runState = newRunState()
    const result = await execTool(call('update_canvas', { name: ' Launch ' }), canvasId, actor(), runState)
    expect(result.is_error).toBeUndefined()
    expect(canvas().name).toBe('Launch')
    expect(deliveredWork(runState)).toBe(true)

    const again = newRunState()
    await execTool(call('update_canvas', { name: 'Launch' }), canvasId, actor(), again)
    expect(deliveredWork(again)).toBe(false)

    for (const name of ['  ', 'x'.repeat(MAX_CANVAS_NAME + 1)]) {
      const refused = await execTool(call('update_canvas', { name }), canvasId, actor(), newRunState())
      expect(refused.is_error).toBe(true)
    }
    expect(canvas().name).toBe('Launch')
  })

  it('does not count a frame save that changed nothing as delivered work', async () => {
    const runState = newRunState()
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
    const runState = newRunState()
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
      newRunState(),
    )
    expect(result.is_error).toBe(true)
    expect(String(result.content)).toContain('Home')
    expect(pages()).toHaveLength(2)
  })
})

describe.skipIf(!findBrowserPath())('fit_to_content', () => {
  const tall = '<!doctype html><html><body style="margin:0"><div style="height:640px"></div></body></html>'

  it('fits a frame from update_frame, and refuses it with height', async () => {
    actions.updateFrame(frameId, { html: tall }, actor())
    const refused = await execTool(
      call('update_frame', { frame_id: frameId, height: 10, fit_to_content: 'height' }),
      canvasId,
      actor(),
      run(),
    )
    expect(refused.is_error).toBe(true)
    const invalid = await execTool(
      call('update_frame', { frame_id: frameId, fit_to_content: true }),
      canvasId,
      actor(),
      run(),
    )
    expect(String(invalid.content)).toContain('must be "height", "width" or "both"')
    const runState = run()
    const result = await execTool(
      call('update_frame', { frame_id: frameId, fit_to_content: 'height' }),
      canvasId,
      actor(),
      runState,
    )
    expect(result.is_error).toBeUndefined()
    expect(store.getFrame(frameId)!.height).toBe(640)
    expect(String(result.content)).toContain('now 640px tall')
    expect(runState.mutatedFrames.has(frameId)).toBe(true)
  }, 60_000)

  it('fits what create_frame and set_frame_html write', async () => {
    const created = await execTool(
      call('create_frame', { name: 'Fitted', width: 390, height: 844, html: tall, fit_to_content: 'height' }),
      canvasId,
      actor(),
      run(),
    )
    expect(String(created.content)).toMatch(/390x640/)
    const set = await execTool(
      call('set_frame_html', { frame_id: frameId, html: tall.replace('640px', '420px'), fit_to_content: 'height' }),
      canvasId,
      actor(),
      run(),
    )
    expect(set.is_error).toBeUndefined()
    expect(store.getFrame(frameId)!.height).toBe(420)
  }, 60_000)

  it('answers a set_frame_html whose frame is deleted while it is measured', async () => {
    const measuring = holdNextMeasure()
    const pending = execTool(
      call('set_frame_html', { frame_id: frameId, html: tall, fit_to_content: 'height' }),
      canvasId,
      actor(),
      run(),
    )
    await measuring.reached
    actions.deleteFrame(frameId, actor())
    measuring.release()
    const result = await pending
    expect(String(result.content)).toContain('fit_to_content was not applied')
  }, 60_000)
})
