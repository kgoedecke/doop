import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { drizzle as pgliteDrizzle } from 'drizzle-orm/pglite'
import { db } from '../server/db/index.ts'
import * as t from '../server/db/schema.ts'
import { flushFrameRows } from '../server/db/frameRows.ts'
import * as persist from '../server/db/persist.ts'
import { PostgresCanvas, type FrameConnection, type FrameSocketMessage } from '../server/postgresCanvas.ts'
import type { CanvasEvent, FrameChange, SocketMetadata } from '../src/actor.ts'
import type { Actor, Frame } from '../shared/types.ts'

/* A canvas whose frames are not in an actor keeps them in Postgres behind the
   actor's own methods and socket protocol (server/postgresCanvas.ts). */

vi.mock('../server/db/index.ts', async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const { drizzle } = await import('drizzle-orm/pglite')
  const schema = await import('../server/db/schema.ts')
  return { db: drizzle(new PGlite(), { schema }) }
})

beforeAll(async () => {
  const { migrate } = await import('drizzle-orm/pglite/migrator')
  await migrate(db as unknown as ReturnType<typeof pgliteDrizzle>, { migrationsFolder: 'server/db/migrations' })
}, 30_000)

describe('frames in Postgres', () => {
  it('writes frames through to the frames table and reads them back in a new process', async () => {
    const { id, canvas } = await openCanvas()
    const created = (await canvas.createFrame(frame(id, 'a', { html: '<p>one</p>' }), ADA, false))!
    expect(await storedHtml(created.id)).toBe('<p>one</p>')

    await canvas.write(created.id, { type: 'update', patch: { html: '<p>two</p>', name: 'Renamed' } }, ADA)
    await flushFrameRows()
    expect(await storedHtml(created.id)).toBe('<p>two</p>')

    const reopened = new PostgresCanvas(id)
    await reopened.initialize([PAGE])
    expect((await reopened.frame(created.id))?.name).toBe('Renamed')
  })

  it('places, stacks and refuses stale saves as the canvas actor does', async () => {
    const { id, canvas } = await openCanvas([PAGE, OTHER_PAGE])
    const first = (await canvas.createFrame(frame(id, 'a', { width: 200 }), ADA, true))!
    const second = (await canvas.createFrame(frame(id, 'b'), ADA, true))!
    expect(first.x).toBe(120)
    expect(second.x).toBe(120 + 200 + 80)
    expect(second.z!).toBeGreaterThan(first.z!)

    const stale = await canvas.write(first.id, { type: 'update', patch: { x: 5 }, expectedUpdatedAt: 1 }, ADA)
    expect(stale).toMatchObject({ type: 'conflict', frame: { id: first.id, x: 120 } })

    const elsewhere = (await canvas.createFrame(frame(id, 'c', { pageId: OTHER_PAGE.id, z: 500 }), ADA, false))!
    const moved = (await canvas.write(
      first.id,
      { type: 'update', patch: { pageId: OTHER_PAGE.id } },
      ADA,
    )) as FrameChange
    expect(moved.frame.z).toBe(elsewhere.z! + 1)
  })

  it('files design history in frame_versions once per burst', async () => {
    const { id, canvas } = await openCanvas()
    const created = (await canvas.createFrame(frame(id, 'a', { html: '<main>the first design</main>' }), ADA, false))!
    await canvas.write(created.id, { type: 'update', patch: { html: '<section>a rewrite</section>' } }, AGENT)
    await canvas.write(created.id, { type: 'update', patch: { html: '<section>a rewrite!</section>' } }, AGENT)
    const versions = await persist.listFrameVersions(created.id)
    expect(versions).toHaveLength(1)
    expect((await persist.getFrameVersion(created.id, versions[0]!.id))?.html).toBe('<main>the first design</main>')
  })

  it('keeps flow starts and page colours across page-list saves and keeps occupied pages', async () => {
    const { canvas, id } = await openCanvas([PAGE, OTHER_PAGE])
    await canvas.setPageBackground(PAGE.id, '#1e1e1e')
    await canvas.createFrame(frame(id, 'a', { pageId: OTHER_PAGE.id }), ADA, false)
    const current = (await canvas.snapshot()).pages
    expect(await canvas.setPages([{ ...PAGE, name: 'Renamed' }], current)).toMatchObject({ error: 'occupied' })
    expect(await canvas.setPages([{ ...PAGE, name: 'Renamed' }, OTHER_PAGE], [PAGE])).toMatchObject({
      error: 'conflict',
    })
    const saved = await canvas.setPages([{ id: PAGE.id, name: 'Renamed' }, OTHER_PAGE], current)
    expect(saved.pages[0]).toEqual({ id: PAGE.id, name: 'Renamed', background: '#1e1e1e' })
  })

  it('removes every frame of a deleted canvas', async () => {
    const { id, canvas } = await openCanvas()
    const created = (await canvas.createFrame(frame(id, 'a'), ADA, false))!
    await canvas.destroy()
    expect(await storedHtml(created.id)).toBeUndefined()
    expect(await canvas.snapshot()).toMatchObject({ deleted: true, frames: [] })
  })
})

describe('the canvas socket protocol', () => {
  it('sends a snapshot, then every committed change to every subscriber', async () => {
    const { id, canvas } = await openCanvas()
    const created = (await canvas.createFrame(frame(id, 'a'), ADA, false))!
    const author = subscriber()
    const watcher = subscriber()
    canvas.connect(author.connection)
    canvas.connect(watcher.connection)
    await canvas.snapshot()
    expect(watcher.received[0]).toMatchObject({ type: 'canvas-snapshot', frames: [{ id: created.id }] })

    canvas.receive(author.connection, {
      type: 'write',
      frameId: created.id,
      requestId: 'r1',
      write: { type: 'update', patch: { html: '<p>typed</p>' } },
    })
    await canvas.snapshot()
    const [change] = watcher.committed()
    expect(change).toMatchObject({
      type: 'frame-change',
      requestId: 'r1',
      frame: { html: '<p>typed</p>' },
      activity: { id: 'r1', frameId: created.id },
    })
    expect(author.committed()).toEqual([change])
  })

  it('relays a drag of the saved version to the others only', async () => {
    const { id, canvas } = await openCanvas()
    const created = (await canvas.createFrame(frame(id, 'a'), ADA, false))!
    const dragger = subscriber()
    const watcher = subscriber()
    canvas.connect(dragger.connection)
    canvas.connect(watcher.connection)
    const drag = { type: 'drag' as const, frameId: created.id, x: 40, y: 50, width: 100, height: 100 }
    canvas.receive(dragger.connection, { ...drag, updatedAt: created.updatedAt })
    canvas.receive(dragger.connection, { ...drag, x: 99, updatedAt: created.updatedAt - 1 })
    await canvas.snapshot()
    expect(watcher.received.filter((message) => message.type === 'drag')).toEqual([
      { ...drag, updatedAt: created.updatedAt },
    ])
    expect(dragger.received.some((message) => message.type === 'drag')).toBe(false)
  })

  it('refuses writes from a read-only socket and sign-off from any socket', async () => {
    const { id, canvas } = await openCanvas()
    const created = (await canvas.createFrame(frame(id, 'a'), ADA, false))!
    const viewer = subscriber({ actor: ADA, readOnly: true, accessVersion: 0 })
    const editor = subscriber()
    canvas.connect(viewer.connection)
    canvas.connect(editor.connection)
    canvas.receive(viewer.connection, {
      type: 'write',
      frameId: created.id,
      requestId: 'r1',
      write: { type: 'update', patch: { name: 'Nope' } },
    })
    canvas.receive(editor.connection, {
      type: 'write',
      frameId: created.id,
      requestId: 'r2',
      write: {
        type: 'update',
        patch: {
          approval: {
            status: 'ready_for_dev',
            approvedBy: 'x',
            approvedByUserId: 'x',
            approvedAt: 1,
            approvedFrameUpdatedAt: 1,
          },
        },
      },
    })
    await canvas.snapshot()
    expect(viewer.received.at(-1)).toEqual({
      type: 'error',
      requestId: 'r1',
      message: 'This connection is read only',
    })
    expect(editor.received.at(-1)).toMatchObject({ type: 'error', requestId: 'r2' })
    expect((await canvas.frame(created.id))?.name).toBe('a')
  })

  it('closes every socket when access changes and refuses tickets issued before', async () => {
    const { canvas } = await openCanvas()
    const before = subscriber()
    canvas.connect(before.connection)
    await canvas.revokeAccess()
    expect(before.closed).toEqual([4003])
    expect(await canvas.accessVersion()).toBe(1)

    const late = subscriber({ actor: ADA, readOnly: false, accessVersion: 0 })
    canvas.connect(late.connection)
    await canvas.snapshot()
    expect(late.closed).toEqual([4003])
    expect(late.received).toEqual([])
  })
})

const ADA: Actor = { name: 'Ada', kind: 'user', color: '#e5484d' }
const AGENT: Actor = { name: 'Claude', kind: 'agent', color: '#d97757' }
const PAGE = { id: 'page-1', name: 'Page 1' }
const OTHER_PAGE = { id: 'page-2', name: 'Page 2' }

async function openCanvas(pages = [PAGE]) {
  const id = randomUUID()
  const canvas = new PostgresCanvas(id)
  await canvas.initialize(pages)
  return { id, canvas }
}

function frame(canvasId: string, name: string, overrides: Partial<Frame> = {}): Frame {
  return {
    id: `${canvasId}.${name}`,
    canvasId,
    pageId: PAGE.id,
    name,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    html: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    updatedBy: ADA.name,
    ...overrides,
  }
}

async function storedHtml(frameId: string): Promise<string | undefined> {
  const [row] = await db.select({ html: t.frames.html }).from(t.frames).where(eq(t.frames.id, frameId))
  return row?.html
}

function subscriber(metadata: SocketMetadata = { actor: ADA, readOnly: false, accessVersion: 0 }) {
  const received: FrameSocketMessage[] = []
  const closed: number[] = []
  const connection: FrameConnection = {
    metadata,
    send: (message) => received.push(message),
    close: (code) => closed.push(code),
  }
  return {
    connection,
    received,
    closed,
    committed: (): CanvasEvent[] =>
      received.flatMap((message) => (message.type === 'state_update' ? [message.changes.committed] : [])),
  }
}
