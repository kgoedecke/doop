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
const person: Actor = { name: 'Kevin', kind: 'user', color: '#3c7be5' }
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

function write(canvasId: string, body: string, by: Actor = agent) {
  const frame = actions.createFrame(canvasId, { name: 'Screen', html: page(body) }, by)!
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
  it('takes an unclosed one from a person as empty, says so, and still expands the ones after it', async () => {
    const canvasId = await canvasWith({
      Header: '<header class="hd"><b data-doop-prop="brand">Keep</b></header>',
      Footer: '<footer class="ft"><small data-doop-prop="note">© Keep</small></footer>',
    })
    const { html, notes } = write(
      canvasId,
      '<doop-use component="Header" brand="Acme"><main>Body</main><doop-use component="Footer" note="© Acme"></doop-use>',
      person,
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
    const rendered = renderInstance(card, card, { parts: { [key]: { html } } }, 'x1', { ctx, stack: [] })!
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

describe('an agent write that leaves a <doop-use> open (#528)', () => {
  const refusal = async (run: () => unknown) => {
    const { WriteRefusedError } = await import('../server/writeRefusal.ts')
    try {
      await run()
    } catch (error) {
      if (error instanceof WriteRefusedError) return error.message
      throw error
    }
    return null
  }
  const partKey = (template: string) => {
    const slot =
      /data-doop-slot="body"[^>]*data-doop-part="([^"]+)"|data-doop-part="([^"]+)"[^>]*data-doop-slot="body"/.exec(
        template,
      )!
    return slot[1] ?? slot[2]!
  }

  it('names each <doop-use> a whole write would leave open, and only those', async () => {
    const { unclosedUses } = await import('../server/componentEngine.ts')
    expect(
      unclosedUses(
        '<doop-use component="Card"><p>a</p><doop-use component="Badge" label="x"></doop-use><doop-use component="Nav" />',
      ),
    ).toEqual(['Card'])
    /* a tag in a script, a style or a comment is not a tag, nor is one inside a closed use's slot,
       nor a custom element whose name starts the same */
    expect(
      unclosedUses('<script>const t = "<doop-use component=\'Card\'>"</script><!-- <doop-use component="Nav"> -->'),
    ).toEqual([])
    expect(
      unclosedUses(
        '<doop-use component="Card"><p>x</p><!-- <doop-use component="Nav"> --><textarea><doop-use component="Nav"></textarea><doop-user-chip></doop-user-chip></doop-use>',
      ),
    ).toEqual([])
    /* a custom element named like a stylesheet is not one: what follows it is read */
    expect(unclosedUses('<style-chip>x</style-chip><doop-use component="Card"></doop-use>')).toEqual([])
    expect(unclosedUses('<style-chip>x</style-chip><doop-use component="Card"><p>y</p>')).toEqual(['Card'])
    /* a tag whose end cannot be read (a quote never closed) stops the reader: it counts as open */
    expect(
      unclosedUses(
        '<doop-use component="A"><doop-use component=B label=it\'s>x</doop-use><doop-use component="C"><p>y</p>',
      ),
    ).toEqual(['A'])
    /* the component attribute itself, quoted or not */
    expect(unclosedUses('<doop-use data-component="x" component="Card">')).toEqual(['Card'])
    expect(unclosedUses('<doop-use component=Card>')).toEqual(['Card'])
  })

  it('words the refusal by where the tag is written', async () => {
    const { unclosedUseRefusal } = await import('../server/components.ts')
    const two = unclosedUseRefusal(['Card', 'Hero'], 'frame')
    expect(two).toContain(
      'Refused, nothing was written: <doop-use component="Card">, <doop-use component="Hero"> are opened and never closed',
    )
    expect(two).toContain('Saved, each would be placed with no slot content')
    expect(two).toContain('Close each with </doop-use> where its content ends')
    expect(unclosedUseRefusal(['Card'], 'frame')).toContain('Saved, it would be placed')
    expect(unclosedUseRefusal([''], 'frame')).toContain('a <doop-use> is opened')
    expect(unclosedUseRefusal(['Card'], 'template')).toContain('Saved, it would be closed where its parent ends')
  })

  it('refuses an agent’s frame write and writes nothing; closed or self-closing it goes through', async () => {
    const canvasId = await canvasWith({ Card: '<article class="card"><div data-doop-slot="body"></div></article>' })
    const screens = () => store.getCanvas(canvasId)!.frames.filter((frame) => frame.name === 'Screen')
    expect(await refusal(() => write(canvasId, '<doop-use component="Card"><p>Slot copy</p>'))).toContain(
      '<doop-use component="Card"> is opened and never closed',
    )
    /* an escaped write is read as it is saved, decoded */
    const escaped = page('<doop-use component="Card"><p>x</p>').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    expect(await refusal(() => actions.createFrame(canvasId, { name: 'Screen', html: escaped }, agent))).toContain(
      'never closed',
    )
    /* a tag that cannot be read to its end would be saved as text */
    expect(await refusal(() => write(canvasId, '<doop-use component="Card" label="x>'))).toContain('never closed')
    expect(screens()).toHaveLength(0)

    const { html, notes } = write(
      canvasId,
      '<doop-use component="Card"><p>x</p></doop-use><doop-use component="Card" />',
    )
    expect(notes).toEqual([])
    expect(html).not.toMatch(/<doop-use[\s/>]/)
  })

  it('reads the markup a use’s overrides carry, which renders on its own', async () => {
    const canvasId = await canvasWith({
      Card: '<article class="card"><div data-doop-slot="body"></div></article>',
      Badge: '<span class="badge" data-doop-prop="label">New</span>',
    })
    const key = partKey(store.getComponents(canvasId).find((component) => component.name === 'Card')!.template)
    const open = JSON.stringify({ [key]: { slot: '<doop-use component="Badge"><p>x</p>' } })
    /* single-quoted JSON, and the double-quoted form get_frame writes, its quotes as &quot; */
    for (const attr of [`'${open}'`, `"${open.replaceAll('"', '&quot;')}"`]) {
      expect(
        await refusal(() => write(canvasId, `<doop-use component="Card" overrides=${attr}></doop-use>`)),
      ).toContain('<doop-use component="Badge"> is opened and never closed')
    }
    /* inside another use's slot too */
    const nested = `<doop-use component="Card"><doop-use component="Card" overrides='${open}'></doop-use></doop-use>`
    expect(await refusal(() => write(canvasId, nested))).toContain('<doop-use component="Badge">')
    const closed = JSON.stringify({ [key]: { slot: '<doop-use component="Badge"></doop-use>' } })
    expect(await refusal(() => write(canvasId, `<doop-use component="Card" overrides='${closed}'></doop-use>`))).toBe(
      null,
    )
  })

  it('expands a use whose slot holds a tag that only looks like one, its content inside it', async () => {
    const canvasId = await canvasWith({ Card: '<article class="card"><div data-doop-slot="body"></div></article>' })
    const { html, notes } = write(
      canvasId,
      '<doop-use component="Card"><p>One</p><!-- </doop-use> --><script>const t = "</doop-use>"</script><style-chip>s</style-chip><doop-user-chip>Two</doop-user-chip></doop-use><h4>after</h4>',
    )
    expect(notes).toEqual([])
    const card = html.slice(html.indexOf('<article'), html.indexOf('</article>'))
    expect(card).toContain('<p>One</p>')
    expect(card).toContain('<doop-user-chip>Two</doop-user-chip>')
    expect(html.indexOf('<h4>after</h4>')).toBeGreaterThan(html.indexOf('</article>'))
    expect(html).not.toMatch(/<doop-use[\s/>]/)
  })

  it('refuses a component whose template leaves a <doop-use> open, made or updated, and an override', async () => {
    const canvasId = await canvasWith({ Card: '<article class="card"><div data-doop-slot="body"></div></article>' })
    const context = {
      canvas: store.getCanvas(canvasId)!,
      actor: agent,
      canRead: () => true,
      canEdit: () => true,
      userId: undefined,
      readableCanvases: () => [],
    }
    const made = await runComponentTool(
      'create_component',
      { name: 'Panel', html: '<section><doop-use component="Card"><p>slot</p><h3>after</h3></section>', css: '' },
      context,
    )
    expect(made).toMatchObject({
      ok: false,
      error: expect.stringContaining('<doop-use component="Card"> is opened and never closed'),
    })
    expect(store.getComponents(canvasId).map((component) => component.name)).toEqual(['Card'])

    /* each entry of a batch stands alone: the open one is refused, the closed one is made */
    const batch = await runComponentTool(
      'create_components',
      {
        components: [
          { name: 'Open', html: '<div><doop-use component="Card"><p>x</p></div>' },
          { name: 'Closed', html: '<div><doop-use component="Card"><p>x</p></doop-use></div>' },
        ],
      },
      context,
    )
    expect(batch.ok).toBe(true)
    expect(JSON.stringify(batch)).toContain('never closed')
    expect(store.getComponents(canvasId).map((component) => component.name)).toEqual(['Card', 'Closed'])

    const closed = store.getComponents(canvasId).find((component) => component.name === 'Closed')!
    const close = closed.template.lastIndexOf('</doop-use>')
    expect(close).toBeGreaterThan(-1)
    /* the edit drops the close: checked on the template as it would stand, a dry run included */
    const dropClose = {
      component: 'Closed',
      find: closed.template.slice(close),
      replace: closed.template.slice(close + '</doop-use>'.length),
    }
    for (const input of [{ ...dropClose, dry_run: true }, dropClose]) {
      const updated = await runComponentTool('update_component', input, context)
      expect(updated).toMatchObject({ ok: false, error: expect.stringContaining('closed where its parent ends') })
    }

    /* an instance override's markup expands on its own: a slot left open is refused too */
    const frame = actions.createFrame(
      canvasId,
      { name: 'Screen', html: page('<doop-use component="Card"><p>x</p></doop-use>') },
      agent,
    )!
    const key = partKey(store.getComponents(canvasId).find((component) => component.name === 'Card')!.template)
    const instanceId =
      /data-doop-instance="[^"]+"[^>]*data-doop-id="([^"]+)"|data-doop-id="([^"]+)"[^>]*data-doop-instance=/.exec(
        store.getFrame(frame.id)!.html,
      )!
    const before = store.getFrame(frame.id)!.html
    const changed = await runComponentTool(
      'update_instances',
      {
        frame_id: frame.id,
        instances: [
          {
            instance_id: instanceId[1] ?? instanceId[2],
            overrides: { [key]: { slot: '<doop-use component="Card"><p>nested</p>' } },
          },
        ],
      },
      context,
    )
    expect(changed).toMatchObject({ ok: false, error: expect.stringContaining('Saved, it would be placed') })
    expect(store.getFrame(frame.id)!.html).toBe(before)
    expect(store.getComponents(canvasId).find((component) => component.name === 'Closed')!.template).toBe(
      closed.template,
    )
  })
})
