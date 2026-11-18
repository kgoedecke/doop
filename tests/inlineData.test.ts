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
 */

const FONT = `data:font/ttf;base64,${'A'.repeat(4000)}`
const PNG = `data:image/png;base64,${'iVBORw0KGgo'.repeat(10)}`
const faceCss = `<style>@font-face{font-family:Oxanium;src:url('${FONT}') format('truetype')}</style>`
const doc = (body: string) => `<!doctype html><html><head>${body}</head><body><h1>Hi</h1></body></html>`

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
})
