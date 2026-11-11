import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { Client, startServer, type Server } from './harness'
import type { ActorFrame, FramesEvent, FramesSnapshot } from '../src/actor'
import type { Canvas, Frame, FrameVersionInfo, ServerMessage } from '../shared/types'

/* canvas-actors end to end, on a real server and a local actor runtime
   (`bun run test:actors`; skipped without one). A flagged person's canvases,
   the ones they had and the ones they make, keep their frames and design
   history in a Terse canvas actor, browsers write edits straight to it, and
   the server folds them into the room, history and activity; everyone else's
   canvases are untouched, and turning the flag off brings a canvas back. */

const ROOT = process.cwd()
const ACTORS = !!process.env.TERSE_ACTOR_URL

describe.skipIf(!ACTORS)('canvas-actors', () => {
  let server: Server
  let ada: Client
  let bob: Client
  let canvas: Canvas
  let frame: Frame
  /** made before Ada had the flag */
  let earlier: Canvas
  let earlierFrame: Frame

  beforeAll(async () => {
    server = await startServer()
    ada = await new Client(server).signUp('ada@example.com', 'Ada')
    bob = await new Client(server).signUp('bob@example.com', 'Bob')
    earlier = await json<Canvas>(ada.post('/api/canvases', { name: 'Earlier' }))
    earlierFrame = await json<Frame>(
      ada.post(`/api/canvases/${earlier.id}/frames`, { name: 'Old', html: '<p>first draft</p>' }),
    )
    await json(
      ada.patch(`/api/frames/${earlierFrame.id}`, { html: '<main>Rewritten from scratch</main>', rotation: 30 }),
    )
    await until(async () => (await versionsOf(earlierFrame.id)).length > 0)
    await reboot(() => flags('enable', 'canvas-actors', 'ada@example.com'))
  }, 120_000)

  afterAll(() => server?.stop())

  it('leaves an unflagged person’s canvas as it is, with no actor', async () => {
    const plain = await json<Canvas>(bob.post('/api/canvases', { name: 'Plain' }))
    expect(plain.frameStore).toBeUndefined()
    expect((await bob.get(`/api/canvases/${plain.id}/actor`)).status).toBe(404)
  })

  it('moves a canvas its owner already had onto an actor when it is next opened', async () => {
    const before = await reboot(() => stored(earlier.id))
    expect(before).toMatchObject({ frameStore: null, htmlBytes: '<main>Rewritten from scratch</main>'.length })
    expect(before.versions).toBeGreaterThan(0)

    const read = await json<Canvas>(ada.get(`/api/canvases/${earlier.id}`))
    expect(read.frameStore).toBe('actor')
    expect(read.frames.find((f) => f.id === earlierFrame.id)).toMatchObject({
      html: '<main>Rewritten from scratch</main>',
      rotation: 30,
    })
    const held = (await actorSnapshot(ada, earlier.id)).frames.find((f) => f.id === earlierFrame.id)
    expect(held).toMatchObject({ html: '<main>Rewritten from scratch</main>', rotation: 30 })

    /* its history went along, and a version can still be read whole */
    const versions = await versionsOf(earlierFrame.id)
    expect(versions).toHaveLength(before.versions)
    const version = await json<{ html: string }>(ada.get(`/api/frames/${earlierFrame.id}/versions/${versions[0]!.id}`))
    expect(version.html).toBe('<p>first draft</p>')

    /* Postgres keeps the frame's row as an index, without its html or history */
    expect(await reboot(() => stored(earlier.id))).toEqual({
      frameStore: 'actor',
      frames: 1,
      htmlBytes: 0,
      versions: 0,
    })
  }, 60_000)

  it('gives a flagged person’s new canvas an actor, where server writes land', async () => {
    canvas = await json<Canvas>(ada.post('/api/canvases', { name: 'Dogfood' }))
    expect(canvas.frameStore).toBe('actor')
    frame = await json<Frame>(ada.post(`/api/canvases/${canvas.id}/frames`, { name: 'Hero', html: '<p>one</p>' }))
    await json(ada.patch(`/api/frames/${frame.id}`, { html: '<p>two</p>' }))
    await until(async () => (await actorSnapshot(ada)).frames.find((f) => f.id === frame.id)?.html === '<p>two</p>')
  })

  it('takes in an edit a browser writes straight to the actor', async () => {
    const room = await joinRoom(ada)
    const socket = await actorSocket(ada)
    const committed = await socket.edit(frame.id, { html: '<p>typed in the browser</p>', name: 'Hero, edited' })
    expect(committed).toMatchObject({ html: '<p>typed in the browser</p>', updatedBy: 'Ada' })

    /* the room carries it to everyone, as any edit */
    await until(() =>
      room.messages.some(
        (m) => m.type === 'frame:updated' && m.frame.id === frame.id && m.frame.html === '<p>typed in the browser</p>',
      ),
    )
    const read = await json<Canvas>(ada.get(`/api/canvases/${canvas.id}`))
    expect(read.frames.find((f) => f.id === frame.id)).toMatchObject({
      name: 'Hero, edited',
      html: '<p>typed in the browser</p>',
    })
    /* design history kept the state the edit replaced */
    expect((await versionsOf(frame.id)).length).toBeGreaterThan(0)
    socket.close()
    room.close()
  })

  it('keeps design history on the actor, not in Postgres', async () => {
    await json(ada.patch(`/api/frames/${frame.id}`, { html: '<p>replaced</p>' }))
    await until(async () => (await versionsOf(frame.id)).length > 1)
    const [newest] = await versionsOf(frame.id)
    const restored = await json<{ frame: Frame }>(
      ada.post(`/api/frames/${frame.id}/versions/${newest!.id}/restore`, {}),
    )
    expect(restored.frame.html).toBe('<p>typed in the browser</p>')
    expect((await reboot(() => stored(canvas.id))).versions).toBe(0)
  }, 60_000)

  it('refuses a read-only socket and keeps sign-off and page moves on the app API', async () => {
    const socket = await actorSocket(ada)
    await expect(socket.edit(frame.id, { pageId: 'elsewhere' } as never)).rejects.toThrow(/app API/)
    socket.close()
    expect((await bob.get(`/api/canvases/${canvas.id}/actor`)).status).toBe(403)
  })

  it('closes a removed member’s actor socket and refuses them a new one', async () => {
    await json(ada.post(`/api/canvases/${canvas.id}/members`, { email: 'bob@example.com' }))
    const socket = await actorSocket(bob)
    const members = await json<{ userId: string; name: string }[]>(ada.get(`/api/canvases/${canvas.id}/members`))
    const bobId = members.find((member) => member.name === 'Bob')!.userId
    expect((await ada.delete(`/api/canvases/${canvas.id}/members/${bobId}`)).status).toBe(200)
    await socket.closed
    expect((await bob.get(`/api/canvases/${canvas.id}/actor`)).status).toBe(403)
  })

  it('completes HTML a browser writes straight to the actor, as the app API would', async () => {
    await json(ada.post(`/api/canvases/${canvas.id}/tokens`, { name: '--brand', type: 'color', value: '#ff0000' }))
    const styled = await json<Frame>(
      ada.post(`/api/canvases/${canvas.id}/frames`, { name: 'Styled', html: '<p>plain</p>' }),
    )
    const socket = await actorSocket(ada)
    await socket.edit(styled.id, { html: '<p style="color: var(--brand)">branded</p>' })
    socket.close()
    /* the token's definition is added, on the server and back on the actor */
    const completed = (html: string | undefined) => !!html?.includes('data-doop-tokens') && html.includes('branded')
    await until(async () =>
      completed(
        (await json<Canvas>(ada.get(`/api/canvases/${canvas.id}`))).frames.find((f) => f.id === styled.id)?.html,
      ),
    )
    await until(async () => completed((await actorSnapshot(ada)).frames.find((f) => f.id === styled.id)?.html))
  })

  it('sends a deleted frame’s deletion to the actor once', async () => {
    const doomed = await json<Frame>(
      ada.post(`/api/canvases/${canvas.id}/frames`, { name: 'Doomed', html: '<p>x</p>' }),
    )
    await until(async () => (await actorSnapshot(ada)).frames.some((f) => f.id === doomed.id))
    expect((await ada.delete(`/api/frames/${doomed.id}`)).status).toBe(200)
    await until(async () => !(await actorSnapshot(ada)).frames.some((f) => f.id === doomed.id))
    /* every save moves the actor's revision on; a repeating delete would keep moving it */
    const settledAt = (await actorSnapshot(ada)).revision
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect((await actorSnapshot(ada)).revision).toBe(settledAt)
  })

  it('ends with the server and the actor agreeing when a browser and the server edit one frame at once', async () => {
    const socket = await actorSocket(ada)
    const writes: Promise<unknown>[] = []
    for (let i = 0; i < 15; i++) {
      writes.push(ada.patch(`/api/frames/${frame.id}`, { html: `<p>server ${i}</p>` }))
      writes.push(socket.edit(frame.id, { name: `Browser ${i}`, x: i }).catch(() => undefined))
    }
    await Promise.all(writes)
    socket.close()
    await until(async () => {
      const held = (await json<Canvas>(ada.get(`/api/canvases/${canvas.id}`))).frames.find((f) => f.id === frame.id)!
      const stored = (await actorSnapshot(ada)).frames.find((f) => f.id === frame.id)!
      return held.html === stored.html && held.name === stored.name && held.x === stored.x
    })
    /* and a browser edit after the burst still comes through */
    const after = await actorSocket(ada)
    await after.edit(frame.id, { html: '<p>typed in the browser</p>' })
    after.close()
    await until(
      async () =>
        (await json<Canvas>(ada.get(`/api/canvases/${canvas.id}`))).frames.find((f) => f.id === frame.id)?.html ===
        '<p>typed in the browser</p>',
    )
  })

  it('drops a deleted canvas’s asset refs, including ones still waiting to be written', async () => {
    const doomed = await json<Canvas>(ada.post('/api/canvases', { name: 'Doomed' }))
    const pictured = await json<Frame>(
      ada.post(`/api/canvases/${doomed.id}/frames`, { name: 'Pictured', html: '<img src="/a/kept.png">' }),
    )
    await new Promise((resolve) => setTimeout(resolve, 1000))
    await reboot(() => expect(assetRefs(pictured.id)).toEqual(['kept']))
    /* a browser edit leaves its refs to be written after a debounce; the canvas goes first */
    const socket = await actorSocket(ada, doomed.id)
    await socket.edit(pictured.id, { html: '<img src="/a/pending.png">' })
    socket.close()
    await until(async () =>
      (await json<Canvas>(ada.get(`/api/canvases/${doomed.id}`))).frames.some((f) => f.html.includes('pending')),
    )
    expect((await ada.delete(`/api/canvases/${doomed.id}`)).status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 1000))
    await reboot(() => expect(assetRefs(pictured.id)).toEqual([]))
  }, 60_000)

  it('holds no frame HTML after a restart until the canvas is opened, then reads it from the actor', async () => {
    await reboot()
    const atBoot = await loadedCanvases()
    const read = await json<Canvas>(ada.get(`/api/canvases/${canvas.id}`))
    expect(read.frameStore).toBe('actor')
    expect(read.frames.find((f) => f.id === frame.id)?.html).toBe('<p>typed in the browser</p>')
    expect(await loadedCanvases()).toBe(atBoot + 1)
  })

  it('takes in, when the canvas next loads, an edit a browser wrote while the server was down', async () => {
    const socket = await actorSocket(ada)
    await reboot(async () => {
      await socket.edit(frame.id, { html: '<p>typed while the server was away</p>', name: 'Hero, offline' })
    })
    socket.close()
    const read = await json<Canvas>(ada.get(`/api/canvases/${canvas.id}`))
    expect(read.frames.find((f) => f.id === frame.id)).toMatchObject({
      name: 'Hero, offline',
      html: '<p>typed while the server was away</p>',
    })
    /* the frame's row caught up, so the next boot lists it under its new name without asking the actor */
    await reboot()
    const listed = await json<{ id: string; frames: { id: string; name: string }[] }>(
      ada.get(`/api/canvases/${canvas.id}`),
    )
    expect(listed.frames.find((f) => f.id === frame.id)?.name).toBe('Hero, offline')
  }, 60_000)

  it('moves a canvas back to Postgres when it is opened after its owner’s flag went off', async () => {
    const history = (await versionsOf(frame.id)).length
    await reboot(() => flags('disable', 'canvas-actors', 'ada@example.com'))
    const read = await json<Canvas>(ada.get(`/api/canvases/${canvas.id}`))
    expect(read.frameStore).toBeUndefined()
    expect(read.frames.find((f) => f.id === frame.id)?.html).toBe('<p>typed while the server was away</p>')
    expect(await versionsOf(frame.id)).toHaveLength(history)
    expect((await ada.get(`/api/canvases/${canvas.id}/actor`)).status).toBe(404)
    /* an edit lands in Postgres again, and what Ada makes now is an ordinary canvas */
    await json(ada.patch(`/api/frames/${frame.id}`, { html: '<p>back home</p>' }))
    expect((await json<Canvas>(ada.post('/api/canvases', { name: 'After' }))).frameStore).toBeUndefined()
    const after = await reboot(() => stored(canvas.id))
    expect(after.frameStore).toBeNull()
    expect(after.htmlBytes).toBeGreaterThan(0)
    expect(after.versions).toBeGreaterThan(history)
    expect(await versionsOf(frame.id)).toHaveLength(history + 1)
  }, 60_000)

  it('moves every canvas the owner still has on an actor back with `flags move-back`', async () => {
    /* never opened since the flag went off, so still on its actor */
    await reboot(async () => {
      expect((await stored(earlier.id)).frameStore).toBe('actor')
      flags('move-back', 'ada@example.com')
    })
    const read = await json<Canvas>(ada.get(`/api/canvases/${earlier.id}`))
    expect(read.frameStore).toBeUndefined()
    expect(read.frames.find((f) => f.id === earlierFrame.id)).toMatchObject({
      html: '<main>Rewritten from scratch</main>',
      rotation: 30,
    })
    expect((await versionsOf(earlierFrame.id)).length).toBeGreaterThan(0)
  }, 60_000)

  /** Stop the server, run `between` against its database, start it again on the same one. */
  async function reboot<T = void>(between?: () => T | Promise<T>): Promise<T> {
    const { dataDir } = server
    const cookies = [new Map(ada.cookies), new Map(bob.cookies)] as const
    server.stop({ keepData: true })
    await server.stopped
    const result = (await between?.()) as T
    server = await startServer({}, dataDir)
    ada = new Client(server)
    ada.cookies = cookies[0]
    bob = new Client(server)
    bob.cookies = cookies[1]
    return result
  }

  function versionsOf(frameId: string): Promise<FrameVersionInfo[]> {
    return json<FrameVersionInfo[]>(ada.get(`/api/frames/${frameId}/versions`))
  }

  /** What Postgres holds of a canvas, read from the stopped server's PGlite. */
  function stored(canvasId: string): Stored {
    const script = path.join(server.dataDir, 'stored.mts')
    writeFileSync(
      script,
      [
        `import { eq } from ${JSON.stringify(path.join(ROOT, 'node_modules', 'drizzle-orm', 'index.js'))}`,
        `import { db, initDb } from ${JSON.stringify(path.join(ROOT, 'server', 'db', 'index.ts'))}`,
        `import * as t from ${JSON.stringify(path.join(ROOT, 'server', 'db', 'schema.ts'))}`,
        'await initDb()',
        `const id = ${JSON.stringify(canvasId)}`,
        'const [canvas] = await db.select().from(t.canvases).where(eq(t.canvases.id, id))',
        'const frames = await db.select().from(t.frames).where(eq(t.frames.canvasId, id))',
        'const versions = await db.select().from(t.frameVersions).where(eq(t.frameVersions.canvasId, id))',
        'console.log(JSON.stringify({',
        '  frameStore: canvas.frameStore,',
        '  frames: frames.length,',
        '  htmlBytes: frames.reduce((sum, frame) => sum + frame.html.length, 0),',
        '  versions: versions.length,',
        '}))',
        'process.exit()',
      ].join('\n'),
    )
    return JSON.parse(runScript(script).trim().split('\n').at(-1)!) as Stored
  }

  /** How many canvases have their frame HTML in the server's memory. */
  async function loadedCanvases(): Promise<number> {
    return ((await (await fetch(`${server.base}/healthz/store`)).json()) as { loaded: number }).loaded
  }

  /** `bun run flags …` against the stopped server's PGlite. */
  function flags(...args: string[]) {
    runScript(path.join(ROOT, 'scripts', 'feature-flags.ts'), args)
  }

  /** The assets asset_refs ties to a frame, read from the stopped server's PGlite. */
  function assetRefs(frameId: string): string[] {
    const script = path.join(server.dataDir, 'asset-refs.mts')
    writeFileSync(
      script,
      [
        `import { db, initDb } from ${JSON.stringify(path.join(ROOT, 'server', 'db', 'index.ts'))}`,
        `import { assetRefs } from ${JSON.stringify(path.join(ROOT, 'server', 'db', 'schema.ts'))}`,
        'await initDb()',
        'const rows = await db.select().from(assetRefs)',
        `const ids = rows.filter((row) => row.frameId === ${JSON.stringify(frameId)}).map((row) => row.assetId)`,
        'console.log(JSON.stringify(ids))',
        'process.exit()',
      ].join('\n'),
    )
    return JSON.parse(runScript(script).trim().split('\n').at(-1)!) as string[]
  }

  function runScript(script: string, args: string[] = []): string {
    const run = spawnSync(path.join(ROOT, 'node_modules', '.bin', 'tsx'), [script, ...args], {
      cwd: server.dataDir,
      env: { ...process.env, DATABASE_URL: '' },
      encoding: 'utf8',
    })
    if (run.status !== 0) throw new Error(`${path.basename(script)} ${args.join(' ')} failed: ${run.stderr}`)
    return run.stdout
  }

  async function actorSocket(client: Client, canvasId = canvas.id) {
    const { websocketUrl } = await json<{ websocketUrl: string }>(client.get(`/api/canvases/${canvasId}/actor`))
    const socket = new WebSocket(websocketUrl)
    const messages: unknown[] = []
    socket.on('message', (data) => messages.push(JSON.parse(String(data))))
    socket.on('error', () => {})
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
    await new Promise<void>((resolve) => socket.once('open', () => resolve()))
    return {
      messages,
      closed,
      async edit(frameId: string, patch: Partial<ActorFrame>): Promise<ActorFrame> {
        const requestId = crypto.randomUUID()
        socket.send(JSON.stringify({ type: 'edit', frameId, patch, requestId }))
        let answer: { frame?: ActorFrame; error?: string } | undefined
        await until(() => {
          for (const message of messages as Answer[]) {
            if (message.type === 'error' && message.requestId === requestId) answer = { error: message.message }
            const event = message.type === 'state_update' ? message.changes?.committed : undefined
            if (event?.type === 'frame-edit' && event.requestId === requestId) answer = { frame: event.frame }
          }
          return !!answer
        })
        if (answer?.error) throw new Error(answer.error)
        return answer!.frame!
      },
      close: () => socket.close(),
    }
  }

  async function actorSnapshot(client: Client, canvasId = canvas.id): Promise<FramesSnapshot> {
    const socket = await actorSocket(client, canvasId)
    await until(() => socket.messages.some((m) => (m as Answer).type === 'frames-snapshot'))
    socket.close()
    return socket.messages.find((m) => (m as Answer).type === 'frames-snapshot') as FramesSnapshot
  }

  async function joinRoom(client: Client) {
    const socket = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { Cookie: client.header() } })
    const messages: ServerMessage[] = []
    socket.on('message', (data) => messages.push(JSON.parse(String(data)) as ServerMessage))
    socket.on('error', () => {})
    await new Promise<void>((resolve) => socket.once('open', () => resolve()))
    socket.send(JSON.stringify({ type: 'join', canvasId: canvas.id, clientId: 'room', name: 'Room', kind: 'user' }))
    await until(() => messages.some((m) => m.type === 'init'))
    return { messages, close: () => socket.close() }
  }
})

type Stored = { frameStore: string | null; frames: number; htmlBytes: number; versions: number }

type Answer = {
  type: string
  requestId?: string
  message?: string
  changes?: { committed?: FramesEvent | null }
}

async function json<T>(response: Promise<Response>): Promise<T> {
  const res = await response
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
