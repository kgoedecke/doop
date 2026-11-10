import { beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type { drizzle as pgliteDrizzle } from 'drizzle-orm/pglite'
import { db } from '../server/db/index.ts'

/* Boot keeps every canvas and frame in memory but not frame HTML, which
   loads per canvas (store.load) and is dropped again when the canvas goes
   idle (store.evictIdle). */
vi.mock('../server/db/index.ts', async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const { drizzle } = await import('drizzle-orm/pglite')
  const schema = await import('../server/db/schema.ts')
  return { db: drizzle(new PGlite(), { schema }) }
})

const persist = await import('../server/db/persist.ts')
const { store } = await import('../server/store.ts')
const { FrameHtmlNotLoadedError, htmlLoaded } = await import('../server/frameHtml.ts')

const HOUR = 60 * 60_000

beforeAll(async () => {
  const { migrate } = await import('drizzle-orm/pglite/migrator')
  await migrate(db as unknown as ReturnType<typeof pgliteDrizzle>, { migrationsFolder: 'server/db/migrations' })
})

beforeEach(() => store.setInUse(() => false))

/** A canvas with two frames written to the database, then booted again:
 *  what the store holds after a restart. */
async function bootedCanvas(name: string) {
  const canvas = store.createCanvas(name, 'owner')
  const first = store.createFrame(canvas.id, { name: 'First', html: '<p>first</p>' }, 'owner')!
  const second = store.createFrame(canvas.id, { name: 'Second', html: '<p>second</p>' }, 'owner')!
  await persist.saveFrameNow(first)
  await persist.saveFrameNow(second)
  const { canvases } = await persist.hydrate()
  store.init(canvases.filter((c) => c.id === canvas.id))
  return { canvasId: canvas.id, firstId: first.id, secondId: second.id }
}

it('boots frames without html, which throws until the canvas is loaded', async () => {
  const { canvasId, firstId } = await bootedCanvas('Boot')
  const frame = store.getFrame(firstId)!
  expect(frame.name).toBe('First')
  expect(store.isLoaded(canvasId)).toBe(false)
  expect(() => frame.html).toThrow(FrameHtmlNotLoadedError)

  const [a, b] = await Promise.all([store.load(canvasId), store.load(canvasId)])
  expect(a).toBe(b)
  expect(store.getFrame(firstId)!.html).toBe('<p>first</p>')
  expect(store.isLoaded(canvasId)).toBe(true)
})

it('starts loading a canvas whose html was read too early, so a retry works', async () => {
  const { canvasId, secondId } = await bootedCanvas('Miss')
  expect(() => store.getFrame(secondId)!.html).toThrow(FrameHtmlNotLoadedError)
  await expect.poll(() => store.isLoaded(canvasId)).toBe(true)
  expect(store.getFrame(secondId)!.html).toBe('<p>second</p>')
})

it('keeps html written while the load was in flight instead of the stored copy', async () => {
  const { canvasId, firstId, secondId } = await bootedCanvas('Write first')
  const loading = store.load(canvasId)
  store.getFrame(firstId)!.html = '<p>newer</p>'
  await loading
  expect(store.getFrame(firstId)!.html).toBe('<p>newer</p>')
  expect(store.getFrame(secondId)!.html).toBe('<p>second</p>')
})

it('drops an idle canvas, but not one held, in use or waiting on a write', async () => {
  const { canvasId, firstId } = await bootedCanvas('Evict')
  await store.load(canvasId)
  const at = (hours: number) => Date.now() + hours * HOUR

  const release = store.hold(canvasId)
  store.evictIdle(HOUR / 2, at(1))
  expect(store.isLoaded(canvasId)).toBe(true)
  release()

  store.setInUse((id) => id === canvasId)
  store.evictIdle(HOUR / 2, at(2))
  expect(store.isLoaded(canvasId)).toBe(true)
  store.setInUse(() => false)

  /* in use restarted the idle wait: the canvas is not idle yet */
  store.evictIdle(HOUR / 2, at(2.25))
  expect(store.isLoaded(canvasId)).toBe(true)

  store.updateFrame(firstId, { x: 40 }, 'owner') // debounced write pending
  store.evictIdle(HOUR / 2, at(3))
  expect(store.isLoaded(canvasId)).toBe(true)
  await persist.saveFrameNow(store.getFrame(firstId)!)

  store.evictIdle(HOUR / 2, at(4))
  expect(store.isLoaded(canvasId)).toBe(false)
  expect(htmlLoaded(store.getFrame(firstId)!)).toBe(false)
  expect(store.getFrame(firstId)!.x).toBe(40)

  await store.load(canvasId)
  expect(store.getFrame(firstId)!.html).toBe('<p>first</p>')
})

it('renders one frame of an unloaded canvas without loading the canvas', async () => {
  const { canvasId, secondId } = await bootedCanvas('Render')
  const frame = await store.renderableFrame(secondId)
  expect(frame?.html).toBe('<p>second</p>')
  expect(frame?.name).toBe('Second')
  expect(store.isLoaded(canvasId)).toBe(false)
  expect(htmlLoaded(store.getFrame(secondId)!)).toBe(false)
})

it('loads the source canvas of a copy', async () => {
  const { canvasId } = await bootedCanvas('Copy source')
  const copy = await store.duplicateCanvas(canvasId, 'owner', 'owner')
  expect(copy!.frames.map((frame) => frame.html).sort()).toEqual(['<p>first</p>', '<p>second</p>'])
  expect(store.isLoaded(copy!.id)).toBe(true)
})

it('keeps a canvas while a frame write is in flight, and drops it once the write lands', async () => {
  const { canvasId, firstId } = await bootedCanvas('In flight')
  await store.load(canvasId)
  const later = Date.now() + HOUR
  store.getFrame(firstId)!.html = '<p>unsaved</p>'
  const writing = persist.saveFrameNow(store.getFrame(firstId)!)
  store.evictIdle(HOUR / 2, later)
  expect(store.isLoaded(canvasId)).toBe(true)
  await writing
  store.evictIdle(HOUR / 2, later)
  expect(store.isLoaded(canvasId)).toBe(false)
  await store.load(canvasId)
  expect(store.getFrame(firstId)!.html).toBe('<p>unsaved</p>')
})

it('holds the canvases a tool call names until the tool returns', async () => {
  const { withArgsCanvases } = await import('../server/toolLoads.ts')
  const { canvasId, firstId } = await bootedCanvas('Tool hold')
  const later = Date.now() + HOUR
  const html = await withArgsCanvases({ frame_id: firstId }, async () => {
    store.evictIdle(HOUR / 2, later)
    return store.getFrame(firstId)!.html
  })
  expect(html).toBe('<p>first</p>')
  store.evictIdle(HOUR / 2, later + HOUR)
  expect(store.isLoaded(canvasId)).toBe(false)
})
