import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import puppeteer, { type Browser } from 'puppeteer-core'
import type { Canvas, Frame, MemoryReference } from '../shared/types.ts'

/* Account/credential liveness seam only. Native privateMediaCache exercises real
   browser/MCP credentials and PG; all guards, store identities, cache and pixels here are real. */
vi.mock('../server/auth.ts', async (original) => ({
  ...(await original<typeof import('../server/auth.ts')>()),
  isBanned: async () => false,
}))
vi.mock('../server/db/persist.ts', async (original) => ({
  ...(await original<typeof import('../server/db/persist.ts')>()),
  saveFrame: vi.fn(),
  deleteReference: vi.fn(),
}))
import { store } from '../server/store.ts'
import { renderFrame } from '../server/screenshot.ts'
import { getImage } from '../server/previews.ts'
import {
  assertRenderRead,
  frameReadScope,
  referenceReadScope,
  type ResourceReader,
} from '../server/privateResources.ts'

const actorId = 'scope-reader'
const reader = { actorId, currentActor: async () => actorId }
const f: Frame = {
  id: 'frame-live',
  canvasId: 'scope-canvas',
  name: 'Live',
  html: '<!doctype html><html><body style="background:red">live</body></html>',
  width: 80,
  height: 60,
  x: 0,
  y: 0,
  createdAt: 0,
  updatedAt: 1,
  updatedBy: actorId,
}
const ref: MemoryReference = {
  id: 'ref-live',
  frameId: 'source-already-deleted',
  title: 'Pinned',
  html: f.html,
  width: f.width,
  height: f.height,
  pinnedAt: 0,
  pinnedBy: actorId,
}
const snapshot: Frame = { ...f, id: `reference-${ref.id}` }
let browser: Browser | undefined
let hold: { reached: (bytes: Uint8Array) => void; released: Promise<void> } | undefined
let shots = 0
let screenshotFailure: Error | undefined
function rendezvous() {
  let reached!: (bytes: Uint8Array) => void
  let release!: () => void
  const arrived = new Promise<Uint8Array>((resolve) => {
    reached = resolve
  })
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  hold = { reached, released }
  return { arrived, release }
}
beforeAll(() => {
  const launch = puppeteer.launch.bind(puppeteer)
  vi.spyOn(puppeteer, 'launch').mockImplementation(async (...args) => {
    browser = await launch(...args)
    const context = browser.createBrowserContext.bind(browser)
    vi.spyOn(browser, 'createBrowserContext').mockImplementation(async (...options) => {
      const created = await context(...options)
      const newPage = created.newPage.bind(created)
      vi.spyOn(created, 'newPage').mockImplementation(async () => {
        const page = await newPage()
        const screenshot = page.screenshot.bind(page)
        vi.spyOn(page, 'screenshot').mockImplementation(async (options) => {
          const bytes = await screenshot(options)
          shots++
          if (screenshotFailure) throw screenshotFailure
          const waiting = hold
          if (waiting) {
            waiting.reached(bytes)
            await waiting.released
          }
          return bytes
        })
        return page
      })
      return created
    })
    return browser
  })
})
beforeEach(() => {
  hold = undefined
  screenshotFailure = undefined
  store.init([
    {
      id: f.canvasId,
      name: 'Scope',
      ownerId: actorId,
      frames: [{ ...f }],
      references: [{ ...ref }],
      createdAt: 0,
      updatedAt: 0,
    } as Canvas,
  ])
})
afterAll(async () => {
  await browser?.close()
  vi.restoreAllMocks()
})

describe('live stored private render identities', () => {
  it('renders an independent pinned reference after its original source frame is gone', async () => {
    expect(store.getFrame(ref.frameId)).toBeUndefined()
    const bytes = await renderFrame(snapshot, referenceReadScope(reader, f.canvasId, ref.id))
    expect(bytes.length).toBeGreaterThan(100)
  })
  it('unpinning a reference after actual pixels exist denies its undelivered result while its canvas survives', async () => {
    const barrier = rendezvous()
    const pending = renderFrame(snapshot, referenceReadScope(reader, f.canvasId, ref.id))
    const refused = expect(pending).rejects.toThrow('private resource is not available')
    try {
      expect((await barrier.arrived).length).toBeGreaterThan(100)
      expect(store.deleteReference(f.canvasId, ref.id)).toBeDefined()
      expect(store.getCanvas(f.canvasId)).toBeDefined()
      barrier.release()
      await refused
    } finally {
      hold = undefined
      barrier.release()
      await pending.catch(() => {})
    }
  })
  it('a different current actor cannot replace the frozen reader or use a detached deleted frame', async () => {
    await expect(
      assertRenderRead(frameReadScope({ actorId, currentActor: async () => 'another-actor' }, f), f),
    ).rejects.toThrow('private resource')
    await expect(
      assertRenderRead(frameReadScope(reader, { ...f, id: 'absent' }), { ...f, id: 'absent' }),
    ).rejects.toThrow('private resource')
    await expect(
      assertRenderRead(referenceReadScope(reader, 'foreign-canvas', ref.id), {
        ...snapshot,
        canvasId: 'foreign-canvas',
      }),
    ).rejects.toThrow('private resource')
  })
  it('every shared cache waiter rechecks its own current credential after one actual render', async () => {
    const input = { ...f, id: 'shared-live', html: f.html + '<!--shared-->' }
    store.getCanvas(f.canvasId)!.frames.push(input)
    // Init rebuilds the real frame identity index for this synthetic stored fixture.
    store.init([store.getCanvas(f.canvasId)!])
    let valid = true
    let sawReader!: () => void
    const seen = new Promise<void>((resolve) => {
      sawReader = resolve
    })
    const secondReader = {
      actorId,
      currentActor: async () => {
        sawReader()
        return valid ? actorId : undefined
      },
    }
    const request = (r: ResourceReader) => ({
      ext: 'png' as const,
      scale: 1 as const,
      quality: 90,
      preview: false,
      scope: frameReadScope(r, input),
    })
    const before = shots
    const barrier = rendezvous()
    const first = getImage(input, request(reader))
    let second: Promise<unknown> | undefined
    try {
      await barrier.arrived
      second = getImage(input, request(secondReader))
      const denied = expect(second).rejects.toThrow('private resource')
      await seen
      for (let i = 0; i < 20; i++) await Promise.resolve()
      valid = false
      barrier.release()
      expect((await first).buf.length).toBeGreaterThan(100)
      await denied
      expect(shots - before).toBe(1)
    } finally {
      hold = undefined
      barrier.release()
      await first.catch(() => {})
      await second?.catch(() => {})
    }
  })
})

it('private credential failures discard raw driver diagnostics before any job render', async () => {
  const before = shots
  const failed = {
    actorId,
    currentActor: async () => {
      throw new Error('SELECT credential=private-synthetic-secret')
    },
  }
  const error = await renderFrame(f, frameReadScope(failed, f)).then(
    () => null,
    (failure: unknown) => failure,
  )
  expect(error).toMatchObject({ message: 'private read is temporarily unavailable' })
  expect(JSON.stringify(error)).not.toContain('private-synthetic-secret')
  expect((error as Error & { cause?: unknown }).cause).toBeUndefined()
  expect(shots).toBe(before)
})
it('actual private screenshot failures discard arbitrary browser diagnostics for background callers', async () => {
  screenshotFailure = new Error('https://user:private-synthetic-secret@private.invalid/frame-details')
  const error = await renderFrame(f, frameReadScope(reader, f)).then(
    () => null,
    (failure: unknown) => failure,
  )
  expect(error).toMatchObject({ message: 'private read is temporarily unavailable' })
  expect(String(error)).not.toContain('private-synthetic-secret')
  expect((error as Error & { cause?: unknown }).cause).toBeUndefined()
})
