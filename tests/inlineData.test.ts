import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CustomFont } from '../shared/fonts'

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
const { execTool, newRunState } = await import('../server/resident.ts')

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
const escape = (html: string) => html.replaceAll('<', '&lt;').replaceAll('>', '&gt;')

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

describe('base64 that is not a data: URI', () => {
  /* what a packed bundle looks like: gzip's header as base64, then the payload */
  const packed = (chars: number) => `H4sI${'Ab3+/9zQ'.repeat(Math.ceil(chars / 8)).slice(0, chars - 4)}`
  const loader = (payload: string) =>
    `<script>const bytes=Uint8Array.from(atob("${payload}"),x=>x.charCodeAt(0))</script>`

  it('finds a long block of it in a script, by its decoded size', () => {
    expect(newInlineData(loader(packed(8000)))).toEqual([{ mime: 'embedded/base64', bytes: 6000 }])
    /* the URL-safe alphabet, and padding after it */
    expect(newInlineData(`<script>const d="${'a-b_'.repeat(2000)}=="</script>`)).toHaveLength(1)
  })

  it('leaves alone what a design writes without spaces', () => {
    /* an integrity hash, a signed URL, a long id, a path */
    const hash = `<script src="/x.js" integrity="sha384-${'oqVuAfXRKap7fdgcCY5uykM6'.repeat(4)}"></script>`
    const url = `<img src="https://cdn.example/a/${'f'.repeat(3000)}.png?token=${'A'.repeat(900)}&sig=${'b'.repeat(900)}">`
    const path = `<svg><path d="${'M10 20L30 40C50,60 70,80 90,100Z'.repeat(400)}"/></svg>`
    const prose = `<p>${'word '.repeat(4000)}</p>`
    for (const html of [hash, url, path, prose, loader(packed(4095))]) expect(newInlineData(html)).toEqual([])
  })

  it('counts a data: URI once, however long its payload', () => {
    const big = `<img src="data:image/png;base64,${packed(9000)}">`
    expect(newInlineData(big)).toEqual([{ mime: 'image/png', bytes: 6750 }])
    expect(newInlineData(big + loader(packed(8000)))).toHaveLength(2)
  })

  it('takes `;base64,` for a label only on a real data: URI', () => {
    /* the prefix kept apart from `data:`, to be joined when the page runs */
    const split = `<script>const png="image/png;base64,${packed(8000)}";img.src="data:"+png</script>`
    expect(newInlineData(split)).toEqual([{ mime: 'embedded/base64', bytes: 6000 }])
  })

  it('lets a block the frame already holds be carried over, and refuses one more', () => {
    const held = loader(packed(8000))
    expect(newInlineData(held, doc(held))).toEqual([])
    const more = `H4sI${'Zz9+/0xQ'.repeat(1000)}`
    expect(newInlineData(held + loader(more), doc(held))).toEqual([{ mime: 'embedded/base64', bytes: 6003 }])
  })

  it('reads megabytes of it in one pass', () => {
    const html = loader(packed(6_000_000)) + `<p>${'Ab3+ '.repeat(200_000)}</p>`
    const started = performance.now()
    expect(newInlineData(html)).toEqual([{ mime: 'embedded/base64', bytes: 4_500_000 }])
    /* a loose bound: one pass takes milliseconds, walking each run from every character minutes */
    expect(performance.now() - started).toBeLessThan(10_000)
  })

  it('sees a block wrapped over lines or written as joined strings', () => {
    const lines = (width: number) => packed(8000).match(new RegExp(`.{1,${width}}`, 'g'))!
    /* `base64 file` wraps at 76 columns, PEM at 64: atob reads through the line ends */
    expect(newInlineData(`<script>const d=atob(\`${lines(76).join('\n')}\`)</script>`)).toEqual([
      { mime: 'embedded/base64', bytes: 6000 },
    ])
    expect(newInlineData(`<script>const d="${lines(64).join('\\\n')}"</script>`)).toHaveLength(1)
    expect(newInlineData(`<script>const d="${lines(1000).join('" +\n  "')}"</script>`)).toHaveLength(1)
    /* words, however many, are not lines of base64 */
    expect(newInlineData(`<p>${'supercalifragilistic expialidocious '.repeat(400)}</p>`)).toEqual([])
  })

  it('lets a block the frame holds come back smaller or in pieces, and counts what was added to it', () => {
    const block = packed(40_000)
    const held = doc(loader(block))
    /* a span cut out of its middle, and one cut from each end */
    expect(newInlineData(loader(block.slice(0, 15_000) + block.slice(25_000)), held)).toEqual([])
    expect(newInlineData(loader(block.slice(3000, 30_000)), held)).toEqual([])
    /* 5,000 characters of something else put into it */
    const grown = block.slice(0, 20_000) + 'Zz9+/0xQ'.repeat(625) + block.slice(20_000)
    const [added] = newInlineData(loader(grown), held)
    expect(added?.mime).toBe('embedded/base64')
    expect(added!.bytes).toBeGreaterThanOrEqual(3072)
    expect(added!.bytes).toBeLessThan(6000)
    /* and a block that only starts like the one held is all new */
    expect(newInlineData(loader(block.slice(0, 300) + 'Zz9+/0xQ'.repeat(1000)), held)).toHaveLength(1)
  })

  it('says what it found and what to do instead', () => {
    const message = inlineDataRefusal(loader(packed(8000)) + loader(packed(400_000)))!
    expect(message).toContain('nothing was written')
    expect(message).toContain('2 blocks of base64 text (299 KB)')
    expect(message).toContain('<script src>')
    /* it stands alone: the tools for a picture or a font are named here, not "as above" */
    expect(message).toContain('upload_asset')
    expect(message).toContain('upload_font')
    expect(message).not.toContain('as above')
    expect(message).toContain('each screen in a frame of its own')
    expect(message).toContain('without the base64.')
    const both = inlineDataRefusal(loader(packed(8000)) + `<img src="${PNG}">`)!
    expect(both).toContain('1 base64 data: URI (image/png')
    expect(both).toContain('and 1 block of base64 text (6 KB)')
    expect(both).toContain('without the data: URIs and the base64 blocks.')
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

  const makeComponent = async (name: string, html: string) => {
    const made = await call('create_component', { canvas_id: canvasId, name, html, auto_props: false })
    expect(made.isError).toBe(false)
  }
  const makeCard = () => makeComponent('Card', '<article class="card"><div data-doop-slot="body"></div></article>')

  it('refuses a create, set or edit that leaves a <doop-use> open, and writes nothing', async () => {
    const created = await call('create_frame', { canvas_id: canvasId, name: 'Hero', html: openCardDoc })
    expect(created.isError).toBe(true)
    expect(created.text).toContain(
      'Refused, nothing was written: <doop-use component="Card"> is opened and never closed',
    )
    expect(frames()).toHaveLength(0)

    /* a closed use whose overrides carry markup that leaves one open, which renders on its own */
    await makeCard()
    await makeComponent('Badge', '<span class="badge">New</span>')
    const card = store.getComponents(canvasId).find((component) => component.name === 'Card')!
    const key = /data-doop-part="([^"]+)"[^>]*data-doop-slot|data-doop-slot="body"[^>]*data-doop-part="([^"]+)"/.exec(
      card.template,
    )!
    const overrides = JSON.stringify({ [key[1] ?? key[2]!]: { html: '<doop-use component="Badge"><p>slot</p>' } })
    const carried = await call('create_frame', {
      canvas_id: canvasId,
      name: 'Hero',
      html: doc(`<doop-use component="Card" overrides='${overrides}'></doop-use>`),
    })
    expect(carried.isError).toBe(true)
    expect(carried.text).toContain('<doop-use component="Badge"> is opened and never closed')
    expect(frames().filter((frame) => frame.name === 'Hero')).toHaveLength(0)

    await call('create_frame', { canvas_id: canvasId, name: 'Hero', html: doc('') })
    const frameId = frames().find((frame) => frame.name === 'Hero')!.id
    const before = store.getFrame(frameId)!.html
    const set = await call('set_frame_html', { frame_id: frameId, html: openCardDoc })
    expect(set.isError).toBe(true)
    const edit = await call('edit_frame_html', { frame_id: frameId, old_str: '<h1>Hi</h1>', new_str: OPEN_CARD })
    expect(edit.isError).toBe(true)
    /* refused before it runs: the replacement opens a tag it does not close (#684) */
    expect(edit.text).toContain('new_str opens 1 more <doop-use>')
    expect(edit.text).not.toContain('<doop-use component="Card"> is opened and never closed')
    expect(store.getFrame(frameId)!.html).toBe(before)

    /* closed or self-closing, the same edit goes through */
    const closed = await call('edit_frame_html', {
      frame_id: frameId,
      old_str: '<h1>Hi</h1>',
      new_str: `${OPEN_CARD}</doop-use><doop-use component="Card" />`,
    })
    expect(closed.isError).toBe(false)
  })

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
    expect(dropped.text).toContain('more <doop-use> than it closes')
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
      await (await import('../server/canvasWrites.ts')).settleIdleStreams(Date.now() + 15_000)
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

  it('reads a stream as it would be saved: one whole chunk, or an escaped one', async () => {
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
  })

  /* a closed use whose overrides hold a use left open: the override is whole, so nothing closes it */
  const openOverride = async () => {
    await makeCard()
    await makeComponent('Badge', '<span class="badge">New</span>')
    const card = store.getComponents(canvasId).find((component) => component.name === 'Card')!
    const key = /data-doop-part="([^"]+)"[^>]*data-doop-slot|data-doop-slot="body"[^>]*data-doop-part="([^"]+)"/.exec(
      card.template,
    )!
    const overrides = JSON.stringify({ [key[1] ?? key[2]!]: { slot: '<doop-use component="Badge"><p>x</p>' } })
    return `<doop-use component="Card" overrides='${overrides}'></doop-use>`
  }

  it('refuses a stream chunk whose overrides leave a <doop-use> open, at once, and keeps the stream open', async () => {
    const use = await openOverride()
    await call('create_frame', { canvas_id: canvasId, name: 'Stream', html: doc('') })
    const frameId = frames().find((frame) => frame.name === 'Stream')!.id
    const designed = store.getFrame(frameId)!.html
    /* one whole chunk */
    const whole = await call('append_frame_html', {
      frame_id: frameId,
      html_chunk: `<html><head></head><body>${use}</body></html>`,
      start: true,
      done: true,
    })
    expect(whole.isError).toBe(true)
    expect(whole.text).toContain('<doop-use component="Badge"> is opened and never closed')
    expect(store.getFrame(frameId)!.html).toBe(designed)
    expect(actions.isFrameMidStream(frameId)).toBe(false)

    /* a middle chunk: refused before it is saved, the stream still open for it to come again */
    await call('append_frame_html', {
      frame_id: frameId,
      html_chunk: '<html><head></head><body><h1>Top</h1>',
      start: true,
    })
    const streamed = store.getFrame(frameId)!.html
    const middle = await call('append_frame_html', { frame_id: frameId, html_chunk: use })
    expect(middle.isError).toBe(true)
    expect(middle.text).toContain('<doop-use component="Badge">')
    expect(store.getFrame(frameId)!.html).toBe(streamed)
    expect(actions.isFrameMidStream(frameId)).toBe(true)

    /* a use of its own left open mid-stream is fine: a later chunk closes it */
    const open = await call('append_frame_html', {
      frame_id: frameId,
      html_chunk: '<doop-use component="Card"><p>slot</p>',
    })
    expect(open.isError).toBe(false)
    const done = await call('append_frame_html', {
      frame_id: frameId,
      html_chunk: '</doop-use></body></html>',
      done: true,
    })
    expect(done.isError).toBe(false)
    const html = store.getFrame(frameId)!.html
    expect(html.indexOf('<p>slot</p>')).toBeGreaterThan(html.indexOf('<article'))
    expect(html.indexOf('<p>slot</p>')).toBeLessThan(html.indexOf('</article>'))
  })

  it('refuses a create or set whose overrides leave a <doop-use> open', async () => {
    const use = await openOverride()
    const created = await call('create_frame', { canvas_id: canvasId, name: 'Hero', html: doc(use) })
    expect(created.isError).toBe(true)
    expect(created.text).toContain('<doop-use component="Badge"> is opened and never closed')
    expect(frames().filter((frame) => frame.name === 'Hero')).toHaveLength(0)
    await call('create_frame', { canvas_id: canvasId, name: 'Hero', html: doc('') })
    const frameId = frames().find((frame) => frame.name === 'Hero')!.id
    const before = store.getFrame(frameId)!.html
    const set = await call('set_frame_html', { frame_id: frameId, html: doc(use) })
    expect(set.isError).toBe(true)
    expect(store.getFrame(frameId)!.html).toBe(before)
  })

  it('lets the streaming agent edit its frame mid-stream, and tells another agent to wait or replace it', async () => {
    await makeCard()
    await call('create_frame', { canvas_id: canvasId, name: 'Stream', html: doc('') })
    const frameId = frames().find((frame) => frame.name === 'Stream')!.id
    await call('append_frame_html', {
      frame_id: frameId,
      html_chunk: '<html><head></head><body><h1>Top</h1><doop-use component="Card"><p>slot</p>',
      start: true,
    })
    const streamed = store.getFrame(frameId)!.html
    /* another agent's edit would place the stream's waiting tag: refused, whatever it changes */
    const other = await call('edit_frame_html', {
      agent_name: 'Codex',
      frame_id: frameId,
      old_str: '<h1>Top</h1>',
      new_str: '<h1>Top!</h1>',
    })
    expect(other.isError).toBe(true)
    expect(other.text).toContain('Claude is streaming this frame')
    expect(other.text).toContain('set_frame_html')
    expect(store.getFrame(frameId)!.html).toBe(streamed)
    expect(actions.isFrameMidStream(frameId)).toBe(true)

    /* the streaming agent's own edit is not a whole write: its next chunks close the tag */
    const own = await call('edit_frame_html', { frame_id: frameId, old_str: '<h1>Top</h1>', new_str: '<h1>Top!</h1>' })
    expect(own.isError).toBe(false)
    expect(store.getFrame(frameId)!.html).toContain('<h1>Top!</h1>')

    /* a set replaces the whole document, waiting tag and all: from any agent, a balanced one goes through */
    await call('append_frame_html', {
      frame_id: frameId,
      html_chunk: '<html><head></head><body><doop-use component="Card"><p>slot</p>',
      start: true,
    })
    const set = await call('set_frame_html', { agent_name: 'Codex', frame_id: frameId, html: doc('') })
    expect(set.isError).toBe(false)
    expect(actions.isFrameMidStream(frameId)).toBe(false)
  })

  it('leaves a person’s stream of the same markup a note', async () => {
    await call('create_frame', { canvas_id: canvasId, name: 'Stream', html: doc('') })
    const frameId = frames().find((frame) => frame.name === 'Stream')!.id
    const person = actions.resolveActor({ name: 'Kevin', kind: 'user' })
    actions.appendFrameHtml(frameId, openCardDoc, person, { start: true, done: true })
    expect(actions.isFrameMidStream(frameId)).toBe(false)
    expect(actions.takeComponentIssues(frameId).map((issue) => issue.code)).toContain('unclosed_use')
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

  it('catches a block of base64 text streamed in pieces each too short to be one', async () => {
    const frame = actions.createFrame(
      canvasId,
      { name: 'Hero', html: doc(''), width: 400, height: 300 },
      actions.resolveActor({ name: 'Kevin', kind: 'user' }),
    )!
    const piece = 'Ab3+/9zQ'.repeat(250)
    const send = (html_chunk: string, start = false) =>
      call('append_frame_html', { frame_id: frame.id, html_chunk, start })
    expect((await send(`<html><body><script>const packed="${piece}`, true)).isError).toBe(false)
    expect((await send(piece)).isError).toBe(false)
    /* the third piece makes it 6,000 characters */
    const third = await send(piece)
    expect(third.isError).toBe(true)
    expect(third.text).toContain('block of base64 text')
    /* the earlier pieces are in the frame: it says so, and what to do */
    expect(third.text).toContain('this chunk was not written')
    expect(third.text).not.toContain('nothing was written')
    expect(third.text).toContain('start=true')
    expect(store.getFrame(frame.id)!.html).not.toContain(piece.repeat(3))
  })

  it('lets a rewrite carry over what the full form of the frame holds', async () => {
    const frame = actions.createFrame(
      canvasId,
      {
        name: 'Hero',
        html: doc(`<script>const packed="H4sI${'Ab3+/9zQ'.repeat(1000)}"</script>`),
        width: 400,
        height: 300,
      },
      actions.resolveActor({ name: 'Kevin', kind: 'user' }),
    )!
    const full = await call('get_frame', { frame_id: frame.id, expand_components: true })
    const html = (JSON.parse(full.text) as { html: string }).html
    expect(
      (await call('set_frame_html', { frame_id: frame.id, html: html.replace('</body>', '<p>More</p></body>') }))
        .isError,
    ).toBe(false)
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
  const run = () => newRunState()
  const actor = () => actions.resolveActor({ name: 'Doop', kind: 'agent' })
  const call = (name: string, input: unknown) => ({ type: 'tool_use' as const, id: 't1', name, input })

  it('is refused on create, set, edit and rewrite chunks', async () => {
    const canvasId = store.createCanvas('resident', 'owner').id
    const state = newRunState()
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
    expect(String(created.content)).toContain('<doop-use component="Card"> is opened and never closed')
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
    expect(String(commit.content)).toContain('never closed')
    expect(store.getFrame(frameId)!.html).toBe(before)
  })
})
