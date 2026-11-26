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

/* the parameters an MCP agent has on these tools (tests/agentToolParity.test.ts keeps them in step) */
describe('the resident agent takes what an MCP agent takes', () => {
  /* create_frame takes a whole document, not a fragment */
  const page = `<!doctype html><html><head><title>Screen</title></head><body><main>A screen</main></body></html>`

  it('creates a frame on the page it names', async () => {
    const pageId = await addPage('Mobile')
    const runState = newRunState()
    const result = await execTool(
      call('create_frame', { name: 'Checkout', width: 390, height: 844, html: page, pageId }),
      canvasId,
      actor(),
      runState,
    )
    expect(result.is_error).toBeUndefined()
    const created = canvas().frames.find((f) => f.name === 'Checkout')!
    expect(framePageId(canvas(), created)).toBe(pageId)
  })

  it("names its page over the run's own placement, and lands beside the pin only on the pin's page", async () => {
    const pageId = await addPage('Mobile')
    const placement = { pageId: pages()[0]!.id, near: { x: 2000, y: 2000 } }
    await execTool(
      call('create_frame', { name: 'Elsewhere', width: 390, height: 844, html: page, pageId }),
      canvasId,
      actor(),
      newRunState({ placement }),
    )
    const elsewhere = canvas().frames.find((f) => f.name === 'Elsewhere')!
    expect(framePageId(canvas(), elsewhere)).toBe(pageId)
    expect(elsewhere.x).not.toBe(2040)

    await execTool(
      call('create_frame', { name: 'Beside', width: 390, height: 844, html: page }),
      canvasId,
      actor(),
      newRunState({ placement }),
    )
    const beside = canvas().frames.find((f) => f.name === 'Beside')!
    expect(framePageId(canvas(), beside)).toBe(placement.pageId)
    expect([beside.x, beside.y]).toEqual([2040, 2000])
  })

  it('refuses to create a frame on a page that is not on the canvas, and names the real ones', async () => {
    const result = await execTool(
      call('create_frame', { name: 'Lost', width: 390, height: 844, html: page, pageId: 'nope' }),
      canvasId,
      actor(),
      newRunState(),
    )
    expect(result.is_error).toBe(true)
    expect(String(result.content)).toContain('no page nope')
    expect(String(result.content)).toContain(pages()[0]!.id)
    expect(canvas().frames.map((f) => f.name)).toEqual(['Home'])
  })

  it('turns a frame with update_frame and straightens it with rotation 0', async () => {
    const runState = newRunState()
    const result = await execTool(
      call('update_frame', { frame_id: frameId, rotation: 30 }),
      canvasId,
      actor(),
      runState,
    )
    expect(result.is_error).toBeUndefined()
    expect(store.getFrame(frameId)!.rotation).toBe(30)
    expect(String(result.content)).toContain('turned 30°')
    expect(deliveredWork(runState)).toBe(true)

    await execTool(call('update_frame', { frame_id: frameId, rotation: 0 }), canvasId, actor(), newRunState())
    expect(store.getFrame(frameId)!.rotation ?? 0).toBe(0)
  })

  it('sets a prototype start by pageId, and still reads the page_id it used to take', async () => {
    const pageId = await addPage('Mobile')
    const onMobile = actions.createFrame(canvasId, { name: 'Splash', pageId, html, width: 390, height: 844 }, actor())!
    const result = await execTool(
      call('set_prototype_start', { frame_id: onMobile.id, pageId }),
      canvasId,
      actor(),
      newRunState(),
    )
    expect(result.is_error).toBeUndefined()
    expect(canvasPages(canvas()).find((p) => p.id === pageId)!.startFrameId).toBe(onMobile.id)

    /* a frame on another page than the one named is refused, so the page was read */
    for (const input of [
      { frame_id: frameId, pageId },
      { frame_id: frameId, page_id: pageId },
    ]) {
      const refused = await execTool(call('set_prototype_start', input), canvasId, actor(), newRunState())
      expect(refused.is_error, JSON.stringify(input)).toBe(true)
    }
  })

  it('edits frame HTML with old_str and new_str, and still reads find and replace', async () => {
    const edited = await execTool(
      call('edit_frame_html', { frame_id: frameId, old_str: 'hi', new_str: 'hello' }),
      canvasId,
      actor(),
      newRunState(),
    )
    expect(edited.is_error).toBeUndefined()
    expect(store.getFrame(frameId)!.html).toContain('hello')

    const legacy = await execTool(
      call('edit_frame_html', { frame_id: frameId, find: 'hello', replace: 'hey' }),
      canvasId,
      actor(),
      newRunState(),
    )
    expect(legacy.is_error).toBeUndefined()
    expect(store.getFrame(frameId)!.html).toContain('hey')

    const missing = await execTool(
      call('edit_frame_html', { frame_id: frameId, old_str: 'absent', new_str: 'x' }),
      canvasId,
      actor(),
      newRunState(),
    )
    expect(missing.is_error).toBe(true)
    expect(String(missing.content)).toContain('old_str')
  })

  it('filters tokens by a name glob and writes them as markdown', async () => {
    actions.createTokens(
      canvasId,
      [
        { name: '--color-brand', type: 'color', value: '#0177d3' },
        { name: '--color-ink', type: 'color', value: '#111111' },
        { name: '--radius-card', type: 'radius', value: '12px' },
      ],
      actor(),
    )
    const named = await execTool(call('get_tokens', { name_pattern: '--COLOR-*' }), canvasId, actor(), newRunState())
    const names = (JSON.parse(String(named.content)) as { tokens: { name: string }[] }).tokens.map((t) => t.name)
    expect(names.sort()).toEqual(['--color-brand', '--color-ink'])

    const none = await execTool(call('get_tokens', { name_pattern: '*shadow*' }), canvasId, actor(), newRunState())
    expect(String(none.content)).toBe('no design tokens match that filter')

    const markdown = await execTool(
      call('get_tokens', { name_pattern: '*card', format: 'markdown' }),
      canvasId,
      actor(),
      newRunState(),
    )
    expect(String(markdown.content)).toContain('| `--radius-card` |')
    expect(String(markdown.content)).not.toContain('--color-brand')
  })

  it('clears a prototype start with null, and still with the empty string it used to take', async () => {
    const start = () => canvasPages(canvas())[0]!.startFrameId
    for (const cleared of [null, '']) {
      await execTool(call('set_prototype_start', { frame_id: frameId }), canvasId, actor(), newRunState())
      expect(start()).toBe(frameId)
      const result = await execTool(
        call('set_prototype_start', { frame_id: cleared }),
        canvasId,
        actor(),
        newRunState(),
      )
      expect(result.is_error, String(cleared)).toBeUndefined()
      expect(start()).toBeUndefined()
    }
    const refused = await execTool(call('set_prototype_start', { frame_id: 7 }), canvasId, actor(), newRunState())
    expect(refused.is_error).toBe(true)
  })

  it('creates tokens with a number for a value, as an MCP agent may', async () => {
    const result = await execTool(
      call('create_tokens', { tokens: [{ name: '--opacity-muted', type: 'opacity', value: 0.6 }] }),
      canvasId,
      actor(),
      newRunState(),
    )
    expect(result.is_error).toBeUndefined()
    expect(store.getTokens(canvasId).find((t) => t.name === '--opacity-muted')?.value).toBe('0.6')
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
