import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CustomFont } from '../shared/fonts'

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
  saveFrameVersion: () => {},
  saveComponent: () => {},
}))

/* the library itself is tested in fontLibrary.test.ts: here, what reaches it */
const added: { scope: unknown; user: { id: string }; fileName: string; size: number }[] = []
vi.mock('../server/fonts.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../server/fonts.ts')>()
  return {
    ...real,
    fontsForCanvas: () => [],
    canUseScope: (scope: { workspaceId?: string }, userId: string) => !scope.workspaceId || userId === 'member',
    addFont: async (scope: unknown, user: { id: string }, buf: Buffer, fileName: string): Promise<CustomFont> => {
      added.push({ scope, user, fileName, size: buf.length })
      return {
        id: 'f1',
        family: 'Oxanium',
        weight: '300',
        style: 'normal',
        format: 'truetype',
        url: 'https://doop.test/a/x.ttf',
        fileName,
        size: buf.length,
        createdAt: 1,
      }
    },
  }
})

const { inlineDataRefusal, newInlineData } = await import('../server/inlineData.ts')
const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { buildMcpServer } = await import('../server/mcp.ts')
const { execTool } = await import('../server/resident.ts')

/**
 * Agent writes that add a base64 data: URI are refused with what to do
 * instead, and a font file goes into the canvas's library through upload_font.
 * Whole writes that leave a <doop-use> open are refused the same way (#528).
 */

const FONT = `data:font/ttf;base64,${'A'.repeat(4000)}`
const PNG = `data:image/png;base64,${'iVBORw0KGgo'.repeat(10)}`
const faceCss = `<style>@font-face{font-family:Oxanium;src:url('${FONT}') format('truetype')}</style>`
const doc = (body: string) => `<!doctype html><html><head>${body}</head><body><h1>Hi</h1></body></html>`
const OPEN_CARD = '<doop-use component="Card"><p>Slot copy</p>'
const openCardDoc = `<!doctype html><html><head></head><body>${OPEN_CARD}</body></html>`

describe('newInlineData', () => {
  it('finds base64 data: URIs of every kind and sizes them', () => {
    expect(newInlineData(faceCss)).toEqual([{ mime: 'font/ttf', bytes: 3000 }])
    expect(newInlineData(`<img src="${PNG}">`)[0]?.mime).toBe('image/png')
    expect(newInlineData(`url(data:application/font-woff2;charset=utf-8;base64,d09GMg==)`)[0]?.mime).toBe(
      'application/font-woff2',
    )
  })

  it('leaves URL-encoded SVG and ordinary URLs alone', () => {
    expect(newInlineData(`background:url("data:image/svg+xml,%3Csvg%3E%3C/svg%3E")`)).toEqual([])
    expect(newInlineData(`<img src="/a/abc.png">`)).toEqual([])
  })

  it('lets a write carry over what the frame already holds', () => {
    expect(newInlineData(faceCss, doc(faceCss))).toEqual([])
    expect(newInlineData(faceCss + `<img src="${PNG}">`, doc(faceCss))).toHaveLength(1)
  })
})

describe('inlineDataRefusal', () => {
  it('says what to do for each kind it found', () => {
    const message = inlineDataRefusal(faceCss + `<img src="${PNG}">`)!
    expect(message).toContain('nothing was written')
    expect(message).toContain('font/ttf, image/png')
    expect(message).toContain('upload_font')
    expect(message).toContain('upload_asset')
  })

  it('points the resident agent at the tools it has', () => {
    const message = inlineDataRefusal(`<img src="${PNG}">`, '', 'resident')!
    expect(message).not.toContain('upload_asset')
    expect(message).toContain('search_images')
  })

  it('is silent for a clean write', () => {
    expect(inlineDataRefusal(doc('<style>h1{color:red}</style>'))).toBeNull()
  })
})

describe('over MCP', () => {
  let client: Client
  let canvasId: string

  beforeEach(async () => {
    actions.wire(
      () => {},
      () => {},
    )
    added.length = 0
    canvasId = store.createCanvas('lean', 'owner').id
    const server = buildMcpServer('Owner', 'owner')
    client = new Client({ name: 'inline-test', version: '1.0.0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(b)
    await client.connect(a)
  })
  afterEach(async () => {
    await client.close()
  })

  const call = async (name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: { agent_name: 'Claude', ...args } })) as {
      isError?: boolean
      content: { type: string; text?: string }[]
    }
    return { isError: !!result.isError, text: result.content.map((part) => part.text ?? '').join('\n') }
  }
  const frames = () => store.getCanvas(canvasId)!.frames

  it('refuses a new frame that inlines a font, and writes nothing', async () => {
    const result = await call('create_frame', { canvas_id: canvasId, name: 'Hero', html: doc(faceCss) })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('upload_font')
    expect(frames()).toHaveLength(0)
  })

  it('refuses an edit or a stream chunk that adds one', async () => {
    await call('create_frame', { canvas_id: canvasId, name: 'Hero', html: doc('') })
    const frameId = frames()[0]!.id
    const edit = await call('edit_frame_html', {
      frame_id: frameId,
      old_str: '<h1>Hi</h1>',
      new_str: `<img src="${PNG}">`,
    })
    expect(edit.isError).toBe(true)
    const chunk = await call('append_frame_html', {
      frame_id: frameId,
      html_chunk: doc(faceCss),
      start: true,
      done: true,
    })
    expect(chunk.isError).toBe(true)
    expect(store.getFrame(frameId)!.html).not.toContain('base64')
  })

  it('refuses a create, set or edit that leaves a <doop-use> open, and writes nothing', async () => {
    const created = await call('create_frame', { canvas_id: canvasId, name: 'Hero', html: openCardDoc })
    expect(created.isError).toBe(true)
    expect(created.text).toContain('<doop-use component="Card"> is opened and never closed')
    expect(frames()).toHaveLength(0)

    await call('create_frame', { canvas_id: canvasId, name: 'Hero', html: doc('') })
    const frameId = frames()[0]!.id
    const before = store.getFrame(frameId)!.html
    const set = await call('set_frame_html', { frame_id: frameId, html: openCardDoc })
    expect(set.isError).toBe(true)
    const edit = await call('edit_frame_html', { frame_id: frameId, old_str: '<h1>Hi</h1>', new_str: OPEN_CARD })
    expect(edit.isError).toBe(true)
    expect(edit.text).toContain('<doop-use component="Card"> is opened and never closed')
    expect(store.getFrame(frameId)!.html).toBe(before)

    /* closed or self-closing, the same edit goes through */
    const closed = await call('edit_frame_html', {
      frame_id: frameId,
      old_str: '<h1>Hi</h1>',
      new_str: `${OPEN_CARD}</doop-use><doop-use component="Card" />`,
    })
    expect(closed.isError).toBe(false)
  })

  const makeCard = async () => {
    const card = await call('create_component', {
      canvas_id: canvasId,
      name: 'Card',
      html: '<article class="card"><div data-doop-slot="body"></div></article>',
      auto_props: false,
    })
    expect(card.isError).toBe(false)
  }

  it('refuses the #528 edit on a frame of real instances, and lets every balanced edit of it through', async () => {
    await makeCard()
    const screen =
      '<!doctype html><html><head></head><body><doop-use component="Card"><p>One</p><doop-use component="Card"><p>Inner</p></doop-use></doop-use><table><tr><td><doop-use component="Card" /></td></tr></table></body></html>'
    await call('create_frame', { canvas_id: canvasId, name: 'Screen', html: screen })
    const frameId = frames().find((frame) => frame.name === 'Screen')!.id
    const read = await call('get_frame', { frame_id: frameId })
    /* the compact form is what an agent edits: instances as <doop-use>, slots as <template> */
    expect(read.text).toContain('<p>Inner</p></template></doop-use>')

    const before = store.getFrame(frameId)!.html
    const dropped = await call('edit_frame_html', {
      frame_id: frameId,
      old_str: '<p>Inner</p></template></doop-use>',
      new_str: '<p>Inner</p></template>',
    })
    expect(dropped.isError).toBe(true)
    expect(dropped.text).toContain('never closed')
    expect(store.getFrame(frameId)!.html).toBe(before)

    const copy = await call('edit_frame_html', {
      frame_id: frameId,
      old_str: '<p>Inner</p>',
      new_str: '<p>Inner, edited</p>',
    })
    expect(copy.isError).toBe(false)
    expect(store.getFrame(frameId)!.html).toContain('Inner, edited')
  })

  it('refuses a stream’s last chunk while a <doop-use> is open, keeps the stream open, and takes it again with the close', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      await makeCard()
      await call('create_frame', { canvas_id: canvasId, name: 'Stream', html: doc('') })
      const frameId = frames().find((frame) => frame.name === 'Stream')!.id
      await call('append_frame_html', {
        frame_id: frameId,
        html_chunk: '<html><head></head><body><doop-use component="Card"><p>slot</p>',
        start: true,
      })
      const streamed = store.getFrame(frameId)!.html
      vi.setSystemTime(Date.now() + 25_000)
      const last = await call('append_frame_html', {
        frame_id: frameId,
        html_chunk: '<h4>after</h4></body></html>',
        done: true,
      })
      expect(last.isError).toBe(true)
      expect(last.text).toContain('<doop-use component="Card"> is opened')
      expect(store.getFrame(frameId)!.html).toBe(streamed)
      /* the refusal counts as the agent at work: the idle sweep 15s on leaves the stream open */
      actions.expireIdleStreams(Date.now() + 15_000)
      expect(actions.isFrameMidStream(frameId)).toBe(true)

      const again = await call('append_frame_html', {
        frame_id: frameId,
        html_chunk: '</doop-use><h4>after</h4></body></html>',
        done: true,
      })
      expect(again.isError).toBe(false)
      expect(actions.isFrameMidStream(frameId)).toBe(false)
      const html = store.getFrame(frameId)!.html
      expect(html.indexOf('<p>slot</p>')).toBeGreaterThan(html.indexOf('<article'))
      expect(html.indexOf('<p>slot</p>')).toBeLessThan(html.indexOf('</article>'))
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads a write as it would be saved: one whole chunk, an escaped one, or onto a frame mid-stream', async () => {
    await makeCard()
    await call('create_frame', { canvas_id: canvasId, name: 'Stream', html: doc('') })
    const frameId = frames().find((frame) => frame.name === 'Stream')!.id
    const designed = store.getFrame(frameId)!.html
    const whole = await call('append_frame_html', {
      frame_id: frameId,
      html_chunk: openCardDoc,
      start: true,
      done: true,
    })
    expect(whole.isError).toBe(true)
    expect(actions.isFrameMidStream(frameId)).toBe(false)
    expect(store.getFrame(frameId)!.html).toBe(designed)

    /* an escaped stream is decoded as it is written, so its close counts */
    const escape = (html: string) => html.replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    await call('append_frame_html', {
      frame_id: frameId,
      html_chunk: escape('<html><head></head><body><doop-use component="Card"><p>slot</p>'),
      start: true,
    })
    const closed = await call('append_frame_html', {
      frame_id: frameId,
      html_chunk: escape('</doop-use></body></html>'),
      done: true,
    })
    expect(closed.isError).toBe(false)
    const decoded = store.getFrame(frameId)!.html
    expect(decoded.indexOf('<p>slot</p>')).toBeGreaterThan(decoded.indexOf('<article'))
    expect(decoded.indexOf('<p>slot</p>')).toBeLessThan(decoded.indexOf('</article>'))
    /* and an escaped whole write that leaves one open is refused like a raw one */
    const escaped = await call('create_frame', { canvas_id: canvasId, name: 'Escaped', html: escape(openCardDoc) })
    expect(escaped.isError).toBe(true)
    expect(frames().some((frame) => frame.name === 'Escaped')).toBe(false)

    /* a frame mid-stream holds its waiting tag: an edit, even one that leaves it alone, would place
       it, so the editor is told the stream is still going rather than to close the stream's tag */
    await call('append_frame_html', {
      frame_id: frameId,
      html_chunk: '<html><head></head><body><h1>Top</h1><doop-use component="Card"><p>slot</p>',
      start: true,
    })
    const streamed = store.getFrame(frameId)!.html
    const edit = await call('edit_frame_html', {
      frame_id: frameId,
      old_str: '<h1>Top</h1>',
      new_str: '<h1>Top!</h1>',
    })
    expect(edit.isError).toBe(true)
    expect(edit.text).toContain('still streaming')
    expect(store.getFrame(frameId)!.html).toBe(streamed)
    expect(actions.isFrameMidStream(frameId)).toBe(true)
    /* a set replaces the whole document, waiting tag and all: a balanced one goes through */
    const set = await call('set_frame_html', { frame_id: frameId, html: doc('') })
    expect(set.isError).toBe(false)
    expect(actions.isFrameMidStream(frameId)).toBe(false)
  })

  const imported = () =>
    actions.createFrame(
      canvasId,
      { name: 'Imported PDF', html: doc(faceCss), width: 400, height: 300 },
      actions.resolveActor({ name: 'Kevin', kind: 'user' }),
    )!

  it('lets a rewrite keep data the frame already had', async () => {
    const frame = imported()
    const result = await call('set_frame_html', { frame_id: frame.id, html: doc(faceCss).replace('Hi', 'Hello') })
    expect(result.isError).toBe(false)
    expect(store.getFrame(frame.id)!.html).toContain('Hello')
  })

  it('catches a URI split across stream chunks', async () => {
    const frame = actions.createFrame(
      canvasId,
      { name: 'Hero', html: doc(''), width: 400, height: 300 },
      actions.resolveActor({ name: 'Kevin', kind: 'user' }),
    )!
    const [head, tail] = [faceCss.slice(0, faceCss.indexOf(';base') + 5), faceCss.slice(faceCss.indexOf(';base') + 5)]
    expect(
      (await call('append_frame_html', { frame_id: frame.id, html_chunk: `<html><head>${head}`, start: true })).isError,
    ).toBe(false)
    const second = await call('append_frame_html', {
      frame_id: frame.id,
      html_chunk: `${tail}</head></html>`,
      done: true,
    })
    expect(second.isError).toBe(true)
    expect(second.text).toContain('font/ttf')
  })

  it('lets a later chunk of a rework carry over what the frame had before the stream', async () => {
    const frame = imported()
    expect(
      (await call('append_frame_html', { frame_id: frame.id, html_chunk: '<!doctype html><html>', start: true }))
        .isError,
    ).toBe(false)
    const later = await call('append_frame_html', {
      frame_id: frame.id,
      html_chunk: `<head>${faceCss}</head><body>Again</body></html>`,
      done: true,
    })
    expect(later.isError).toBe(false)
    expect(store.getFrame(frame.id)!.html).toContain('Again')
  })

  it('catches a URI an edit completes across its edges', async () => {
    const frame = actions.createFrame(
      canvasId,
      { name: 'Hero', html: doc('<style>i{background:url(data:image/png;X)}</style>'), width: 400, height: 300 },
      actions.resolveActor({ name: 'Kevin', kind: 'user' }),
    )!
    const edit = await call('edit_frame_html', { frame_id: frame.id, old_str: ';X)', new_str: ';base64,iVBORw0KGgo)' })
    expect(edit.isError).toBe(true)
  })

  it('streams past a component whose image expands into the frame', async () => {
    ;(await import('../server/componentActions.ts')).createComponentFromHtml(
      canvasId,
      { name: 'Badge', html: `<div><img src="${PNG}"></div>` },
      actions.resolveActor({ name: 'Kevin', kind: 'user' }),
    )
    const frame = actions.createFrame(
      canvasId,
      { name: 'Page', html: doc(''), width: 400, height: 300 },
      actions.resolveActor({ name: 'Kevin', kind: 'user' }),
    )!
    const first = await call('append_frame_html', {
      frame_id: frame.id,
      html_chunk: '<!doctype html><html><body><doop-use component="Badge"></doop-use>',
      start: true,
    })
    expect(first.isError).toBe(false)
    expect(store.getFrame(frame.id)!.html).toContain(';base64,')
    const second = await call('append_frame_html', {
      frame_id: frame.id,
      html_chunk: '<p>More</p></body></html>',
      done: true,
    })
    expect(second.isError).toBe(false)
  })

  it('lets a component keep a picture its template already has', async () => {
    const badge = `<div><img src="${PNG}"></div>`
    const def = (await import('../server/componentActions.ts')).createComponentFromHtml(
      canvasId,
      { name: 'Badge', html: badge },
      actions.resolveActor({ name: 'Kevin', kind: 'user' }),
    ).component
    const result = await call('update_component', {
      canvas_id: canvasId,
      component: def.name,
      html: badge.replace('<div>', '<div class="b">'),
    })
    expect(result.text).not.toContain('base64 data: URI')
  })

  it('refuses a component that inlines a picture', async () => {
    const result = await call('create_component', {
      canvas_id: canvasId,
      name: 'Badge',
      html: `<div><img src="${PNG}"></div>`,
    })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('upload_asset')
  })

  it('adds a font to the canvas owner’s library and says how to use it', async () => {
    const data = Buffer.from('font bytes').toString('base64')
    const result = await call('upload_font', { canvas_id: canvasId, data, file_name: 'Oxanium-Light.ttf' })
    expect(result.isError).toBe(false)
    expect(JSON.parse(result.text)).toMatchObject({ family: 'Oxanium', css: 'font-family: "Oxanium", sans-serif;' })
    expect(added).toEqual([
      {
        scope: { personal: true },
        user: expect.objectContaining({ id: 'owner' }),
        fileName: 'Oxanium-Light.ttf',
        size: 10,
      },
    ])
  })

  it('hands out a font ticket whose URL keeps the file name', async () => {
    const result = await call('upload_font', { canvas_id: canvasId, local_file: true })
    expect(JSON.parse(result.text).command).toMatch(/curl -sS -T ".+" .+\/u\/[\w-]+\/$/)
  })

  it('will not add to a workspace library for someone outside it', async () => {
    const workspaceCanvas = store.createCanvas('team', 'owner', 'ws1').id
    const result = await call('upload_font', { canvas_id: workspaceCanvas, data: 'AAAA' })
    /* the owner may edit the canvas, but is not a member of its workspace in this mock */
    expect(result.isError).toBe(true)
    expect(added).toEqual([])
  })
})

describe('the resident agent', () => {
  const run = () => ({
    mutatedFrames: new Set<string>(),
    sourceFrames: new Set<string>(),
    verificationFrames: new Set<string>(),
    verifiedFrames: new Set<string>(),
    seenVerified: new Set<string>(),
    rewriteDrafts: new Map<string, string>(),
    vision: false,
    imagesGenerated: 0,
    repliedThreads: new Set<string>(),
    awaitingThreads: new Set<string>(),
    tokenWrites: 0,
    arrangeWrites: 0,
  })
  const actor = () => actions.resolveActor({ name: 'Doop', kind: 'agent' })
  const call = (name: string, input: unknown) => ({ type: 'tool_use' as const, id: 't1', name, input })

  it('is refused on create, set, edit and rewrite chunks', async () => {
    const canvasId = store.createCanvas('resident', 'owner').id
    const state = run()
    const created = await execTool(
      call('create_frame', { name: 'Hero', width: 400, height: 300, html: doc(faceCss) }),
      canvasId,
      actor(),
      state,
    )
    expect(created.is_error).toBe(true)
    expect(String(created.content)).toContain('upload_font')

    const frameId = actions.createFrame(canvasId, { name: 'Hero', html: doc(''), width: 400, height: 300 }, actor())!.id
    for (const [name, input] of [
      ['set_frame_html', { frame_id: frameId, html: doc(faceCss) }],
      ['edit_frame_html', { frame_id: frameId, find: '<h1>Hi</h1>', replace: `<img src="${PNG}">` }],
    ] as const) {
      const result = await execTool(call(name, input), canvasId, actor(), state)
      expect(result.is_error, name).toBe(true)
    }
    await execTool(call('begin_frame_rewrite', { frame_id: frameId }), canvasId, actor(), state)
    const chunk = await execTool(
      call('append_frame_rewrite', { frame_id: frameId, chunk: doc(faceCss) }),
      canvasId,
      actor(),
      state,
    )
    expect(chunk.is_error).toBe(true)
    expect(state.rewriteDrafts.get(frameId)).toBe('')

    /* split across two chunks: the second completes it */
    const cut = faceCss.indexOf(';base') + 5
    const first = await execTool(
      call('append_frame_rewrite', { frame_id: frameId, chunk: `<html><head>${faceCss.slice(0, cut)}` }),
      canvasId,
      actor(),
      state,
    )
    expect(first.is_error).toBeUndefined()
    const second = await execTool(
      call('append_frame_rewrite', { frame_id: frameId, chunk: `${faceCss.slice(cut)}</head></html>` }),
      canvasId,
      actor(),
      state,
    )
    expect(second.is_error).toBe(true)
  })

  it('is refused on create, set, edit and a rewrite commit that leave a <doop-use> open', async () => {
    const canvasId = store.createCanvas('resident', 'owner').id
    const state = run()
    const created = await execTool(
      call('create_frame', { name: 'Hero', width: 400, height: 300, html: openCardDoc }),
      canvasId,
      actor(),
      state,
    )
    expect(created.is_error).toBe(true)
    expect(String(created.content)).toContain('never closed')
    expect(store.getCanvas(canvasId)!.frames).toHaveLength(0)

    const frameId = actions.createFrame(canvasId, { name: 'Hero', html: doc(''), width: 400, height: 300 }, actor())!.id
    const before = store.getFrame(frameId)!.html
    for (const [name, input] of [
      ['set_frame_html', { frame_id: frameId, html: openCardDoc }],
      ['edit_frame_html', { frame_id: frameId, find: '<h1>Hi</h1>', replace: OPEN_CARD }],
    ] as const) {
      const result = await execTool(call(name, input), canvasId, actor(), state)
      expect(result.is_error, name).toBe(true)
    }
    /* a chunk is partial by design: the open tag is refused at the commit, once the draft is whole */
    await execTool(call('begin_frame_rewrite', { frame_id: frameId }), canvasId, actor(), state)
    const chunk = await execTool(
      call('append_frame_rewrite', { frame_id: frameId, chunk: openCardDoc }),
      canvasId,
      actor(),
      state,
    )
    expect(chunk.is_error).toBeUndefined()
    const commit = await execTool(call('commit_frame_rewrite', { frame_id: frameId }), canvasId, actor(), state)
    expect(commit.is_error).toBe(true)
    expect(store.getFrame(frameId)!.html).toBe(before)
  })
})
