import { spawnSync } from 'node:child_process'
import path from 'node:path'
import sharp from 'sharp'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { COMPONENT_ATTR, INSTANCE_ATTR } from '../shared/components.ts'
import { COMPOSES_HEADER } from '../shared/frameCompose.ts'
import { findBrowserPath } from '../server/screenshot.ts'
import type { Canvas, Frame, ServerMessage, WireFrame } from '../shared/types.ts'
import { Client, startServer, type Server } from './harness.ts'

/**
 * Compact frame storage against the real server and its database, under both settings
 * of its switch. A frame's row holds each component instance as a reference; what the
 * server answers with, and sends the room, is the frame with its instances written out,
 * as before. A change to a component's markup writes no frame row: frames in memory are
 * rendered again and sent to whoever has their page open, the rest are rendered from
 * the component when their page is read. The rows are read here with the server stopped
 * (the embedded database takes one process at a time).
 */

const BLUE = 'rgb(0, 0, 255)'
const GREEN = 'rgb(0, 255, 0)'
const badge = (colour: string) =>
  `<span class="badge" style="display:block;height:40px;background:${colour}"><b data-doop-prop="label">Hi</b></span>`
const page = (label: string) =>
  `<!doctype html><html><head><style>body{margin:0}</style></head><body><doop-use component="Badge" label="${label}"></doop-use><p>below</p></body></html>`

const LOST_USE_ATTR = 'data-doop-lost-use'

type Statement = [sql: string, params?: unknown[]]

/** Frame rows are written on a 400 ms debounce. A server told to stop writes what is still
 *  waiting, but gives itself only a moment to: on a busy machine the write is given its
 *  debounce here first, so what a test reads from the database does not depend on that. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 700))

const QUERY = `
import { PGlite } from '@electric-sql/pglite'
const [dir, statements] = process.argv.slice(1)
const db = new PGlite(dir)
const results = []
for (const [sql, params] of JSON.parse(statements)) results.push((await db.query(sql, params ?? [])).rows)
await db.close()
process.stdout.write(JSON.stringify(results))
`

/** Run statements on a stopped server's database, in a process of their own (the embedded
 *  database keeps its files open for the life of the process that opened it). */
function sql(dataDir: string, statements: Statement[]): Record<string, unknown>[][] {
  const ran = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', QUERY, path.join(dataDir, 'data', 'pg'), JSON.stringify(statements)],
    { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  )
  if (ran.status !== 0) throw new Error(`database query failed: ${ran.stderr}`)
  return JSON.parse(ran.stdout) as Record<string, unknown>[][]
}

interface Rows {
  frames: Map<string, { html: string; updatedAt: number }>
  versions: { frameId: string; html: string }[]
}

describe.each([
  ['compact storage (the default)', {}, true],
  ['DOOP_COMPACT_FRAME_STORAGE=false', { DOOP_COMPACT_FRAME_STORAGE: 'false' }, false],
] as const)('%s', (_name, env, compact) => {
  let server: Server
  let owner: Client
  let canvas: Canvas
  let first: string
  let second: string
  let badgeId: string
  let main: Frame
  let open: Frame
  let closed: Frame
  let versioned: Frame

  /** One browser in the canvas's room, reading pages on demand as the web client does. */
  class Room {
    messages: ServerMessage[] = []
    private socket: WebSocket
    private waiters: (() => void)[] = []

    constructor(pageId: string) {
      this.socket = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { Cookie: owner.header() } })
      this.socket.on('open', () =>
        this.socket.send(
          JSON.stringify({
            type: 'join',
            canvasId: canvas.id,
            clientId: `c-${Math.random()}`,
            name: 'Owner',
            kind: 'user',
            pagesOnDemand: true,
            composesFrames: true,
            pageId,
          }),
        ),
      )
      this.socket.on('message', (data) => {
        this.messages.push(JSON.parse(String(data)) as ServerMessage)
        for (const wake of this.waiters.splice(0)) wake()
      })
    }

    send(message: object) {
      this.socket.send(JSON.stringify(message))
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

    close() {
      this.socket.close()
    }
  }

  const composing = (pathname: string, init: RequestInit = {}) =>
    owner.req(pathname, { ...init, headers: { [COMPOSES_HEADER]: '1', ...init.headers } })
  const json = async <T>(response: Promise<Response>): Promise<T> => {
    const answered = await response
    expect(answered.status).toBe(200)
    return (await answered.json()) as T
  }
  /** Every frame as the server holds it (this loads the whole canvas). */
  const framesOf = async (canvasId = canvas.id) =>
    new Map((await json<Canvas>(composing(`/api/canvases/${canvasId}`))).frames.map((frame) => [frame.id, frame]))
  const patchFrame = (frameId: string, body: object) =>
    json<Frame>(composing(`/api/frames/${frameId}`, { method: 'PATCH', body: JSON.stringify(body) }))

  /** Stop the server, run `edit` on its database, read what it holds, and start the server
   *  again on it: after this no frame HTML is in memory. */
  async function restart(edit: Statement[] = []): Promise<Rows & { edited: Record<string, unknown>[][] }> {
    await settled()
    server.stop({ keepData: true })
    await server.stopped
    try {
      const results = sql(server.dataDir, [
        ...edit,
        ['select id, html, updated_at from frames'],
        ['select frame_id, html from frame_versions'],
      ])
      const [frames = [], versions = []] = results.slice(edit.length)
      return {
        edited: results.slice(0, edit.length),
        frames: new Map(
          frames.map((row) => [String(row.id), { html: String(row.html), updatedAt: Number(row.updated_at) }]),
        ),
        versions: versions.map((row) => ({ frameId: String(row.frame_id), html: String(row.html) })),
      }
    } finally {
      server = await startServer(env, server.dataDir)
    }
  }

  beforeAll(async () => {
    server = await startServer(env)
    owner = await new Client(server).signUp(`compact-${compact}@test.dev`, 'Owner')
    canvas = await json<Canvas>(owner.post('/api/canvases', { name: 'Compact' }))
    first = canvas.pages![0]!.id
    second = 'second-page'
    const pages = await owner.put(`/api/canvases/${canvas.id}/pages`, {
      pages: [...canvas.pages!, { id: second, name: 'Second' }],
      expectedPages: canvas.pages,
    })
    expect(pages.status).toBe(200)
    const made = await owner.post(`/api/canvases/${canvas.id}/components`, { name: 'Badge', html: badge(BLUE) })
    expect(made.status).toBe(200)
    const create = (name: string, pageId: string, label: string) =>
      json<Frame>(
        composing(`/api/canvases/${canvas.id}/frames`, {
          method: 'POST',
          body: JSON.stringify({ name, pageId, html: page(label), width: 200, height: 80 }),
        }),
      )
    open = await create('Open', first, 'Open')
    closed = await create('Closed', second, 'Closed')
    versioned = await create('Versioned', first, 'Versioned')
    const loaded = await json<Canvas>(composing(`/api/canvases/${canvas.id}`))
    badgeId = loaded.components!.find((def) => def.name === 'Badge')!.id
    main = loaded.frames.find((frame) => frame.html.includes(`${COMPONENT_ATTR}="${badgeId}"`))!
  }, 120_000)

  afterAll(() => server?.stop())

  it(
    compact
      ? 'stores a reference per instance, and answers with the frame written out, across a restart'
      : 'stores the instances written out, and answers the same across a restart',
    async () => {
      const before = await framesOf()
      expect(before.get(open.id)!.html).toContain(`${INSTANCE_ATTR}="${badgeId}"`)
      expect(before.get(open.id)!.html).toContain('>Open</b>')
      const rows = await restart()
      const row = rows.frames.get(open.id)!.html
      if (compact) {
        expect(row).not.toContain(INSTANCE_ATTR)
        expect(row).toMatch(new RegExp(`<doop-use component="${badgeId}" id="[a-z0-9]{6}" label="Open"></doop-use>`))
        expect(row.length).toBeLessThan(before.get(open.id)!.html.length)
      } else {
        expect(row).toBe(before.get(open.id)!.html)
      }
      /* the main is the component itself: written out either way */
      expect(rows.frames.get(main.id)!.html).toContain(`${COMPONENT_ATTR}="${badgeId}"`)
      const after = await framesOf()
      for (const [id, frame] of before) {
        expect(after.get(id)!.html, frame.name).toBe(frame.html)
        expect(after.get(id)!.updatedAt, frame.name).toBe(frame.updatedAt)
      }
    },
    60_000,
  )

  it('keeps an edit made inside an instance as an override, across a restart', async () => {
    const before = (await framesOf()).get(open.id)!
    const edited = await patchFrame(open.id, { html: before.html.replace('>Open</b>', '>Edited</b>') })
    expect(edited.html).toContain('>Edited</b>')
    const rows = await restart()
    if (compact) expect(rows.frames.get(open.id)!.html).toContain('label="Edited"></doop-use>')
    const after = (await framesOf()).get(open.id)!
    expect(after.html).toBe(edited.html)
    expect(after.html).toContain('data-doop-props="{&quot;label&quot;:&quot;Edited&quot;}"')
    open = after
  }, 60_000)

  it('files a version in the stored form, previews it with the components as they are, and restores it', async () => {
    const original = (await framesOf()).get(versioned.id)!
    await patchFrame(versioned.id, {
      html: '<!doctype html><html><body><main><section><h2>Another design altogether</h2></section></main></body></html>',
    })
    const versions = await vi.waitFor(async () => {
      const filed = await json<{ id: string }[]>(owner.get(`/api/frames/${versioned.id}/versions`))
      expect(filed.length).toBeGreaterThan(0)
      return filed
    })
    const rows = await restart()
    const row = rows.versions.find((version) => version.frameId === versioned.id)!
    if (compact) expect(row.html).toContain(`<doop-use component="${badgeId}"`)
    else expect(row.html).toContain(`${INSTANCE_ATTR}="${badgeId}"`)

    const preview = await json<{ html: string }>(composing(`/api/frames/${versioned.id}/versions/${versions[0]!.id}`))
    expect(preview.html).toContain(`${INSTANCE_ATTR}="${badgeId}"`)
    expect(preview.html).toContain('>Versioned</b>')
    expect(preview.html).not.toContain('<doop-use')

    const restored = await json<{ frame: Frame }>(
      composing(`/api/frames/${versioned.id}/versions/${versions[0]!.id}/restore`, { method: 'POST' }),
    )
    expect(restored.frame.html).toBe(original.html)
  }, 60_000)

  /** the colour at the top of a frame's image: the Badge */
  async function badgeColour(frameId: string): Promise<string> {
    const response = await fetch(`http://127.0.0.1:${server.port}/i/${frameId}.png?scale=1`)
    expect(response.status).toBe(200)
    const { data } = await sharp(Buffer.from(await response.arrayBuffer()))
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    return `rgb(${data[0]}, ${data[1]}, ${data[2]})`
  }

  it(
    compact
      ? 'a markup change writes no frame: the open page is sent the new rendering, the other has it when read'
      : 'a markup change rewrites the frames in memory, and the others are current when read',
    async () => {
      /* nothing in memory, then one browser with the first page up */
      const rowsBefore = await restart()
      const renders = !!findBrowserPath()
      if (renders) expect(await badgeColour(closed.id)).toBe(BLUE)
      const room = new Room(first)
      try {
        const init = await room.next('init')
        expect(init.loadedPageIds).toEqual([first])
        const before = init.canvas.frames.find((frame) => frame.id === open.id)!
        const from = room.messages.length

        /* the main is edited, as in the editor: its frame is written, and nothing else is read */
        const mainNow = await patchFrame(main.id, { html: main.html.replace(BLUE, GREEN) })
        expect(mainNow.html).toContain(GREEN)
        const update = await room.next(
          'frame:updated',
          (message) => message.frame.id === open.id && !!message.frame.html?.includes(GREEN),
          from,
        )
        expect(update.frame.html).toContain('>Edited</b>')
        if (compact) {
          expect(update.rerender).toBe(true)
          expect(update.frame.updatedAt).toBe(before.updatedAt)
          expect(update.frame.rendered).toBeGreaterThan(0)
        } else {
          expect(update.rerender).toBeUndefined()
          expect(update.frame.updatedAt).toBeGreaterThan(before.updatedAt)
        }
        /* a save made against the version the browser holds is not refused for it */
        const saved = await composing(`/api/frames/${open.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ name: 'Open', expectedUpdatedAt: update.frame.updatedAt }),
        })
        expect(saved.status).toBe(200)

        /* the frame nobody had open: its image is fresh, with its page still not read */
        if (renders) expect(await badgeColour(closed.id)).toBe(GREEN)
        const opened = room.messages.length
        room.send({ type: 'page:load', pageId: second })
        const read = await room.next('page:frames', (message) => message.pageId === second, opened)
        const there = read.frames.find((frame) => frame.id === closed.id)! as WireFrame
        expect(there.html).toContain(GREEN)
        expect(there.html).toContain('>Closed</b>')
        expect(there.updatedAt).toBe(closed.updatedAt)
      } finally {
        room.close()
      }

      const rows = await restart()
      const versionsOf = (frameId: string, list: Rows) => list.versions.filter((v) => v.frameId === frameId).length
      /* the frame on the page nobody had open */
      /* compact: its row holds a reference and is as it was. Written out: its instance was
         behind when the page was read, and the row is stored again as read, with no version */
      if (compact) expect(rows.frames.get(closed.id)).toEqual(rowsBefore.frames.get(closed.id))
      else expect(rows.frames.get(closed.id)!.html).not.toBe(rowsBefore.frames.get(closed.id)!.html)
      expect(versionsOf(closed.id, rows)).toBe(versionsOf(closed.id, rowsBefore))
      if (compact) {
        /* and so is the one that was rendered again (its rename above wrote the same HTML) */
        expect(rows.frames.get(open.id)!.html).toBe(rowsBefore.frames.get(open.id)!.html)
        expect(versionsOf(open.id, rows)).toBe(versionsOf(open.id, rowsBefore))
      } else {
        expect(rows.frames.get(open.id)!.html).toContain(GREEN)
        expect(rows.frames.get(closed.id)!.html).toContain(GREEN)
      }
      const after = await framesOf()
      expect(after.get(open.id)!.html).toContain(GREEN)
      expect(after.get(closed.id)!.html).toContain(GREEN)
      main = after.get(main.id)!
    },
    120_000,
  )

  it('copies a canvas and a page with their instances, stored written out', async () => {
    const copy = await json<Canvas>(owner.post(`/api/canvases/${canvas.id}/duplicate`))
    const pageCopy = await json<{ frames: Frame[] }>(owner.post(`/api/canvases/${canvas.id}/pages/${second}/duplicate`))
    const source = await framesOf()
    const copied = await framesOf(copy.id)
    const twin = [...copied.values()].find((frame) => frame.name === 'Closed')!
    expect(twin.html).toBe(source.get(closed.id)!.html)
    const pageTwin = pageCopy.frames[0]!
    const rows = await restart()
    /* a copy is stored as it is in memory, written out, under either setting: a whole canvas
       is never made compact in one turn. Each frame goes compact on its own first write */
    for (const id of [twin.id, pageTwin.id])
      expect(rows.frames.get(id)!.html).toContain(`${INSTANCE_ATTR}="${badgeId}"`)
    expect((await framesOf(copy.id)).get(twin.id)!.html).toBe(twin.html)
    expect((await framesOf()).get(pageTwin.id)!.html).toContain('>Closed</b>')
  }, 60_000)

  it.runIf(compact)(
    'never loses a design to a missing definition: a placeholder is shown, the reference stays stored, and it renders once repaired',
    async () => {
      const copy = await json<Canvas>(owner.post(`/api/canvases/${canvas.id}/duplicate`))
      const before = [...(await framesOf(copy.id)).values()].find((frame) => frame.name === 'Closed')!
      /* a copy's frames are stored written out until their first own write */
      await patchFrame(before.id, { name: 'Closed' })
      /* the copy's Badge row disappears from the database */
      const rowsBroken = await restart([
        ['select * from components where canvas_id = $1', [copy.id]],
        ['delete from components where canvas_id = $1', [copy.id]],
      ])
      const lostRow = rowsBroken.edited[0]![0]!
      const reference = rowsBroken.frames.get(before.id)!.html
      expect(reference).toContain(`<doop-use component="${badgeId}"`)

      const broken = (await framesOf(copy.id)).get(before.id)!
      expect(broken.html).toContain(LOST_USE_ATTR)
      expect(broken.html).toContain('Missing component')
      expect(broken.html).toContain('<p>below</p>')
      /* written while broken, twice: a rename, and the browser sending the document back */
      await patchFrame(before.id, { name: 'Still here' })
      await patchFrame(before.id, { html: broken.html.replace('<p>below</p>', '<p>below, edited</p>') })

      const columns = Object.keys(lostRow)
      const rowsAfter = await restart([
        [
          `insert into components (${columns.join(', ')}) values (${columns.map((_, at) => `$${at + 1}`).join(', ')})`,
          columns.map((column) => {
            const value = lostRow[column]
            return value !== null && typeof value === 'object' ? JSON.stringify(value) : value
          }),
        ],
      ])
      /* the row kept the reference through both writes */
      expect(rowsAfter.frames.get(before.id)!.html).toBe(reference.replace('<p>below</p>', '<p>below, edited</p>'))
      const repaired = (await framesOf(copy.id)).get(before.id)!
      expect(repaired.html).toBe(before.html.replace('<p>below</p>', '<p>below, edited</p>'))
    },
    120_000,
  )
})

describe('a database holding both forms', () => {
  let server: Server

  afterAll(() => server?.stop())

  it('reads frames stored either way under either setting, and stores each as the setting says on its next write', async () => {
    server = await startServer({ DOOP_COMPACT_FRAME_STORAGE: 'false' })
    const owner = await new Client(server).signUp('mixed@test.dev', 'Owner')
    const composing = (pathname: string, init: RequestInit = {}) =>
      owner.req(pathname, { ...init, headers: { [COMPOSES_HEADER]: '1', ...init.headers } })
    const canvas = (await (await owner.post('/api/canvases', { name: 'Mixed' })).json()) as Canvas
    expect(
      (await owner.post(`/api/canvases/${canvas.id}/components`, { name: 'Badge', html: badge(BLUE) })).status,
    ).toBe(200)
    const create = async (name: string) =>
      (await (
        await composing(`/api/canvases/${canvas.id}/frames`, {
          method: 'POST',
          body: JSON.stringify({ name, html: page(name) }),
        })
      ).json()) as Frame
    const one = await create('One')
    const two = await create('Two')
    const framesOf = async () =>
      new Map(
        ((await (await composing(`/api/canvases/${canvas.id}`)).json()) as Canvas).frames.map((frame) => [
          frame.id,
          frame,
        ]),
      )
    const rendered = await framesOf()
    const reboot = async (env: Record<string, string>) => {
      await settled()
      server.stop({ keepData: true })
      await server.stopped
      const [rows = []] = sql(server.dataDir, [['select id, html from frames']])
      server = await startServer(env, server.dataDir)
      return new Map(rows.map((row) => [String(row.id), String(row.html)]))
    }

    /* written out, as every frame is today: the switch comes on */
    const written = await reboot({})
    expect(written.get(one.id)).toContain(INSTANCE_ATTR)
    expect((await framesOf()).get(one.id)!.html).toBe(rendered.get(one.id)!.html)
    /* one frame is written: it goes compact, the other stays as it was */
    const renamed = await composing(`/api/frames/${one.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'One!' }),
    })
    expect(renamed.status).toBe(200)

    const mixed = await reboot({ DOOP_COMPACT_FRAME_STORAGE: 'false' })
    expect(mixed.get(one.id)).toContain('<doop-use')
    expect(mixed.get(one.id)).not.toContain(INSTANCE_ATTR)
    expect(mixed.get(two.id)).toContain(INSTANCE_ATTR)
    /* switched off again (a rollback of the setting): both read the same, and a write stores written out */
    const off = await framesOf()
    expect(off.get(one.id)!.html).toBe(rendered.get(one.id)!.html)
    expect(off.get(two.id)!.html).toBe(rendered.get(two.id)!.html)
    await composing(`/api/frames/${one.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'One' }) })
    const back = await reboot({})
    expect(back.get(one.id)).toBe(rendered.get(one.id)!.html)
    expect((await framesOf()).get(one.id)!.html).toBe(rendered.get(one.id)!.html)
  }, 120_000)
})
