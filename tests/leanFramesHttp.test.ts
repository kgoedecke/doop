import sharp from 'sharp'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { CSS_ATTR } from '../shared/components.ts'
import { TOKEN_BLOCK_ATTR } from '../shared/designTokens.ts'
import { COMPOSES_HEADER } from '../shared/frameCompose.ts'
import { findBrowserPath } from '../server/screenshot.ts'
import type { Canvas, Frame, ServerMessage, WireFrame } from '../shared/types.ts'
import { Client, startServer, type Server } from './harness.ts'

/**
 * Lean frame storage against the real server, under both settings of its switch.
 * A browser that composes frames itself (its join says `composesFrames`, its
 * requests carry the header) is sent each frame's source and restyles from the
 * `tokens` and `component` messages. Every other client (the native apps, a tab
 * on an older bundle) is sent composed documents, and sent them again when the
 * canvas's shared styles change. Renders, the image cache and the version
 * preview compose too.
 */

const BODY =
  '<h1 style="margin:0;height:40px;background:var(--brand)">Title</h1><doop-use component="Badge" label="New"></doop-use>'
const PAGE = `<!doctype html><html><head><style>body{margin:0}</style></head><body>${BODY}</body></html>`
const BADGE = '<span class="badge" style="display:block;height:40px"><b data-doop-prop="label">Hi</b></span>'
const BADGE_CSS = '.badge { background: var(--accent); color: white }'

const shared = (html: string | undefined) => ({
  tokens: !!html?.includes(`<style ${TOKEN_BLOCK_ATTR}>`),
  component: !!html?.includes(`<style ${CSS_ATTR}=`),
})

describe.each([
  ['lean storage (the default)', {}, true],
  ['DOOP_LEAN_FRAME_STORAGE=false', { DOOP_LEAN_FRAME_STORAGE: 'false' }, false],
] as const)('%s', (_name, env, lean) => {
  let server: Server
  let owner: Client
  let canvas: Canvas
  let page: Frame
  let plain: Frame

  /** One client in the canvas's room: what the server sent it, in order. */
  class Room {
    messages: ServerMessage[] = []
    private socket: WebSocket
    private waiters: (() => void)[] = []

    constructor(composes: boolean) {
      this.socket = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { Cookie: owner.header() } })
      this.socket.on('open', () =>
        this.socket.send(
          JSON.stringify({
            type: 'join',
            canvasId: canvas.id,
            clientId: `c-${Math.random()}`,
            name: 'Owner',
            kind: 'user',
            /* the web client reads pages on demand and composes; a native app does neither */
            ...(composes ? { pagesOnDemand: true, composesFrames: true } : {}),
          }),
        ),
      )
      this.socket.on('message', (data) => {
        this.messages.push(JSON.parse(String(data)) as ServerMessage)
        for (const wake of this.waiters.splice(0)) wake()
      })
    }

    async next<T extends ServerMessage['type']>(
      type: T,
      matches: (message: Extract<ServerMessage, { type: T }>) => boolean = () => true,
      from = 0,
    ): Promise<Extract<ServerMessage, { type: T }>> {
      const deadline = Date.now() + 8000
      for (;;) {
        const found = this.messages
          .slice(from)
          .find(
            (message): message is Extract<ServerMessage, { type: T }> =>
              message.type === type && matches(message as Extract<ServerMessage, { type: T }>),
          )
        if (found) return found
        if (Date.now() > deadline) throw new Error(`no ${type} message`)
        await new Promise<void>((resolve) => {
          this.waiters.push(resolve)
          setTimeout(resolve, 200)
        })
      }
    }

    frameUpdates(from: number): WireFrame[] {
      return this.messages.slice(from).flatMap((message) => (message.type === 'frame:updated' ? [message.frame] : []))
    }

    close() {
      this.socket.close()
    }
  }

  const composing = (path: string) => owner.req(path, { headers: { [COMPOSES_HEADER]: '1' } })
  const stored = async (frameId: string): Promise<Frame> =>
    ((await (await composing(`/api/canvases/${canvas.id}`)).json()) as Canvas).frames.find((f) => f.id === frameId)!
  const setToken = (name: string, value: string) =>
    owner.put(`/api/canvases/${canvas.id}/tokens/${encodeURIComponent(name)}`, { value })
  /** the room message that follows every write so far, so a count after it is settled */
  const settle = async (rooms: Room[]) => {
    const marker = `settled-${Math.random()}`
    await owner.patch(`/api/frames/${plain.id}`, { name: marker })
    await Promise.all(rooms.map((room) => room.next('frame:updated', (message) => message.frame.name === marker)))
  }

  beforeAll(async () => {
    server = await startServer(env)
    owner = await new Client(server).signUp(`lean-${lean}@test.dev`, 'Owner')
    canvas = await (await owner.post('/api/canvases', { name: 'Lean' })).json()
    const tokens = await owner.post(`/api/canvases/${canvas.id}/tokens`, {
      tokens: [
        { name: '--brand', type: 'color', value: '#ff0000' },
        { name: '--accent', type: 'color', value: '#0000ff' },
        { name: '--unused', type: 'color', value: '#00ff00' },
      ],
    })
    expect(tokens.status).toBe(200)
    const component = await owner.post(`/api/canvases/${canvas.id}/components`, {
      name: 'Badge',
      html: BADGE,
      css: BADGE_CSS,
    })
    expect(component.status).toBe(200)
    page = await (
      await owner.post(`/api/canvases/${canvas.id}/frames`, { name: 'Page', html: PAGE, width: 200, height: 80 })
    ).json()
    plain = await (
      await owner.post(`/api/canvases/${canvas.id}/frames`, { name: 'Plain', html: '<p>plain</p>' })
    ).json()
  }, 120_000)

  afterAll(() => server?.stop())

  it(lean ? 'stores the frame’s source' : 'stores the composed document', async () => {
    expect(shared((await stored(page.id)).html)).toEqual({ tokens: !lean, component: !lean })
  })

  it('answers REST with composed frames unless the client says it composes', async () => {
    const legacy = (await (await owner.get(`/api/canvases/${canvas.id}`)).json()) as Canvas
    const html = legacy.frames.find((f) => f.id === page.id)!.html
    expect(shared(html)).toEqual({ tokens: true, component: true })
    expect(html).toContain('--brand:#ff0000')
    /* --accent is named by the Badge's rules alone */
    expect(html).toContain('--accent:#0000ff')
    expect(html).not.toContain('--unused')
    /* a write answered to a legacy client carries the composed document too */
    const renamed = (await (await owner.patch(`/api/frames/${page.id}`, { name: 'Page' })).json()) as Frame
    expect(shared(renamed.html)).toEqual({ tokens: true, component: true })
    const mine = (await (
      await owner.req(`/api/frames/${page.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Page' }),
        headers: { [COMPOSES_HEADER]: '1' },
      })
    ).json()) as Frame
    expect(shared(mine.html)).toEqual({ tokens: !lean, component: !lean })
  })

  it('sends init composed to a legacy connection, as stored to one that composes', async () => {
    const legacy = new Room(false)
    const web = new Room(true)
    try {
      const framed = (init: Extract<ServerMessage, { type: 'init' }>) =>
        init.canvas.frames.find((frame) => frame.id === page.id)!.html
      expect(shared(framed(await legacy.next('init')))).toEqual({ tokens: true, component: true })
      const init = await web.next('init')
      expect(shared(framed(init))).toEqual({ tokens: !lean, component: !lean })
      /* what it composes from rides in the same message */
      expect(init.canvas.tokens?.map((token) => token.name)).toContain('--brand')
      expect(init.canvas.components?.[0]?.css).toContain('var(--accent)')
    } finally {
      legacy.close()
      web.close()
    }
  })

  it(
    lean
      ? 'a token value change writes no frame: the composing browser gets the tokens, the legacy one its frames'
      : 'a token value change rewrites the frames naming it, for both',
    async () => {
      const legacy = new Room(false)
      const web = new Room(true)
      try {
        await Promise.all([legacy.next('init'), web.next('init')])
        const before = (await stored(page.id)).updatedAt
        const from = { legacy: legacy.messages.length, web: web.messages.length }
        expect((await setToken('--brand', '#00aa00')).status).toBe(200)
        await Promise.all([legacy.next('tokens', undefined, from.legacy), web.next('tokens', undefined, from.web)])
        await settle([legacy, web])

        const toLegacy = legacy.frameUpdates(from.legacy).filter((frame) => frame.id === page.id)
        expect(toLegacy).toHaveLength(1)
        expect(toLegacy[0]!.html).toContain('--brand:#00aa00')
        expect(shared(toLegacy[0]!.html)).toEqual({ tokens: true, component: true })
        /* the frame that names no token is sent once: its rename, which `settle` made */
        expect(legacy.frameUpdates(from.legacy).filter((frame) => frame.id === plain.id)).toHaveLength(1)

        const toWeb = web.frameUpdates(from.web).filter((frame) => frame.id === page.id)
        const after = await stored(page.id)
        if (lean) {
          expect(toWeb).toEqual([])
          expect(after.updatedAt).toBe(before)
          expect(after.html).not.toContain('#00aa00')
        } else {
          expect(toWeb).toHaveLength(1)
          expect(after.updatedAt).toBeGreaterThan(before)
          expect(after.html).toContain('--brand:#00aa00')
        }
        /* a token nothing names restyles nothing, for anyone */
        const quiet = { legacy: legacy.messages.length, web: web.messages.length }
        expect((await setToken('--unused', '#123456')).status).toBe(200)
        await settle([legacy, web])
        expect(legacy.frameUpdates(quiet.legacy).filter((frame) => frame.id === page.id)).toEqual([])
        expect(web.frameUpdates(quiet.web).filter((frame) => frame.id === page.id)).toEqual([])
      } finally {
        legacy.close()
        web.close()
      }
    },
  )

  it('a token rename rewrites the frames naming it', async () => {
    const web = new Room(true)
    try {
      await web.next('init')
      const from = web.messages.length
      expect(
        (await owner.put(`/api/canvases/${canvas.id}/tokens/${encodeURIComponent('--brand')}`, { newName: '--main' }))
          .status,
      ).toBe(200)
      const update = await web.next('frame:updated', (message) => message.frame.id === page.id, from)
      expect(update.frame.html).toContain('background:var(--main)')
      expect((await stored(page.id)).html).toContain('background:var(--main)')
      const back = await owner.put(`/api/canvases/${canvas.id}/tokens/${encodeURIComponent('--main')}`, {
        newName: '--brand',
      })
      expect(back.status).toBe(200)
    } finally {
      web.close()
    }
  })

  it('previews a version composed with the canvas’s styles as they are now', async () => {
    const first = (await (
      await owner.post(`/api/canvases/${canvas.id}/frames`, { name: 'Versioned', html: PAGE })
    ).json()) as Frame
    /* a replace files the design it overwrote */
    const replaced = await owner.patch(`/api/frames/${first.id}`, {
      html: '<!doctype html><html><body><main><section><h2>Another design altogether</h2></section></main></body></html>',
    })
    expect(replaced.status).toBe(200)
    /* versions are filed behind the response, not before it */
    const versions = await vi.waitFor(async () => {
      const filed = (await (await owner.get(`/api/frames/${first.id}/versions`)).json()) as { id: string }[]
      expect(filed.length).toBeGreaterThan(0)
      return filed
    })
    const version = (await (await composing(`/api/frames/${first.id}/versions/${versions[0]!.id}`)).json()) as {
      html: string
    }
    expect(shared(version.html)).toEqual({ tokens: true, component: true })
    expect(version.html).toContain('--brand:#00aa00')
    expect(version.html.match(new RegExp(TOKEN_BLOCK_ATTR, 'g'))).toHaveLength(1)
  })

  it('pins a reference as a document of its own', async () => {
    const pinned = (await (await owner.post(`/api/canvases/${canvas.id}/references`, { frameId: page.id })).json()) as {
      html: string
    }
    expect(shared(pinned.html)).toEqual({ tokens: true, component: true })
  })

  describe.skipIf(!findBrowserPath())('with a renderer', () => {
    /** the colour of the frame's top band (the token) and bottom band (the component's rule) */
    async function bands(): Promise<{ top: string; bottom: string }> {
      const response = await fetch(`http://127.0.0.1:${server.port}/i/${page.id}.png?scale=1`)
      expect(response.status).toBe(200)
      const { data, info } = await sharp(Buffer.from(await response.arrayBuffer()))
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
      const at = (x: number, y: number) => {
        const i = (y * info.width + x) * info.channels
        return `#${[data[i]!, data[i + 1]!, data[i + 2]!].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
      }
      return { top: at(190, 10), bottom: at(190, 70) }
    }

    it('renders a frame with its token values and component rules, and again when they change', async () => {
      expect((await setToken('--brand', '#ff0000')).status).toBe(200)
      expect((await setToken('--accent', '#0000ff')).status).toBe(200)
      expect(await bands()).toEqual({ top: '#ff0000', bottom: '#0000ff' })
      const before = (await stored(page.id)).updatedAt
      /* the image just rendered is cached: a token change has to retire it */
      expect((await setToken('--accent', '#00ff00')).status).toBe(200)
      expect(await bands()).toEqual({ top: '#ff0000', bottom: '#00ff00' })
      if (lean) expect((await stored(page.id)).updatedAt).toBe(before)
    }, 60_000)

    it('prints the frame styled', async () => {
      const response = await composing(`/api/canvases/${canvas.id}/export.pdf?frames=${page.id}`)
      expect(response.status).toBe(200)
      const pdf = Buffer.from(await response.arrayBuffer())
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
      /* the page as an image, through the same route a design export takes */
      const raster = await sharp(pdf, { density: 96 })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
        .catch(() => null)
      if (!raster) return
      const i = (10 * raster.info.width + 190) * raster.info.channels
      expect([raster.data[i], raster.data[i + 1], raster.data[i + 2]]).toEqual([255, 0, 0])
    }, 60_000)
  })
})
