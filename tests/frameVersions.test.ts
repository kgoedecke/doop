import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/**
 * Frame design history against the REAL server (see ./harness.ts): what a
 * replace, a stream and a burst of tweaks each leave behind, that a restore
 * brings a design back at its size and is itself reversible, and that the
 * history is as private as the canvas.
 */

const DOC_A = '<!doctype html><html><body><h1>Alpha</h1><p>the first design, by hand</p></body></html>'
const DOC_B =
  '<!doctype html><html><body><main><h2>Beta</h2><section>a completely different design</section></main></body></html>'
const DOC_C =
  '<!doctype html><html><head><style>body{margin:0}</style></head><body><article>Gamma</article></body></html>'

interface VersionRow {
  id: string
  savedBy: string
  savedByKind?: string
  savedAt: number
  width: number
  height: number
  htmlBytes: number
}

let server: Server

beforeAll(async () => {
  server = await startServer()
}, 70_000)

afterAll(() => server?.stop())

/* versions are filed behind the response, not before it */
async function eventually<T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 3000
  for (;;) {
    const value = await read()
    if (ok(value) || Date.now() > deadline) return value
    await new Promise((r) => setTimeout(r, 50))
  }
}

async function versionsOf(client: Client, frameId: string, count: number): Promise<VersionRow[]> {
  return eventually(
    async () => (await (await client.get(`/api/frames/${frameId}/versions`)).json()) as VersionRow[],
    (list) => list.length === count,
  )
}

describe('frame version history', () => {
  let client: Client
  let canvasId: string

  beforeAll(async () => {
    client = new Client(server)
    await client.signUp('versions@test.dev', 'Vera')
    canvasId = (await (await client.post('/api/canvases', { name: 'History' })).json()).id
  })

  async function newFrame(name: string, html: string, size: { width?: number; height?: number } = {}) {
    const res = await client.post(`/api/canvases/${canvasId}/frames`, { name, html, ...size })
    return (await res.json()) as { id: string; html: string; width: number; height: number }
  }

  it('files the design a replace overwrote, attributed to who wrote it', async () => {
    const frame = await newFrame('replace', DOC_A)
    expect((await client.patch(`/api/frames/${frame.id}`, { html: DOC_B })).status).toBe(200)

    const versions = await versionsOf(client, frame.id, 1)
    expect(versions).toHaveLength(1)
    expect(versions[0]).toMatchObject({ savedBy: 'Vera', savedByKind: 'user', width: 640, height: 480 })
    expect(versions[0]!.htmlBytes).toBe(DOC_A.length)
    /* the listing is light; the HTML comes with the single version */
    expect(versions[0]).not.toHaveProperty('html')
    const full = await (await client.get(`/api/frames/${frame.id}/versions/${versions[0]!.id}`)).json()
    expect(full.html).toBe(DOC_A)
  })

  it('folds a burst of tweaks into one version and opens a new one on the next redesign', async () => {
    const frame = await newFrame('tweaks', DOC_A)
    await client.patch(`/api/frames/${frame.id}`, { html: DOC_B })
    const tweaked = DOC_B.replace('Beta', 'Beta!').replace('different', 'rather different')
    await client.patch(`/api/frames/${frame.id}`, { html: DOC_B.replace('Beta', 'Beta!') })
    await client.patch(`/api/frames/${frame.id}`, { html: tweaked })
    /* the tweaks continued the burst that replaced A: still only A on file */
    await new Promise((r) => setTimeout(r, 300))
    expect(await versionsOf(client, frame.id, 1)).toHaveLength(1)

    await client.patch(`/api/frames/${frame.id}`, { html: DOC_C })
    const versions = await versionsOf(client, frame.id, 2)
    expect(versions.map((v) => v.htmlBytes)).toEqual([tweaked.length, DOC_A.length])
    const latest = await (await client.get(`/api/frames/${frame.id}/versions/${versions[0]!.id}`)).json()
    expect(latest.html).toBe(tweaked)
  })

  it('files what a stream replaced once, not once per chunk', async () => {
    const frame = await newFrame('stream', DOC_A)
    await client.post(`/api/frames/${frame.id}/append`, { html_chunk: DOC_C.slice(0, 40), start: true })
    await client.post(`/api/frames/${frame.id}/append`, { html_chunk: DOC_C.slice(40, 80) })
    await client.post(`/api/frames/${frame.id}/append`, { html_chunk: DOC_C.slice(80), done: true })
    await new Promise((r) => setTimeout(r, 300))
    const versions = await versionsOf(client, frame.id, 1)
    expect(versions).toHaveLength(1)
    expect(versions[0]!.htmlBytes).toBe(DOC_A.length)
  })

  it('restores HTML and size, and files the design it replaced so the restore can be undone', async () => {
    const frame = await newFrame('restore', DOC_A, { width: 390, height: 844 })
    await client.patch(`/api/frames/${frame.id}`, { html: DOC_B, width: 1280, height: 800 })
    const [original] = await versionsOf(client, frame.id, 1)
    expect(original).toMatchObject({ width: 390, height: 844 })

    const restored = await client.post(`/api/frames/${frame.id}/versions/${original!.id}/restore`)
    expect(restored.status).toBe(200)
    expect(await restored.json()).toMatchObject({
      frame: { html: DOC_A, width: 390, height: 844, updatedBy: 'Vera' },
      /* the complete state swapped out, for the client's undo */
      replaced: { html: DOC_B, width: 1280, height: 800 },
    })
    const canvas = await (await client.get(`/api/canvases/${canvasId}`)).json()
    expect(canvas.frames.find((f: { id: string }) => f.id === frame.id)).toMatchObject({ html: DOC_A, width: 390 })

    const versions = await versionsOf(client, frame.id, 2)
    expect(versions[0]).toMatchObject({ width: 1280, height: 800, htmlBytes: DOC_B.length })
    expect(versions[1]!.id).toBe(original!.id)
  })

  it('keeps the same document at another size as a state of its own', async () => {
    const frame = await newFrame('resized', DOC_A)
    /* a collaborator's tweak opens a burst (A is filed at 640×480), is typed
       back to A within it, and the frame is resized before the next redesign:
       what that redesign replaces is A at 800 wide, not the A already on file */
    const mate = await new Client(server).signUp('mate@test.dev', 'Mia')
    expect((await client.post(`/api/canvases/${canvasId}/members`, { email: 'mate@test.dev' })).status).toBe(200)
    await mate.patch(`/api/frames/${frame.id}`, { html: DOC_A.replace('Alpha', 'Alpha!') })
    await mate.patch(`/api/frames/${frame.id}`, { html: DOC_A })
    await mate.patch(`/api/frames/${frame.id}`, { width: 800 })
    await mate.patch(`/api/frames/${frame.id}`, { html: DOC_C })
    const versions = await versionsOf(mate, frame.id, 2)
    expect(versions.map((v) => [v.htmlBytes, v.width])).toEqual([
      [DOC_A.length, 800],
      [DOC_A.length, 640],
    ])
  })

  it('keeps the history as private as the canvas', async () => {
    const frame = await newFrame('private', DOC_A)
    await client.patch(`/api/frames/${frame.id}`, { html: DOC_B })
    const [version] = await versionsOf(client, frame.id, 1)
    const other = await newFrame('other', DOC_C)

    const stranger = await new Client(server).signUp('stranger@test.dev', 'Sam')
    expect((await stranger.get(`/api/frames/${frame.id}/versions`)).status).toBe(403)
    expect((await stranger.post(`/api/frames/${frame.id}/versions/${version!.id}/restore`)).status).toBe(403)
    /* a version id only resolves on its own frame */
    expect((await client.get(`/api/frames/${other.id}/versions/${version!.id}`)).status).toBe(404)
    expect((await client.post(`/api/frames/${other.id}/versions/${version!.id}/restore`)).status).toBe(404)
  })

  it('survives a restart', async () => {
    const frame = await newFrame('durable', DOC_A)
    await client.patch(`/api/frames/${frame.id}`, { html: DOC_B })
    const [version] = await versionsOf(client, frame.id, 1)

    const dataDir = server.dataDir
    server.stop({ keepData: true })
    await server.stopped
    server = await startServer({}, dataDir)
    const back = new Client(server)
    expect(
      (await back.post('/api/auth/sign-in/email', { email: 'versions@test.dev', password: 'password12345' })).status,
    ).toBe(200)

    const versions = (await (await back.get(`/api/frames/${frame.id}/versions`)).json()) as VersionRow[]
    expect(versions.map((v) => v.id)).toEqual([version!.id])
    /* the first write after boot still files the state it replaces */
    await back.patch(`/api/frames/${frame.id}`, { html: DOC_C })
    expect((await versionsOf(back, frame.id, 2)).map((v) => v.htmlBytes)).toEqual([DOC_B.length, DOC_A.length])
  }, 80_000)
})
