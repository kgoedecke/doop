import { describe, expect, it, vi } from 'vitest'
import type { Actor } from '../shared/types'

vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  saveCanvas: () => {},
  saveFrame: () => {},
  saveToken: () => {},
  deleteToken: () => {},
  saveComponent: () => {},
  saveCanvasCopy: async () => {},
  saveFrameVersion: () => {},
}))
vi.mock('../server/fonts.ts', () => ({ fontsForCanvas: () => [] }))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { componentWriteNotes, runComponentTool } = await import('../server/componentTools.ts')

/**
 * Two ways a component went missing in agents' frames with nothing said: an image prop bound
 * by a bare name filled the <img>'s text instead of its src, and a <doop-use> that rendered
 * nothing (an unclosed one, which also swallowed every one after it, or an empty main).
 */

const agent: Actor = { name: 'Claude', kind: 'agent', color: '#e5533c' }
const page = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`

async function canvasWith(components: Record<string, string>) {
  const canvasId = store.createCanvas('drops', 'kevin').id
  for (const [name, html] of Object.entries(components)) {
    const outcome = await runComponentTool(
      'create_component',
      { name, html, css: '', auto_props: false },
      {
        canvas: store.getCanvas(canvasId)!,
        actor: agent,
        canRead: () => true,
        canEdit: () => true,
        userId: undefined,
        readableCanvases: () => [],
      },
    )
    if (!outcome.ok) throw new Error(outcome.error)
  }
  return canvasId
}

function write(canvasId: string, body: string) {
  const frame = actions.createFrame(canvasId, { name: 'Screen', html: page(body) }, agent)!
  return { html: store.getFrame(frame.id)!.html, notes: componentWriteNotes(frame) }
}

describe('an image prop bound by a bare name', () => {
  it('leaves a bare binding as text on a tag the table does not name, inherited names included', async () => {
    const { parseBindings } = await import('../shared/components')
    expect(parseBindings('label', 'constructor')).toEqual([{ target: null, prop: 'label' }])
    expect(parseBindings('label', 'toString')).toEqual([{ target: null, prop: 'label' }])
    expect(parseBindings('photo', 'IMG')).toEqual([{ target: 'src', prop: 'photo' }])
  })

  it('fills the image’s src, and is typed as an image', async () => {
    const canvasId = await canvasWith({
      Cover:
        '<figure class="cover"><img data-doop-prop="artwork" src="/a/one.png" alt=""><figcaption data-doop-prop="title">One</figcaption></figure>',
    })
    const def = store.getComponents(canvasId).find((component) => component.name === 'Cover')!
    expect(def.props.find((prop) => prop.name === 'artwork')?.type).toBe('image')
    const { html, notes } = write(canvasId, '<doop-use component="Cover" artwork="/a/two.png" title="Two"></doop-use>')
    expect(notes).toEqual([])
    expect(html).toMatch(/<img[^>]*src="\/a\/two\.png"/)
    expect(html).toContain('>Two</figcaption>')
  })
})

describe('a <doop-use> that would render nothing', () => {
  it('takes an unclosed one as empty, says so, and still expands the ones after it', async () => {
    const canvasId = await canvasWith({
      Header: '<header class="hd"><b data-doop-prop="brand">Keep</b></header>',
      Footer: '<footer class="ft"><small data-doop-prop="note">© Keep</small></footer>',
    })
    const { html, notes } = write(
      canvasId,
      '<doop-use component="Header" brand="Acme"><main>Body</main><doop-use component="Footer" note="© Acme"></doop-use>',
    )
    expect(html).toContain('>Acme</b>')
    expect(html).toContain('>© Acme</small>')
    expect(html).toContain('<main>Body</main>')
    expect(html).not.toContain('<doop-use')
    expect(notes).toEqual([expect.stringContaining('<doop-use component="Header"> was never closed')])
  })

  it('leaves an open one alone mid-stream, until the stream is done', async () => {
    const canvasId = await canvasWith({ Header: '<header class="hd"><b data-doop-prop="brand">Keep</b></header>' })
    const frame = actions.createFrame(canvasId, { name: 'Stream' }, agent)!
    actions.appendFrameHtml(frame.id, '<html><head></head><body><doop-use component="Header" brand="Acme">', agent, {
      start: true,
    })
    expect(store.getFrame(frame.id)!.html).toContain('<doop-use component="Header"')
    expect(componentWriteNotes(store.getFrame(frame.id)!)).toEqual([])
    actions.appendFrameHtml(frame.id, '</doop-use></body></html>', agent, { done: true })
    expect(store.getFrame(frame.id)!.html).toContain('>Acme</b>')
    expect(componentWriteNotes(store.getFrame(frame.id)!)).toEqual([])
  })

  it('places an unclosed one in a saved html override too, and expands what follows it there', async () => {
    const { contextFor } = await import('../server/components.ts')
    const { renderInstance } = await import('../server/componentEngine.ts')
    const canvasId = await canvasWith({
      Card: '<article class="card"><div data-doop-slot="body"></div></article>',
      Badge: '<span class="badge" data-doop-prop="label">New</span>',
    })
    const card = store.getComponents(canvasId).find((component) => component.name === 'Card')!
    const slotKey =
      /data-doop-slot="body"[^>]*data-doop-part="([^"]+)"|data-doop-part="([^"]+)"[^>]*data-doop-slot="body"/.exec(
        card.template,
      )!
    const key = slotKey[1] ?? slotKey[2]!
    /* override html is stored as written, so an unclosed tag in it survives to the render */
    const html = '<doop-use component="Badge" label="One"><doop-use component="Badge" label="Two"></doop-use>'
    const ctx = contextFor(canvasId)
    const rendered = renderInstance(card, card, { parts: { [key]: { html } } }, 'x1', { ctx, stack: [], final: true })!
    const { serializeOuter } = await import('parse5')
    const out = serializeOuter(rendered)
    expect(out).toContain('>One</span>')
    expect(out).toContain('>Two</span>')
    /* the stored override keeps its source in the marker; what renders in the slot is two badges */
    expect(out.split('data-doop-slot="body"')[1]).not.toContain('<doop-use')
    expect(ctx.issues.some((issue) => issue.code === 'unclosed_use')).toBe(true)
  })

  it('reports an empty main that a stream chunk expanded before the stream ended', async () => {
    const canvasId = await canvasWith({ Badge: '<span class="badge" data-doop-prop="label">New</span>' })
    const def = store.getComponents(canvasId).find((component) => component.name === 'Badge')!
    store.saveComponent(canvasId, { ...def, template: '' })
    const frame = actions.createFrame(canvasId, { name: 'Stream' }, agent)!
    actions.appendFrameHtml(frame.id, '<html><head></head><body><doop-use component="Badge"></doop-use>', agent, {
      start: true,
    })
    actions.appendFrameHtml(frame.id, '</body></html>', agent, { done: true })
    expect(componentWriteNotes(store.getFrame(frame.id)!)).toEqual([
      expect.stringContaining('component “Badge” has no markup in its main'),
    ])
  })

  it('says so when the component’s main has no markup', async () => {
    const canvasId = await canvasWith({ Badge: '<span class="badge" data-doop-prop="label">New</span>' })
    const def = store.getComponents(canvasId).find((component) => component.name === 'Badge')!
    store.saveComponent(canvasId, { ...def, template: '' })
    const { notes } = write(canvasId, '<p>Hi <doop-use component="Badge"></doop-use></p>')
    expect(notes).toEqual([expect.stringContaining('component “Badge” has no markup in its main')])
  })
})
