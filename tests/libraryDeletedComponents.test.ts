import { rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness'

/* Soft-deleted components and workspace libraries, on the real server and database
   (billing off, so every workspace may have a library):
   - a library whose published Card is built from a deleted Button still publishes that
     Button, as a dependency only, so canvases using the Card get it whole;
   - a canvas that deleted a linked component keeps that component frozen when its
     library moves on, through sync_component and through update everywhere. */

const doc = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`

interface Def {
  id: string
  name: string
  rev: number
  template: string
  status?: string
  source?: { canvasId: string; rev: number; library?: boolean }
}
interface CanvasBody {
  components?: Def[]
  frames: { id: string; html: string }[]
}
interface LibraryBody {
  library: boolean
  changes: { id: string; name: string; change: string }[]
  updates: { id: string; name: string }[]
}
interface Offered {
  id: string
  library?: boolean
  components: { id: string; name: string }[]
}

describe('deleted components and the workspace library', () => {
  let server: Server
  let owner: Client

  const json = async <T>(res: Response) => (await res.json()) as T
  const canvasOf = async (id: string) => json<CanvasBody>(await owner.get(`/api/canvases/${id}`))
  const libraryOf = async (id: string) => json<LibraryBody>(await owner.get(`/api/canvases/${id}/library`))
  const workspace = async (name: string) =>
    (await json<{ id: string }>(await owner.post('/api/workspaces', { name }))).id
  const canvas = async (name: string, workspaceId: string) =>
    (await json<{ id: string }>(await owner.post('/api/canvases', { name, workspaceId }))).id
  const component = async (canvasId: string, name: string, html: string, css: string) => {
    const made = await owner.post(`/api/canvases/${canvasId}/components`, { name, html, css })
    expect(made.status, await made.clone().text()).toBe(200)
    return (await json<{ component: Def }>(made)).component.id
  }
  const frame = async (canvasId: string, body: string) => {
    const made = await owner.post(`/api/canvases/${canvasId}/frames`, { name: 'Hero', html: doc(body) })
    expect(made.status, await made.clone().text()).toBe(200)
    return (await json<{ id: string }>(made)).id
  }
  const htmlOf = async (canvasId: string, frameId: string) =>
    (await canvasOf(canvasId)).frames.find((entry) => entry.id === frameId)!.html
  /** Instances follow in the background: wait for the frame to show it. */
  async function until(canvasId: string, frameId: string, text: string) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const html = await htmlOf(canvasId, frameId)
      if (html.includes(text)) return html
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`the frame never showed ${text}`)
  }

  beforeAll(async () => {
    server = await startServer()
    owner = await new Client(server).signUp('owner@librarydeleted.test', 'Owner')
  }, 60_000)

  /* background writes can still be landing when the tests end: the data directory goes
     only once the server has exited, or the removal races its shutdown flush */
  afterAll(async () => {
    if (!server) return
    server.stop({ keepData: true })
    await server.stopped
    rmSync(server.dataDir, { recursive: true, force: true })
  })

  describe('publishing a component built from a deleted one', () => {
    let libraryId: string
    let workspaceId: string
    let buttonId: string
    let cardId: string

    beforeAll(async () => {
      workspaceId = await workspace('Publishing')
      libraryId = await canvas('Design system', workspaceId)
      buttonId = await component(
        libraryId,
        'Button',
        '<button class="btn"><span>Start</span></button>',
        '.btn { padding: 8px 14px }',
      )
      cardId = await component(
        libraryId,
        'Card',
        '<div class="card"><h2>Plan</h2><doop-use component="Button"></doop-use></div>',
        '.card { border: 1px solid }',
      )
      expect((await owner.delete(`/api/canvases/${libraryId}/components/${buttonId}`)).status).toBe(200)
    }, 60_000)

    it('publishes the deleted dependency with it, and offers only the component in use', async () => {
      const res = await owner.post(`/api/canvases/${libraryId}/library/publish`, {})
      expect(res.status, await res.clone().text()).toBe(200)
      const status = await libraryOf(libraryId)
      expect(status.changes.filter((entry) => entry.change === 'removed')).toEqual([])
      expect(status.changes.find((entry) => entry.id === cardId)?.change).toBe('unchanged')

      const consumerId = await canvas('Landing', workspaceId)
      const offered = await json<Offered[]>(await owner.get(`/api/canvases/${consumerId}/component-libraries`))
      expect(offered.find((entry) => entry.library)?.components.map((entry) => entry.name)).toEqual(['Card'])

      /* using the Card brings the Button it is built from: the card is whole */
      const heroId = await frame(consumerId, '<doop-use component="Card"></doop-use>')
      const html = await htmlOf(consumerId, heroId)
      expect(html).toContain('Plan')
      expect(html).toContain('class="btn"')
      expect(html).toContain('Start')
      const defs = (await canvasOf(consumerId)).components ?? []
      expect(defs.map((def) => def.id).sort()).toEqual([buttonId, cardId].sort())
      /* it arrives deleted, as it is in its library: there to render the Card, not to be used */
      expect(defs.find((def) => def.id === buttonId)?.status).toBe('deleted')
      /* and the deleted one cannot be taken up by name */
      const direct = await frame(consumerId, '<p>before</p><doop-use component="Button"></doop-use>')
      expect(await htmlOf(consumerId, direct)).not.toContain('Start')
    })

    it('keeps the dependency published when the component in use is published again', async () => {
      const edited = await owner.patch(`/api/canvases/${libraryId}/components/${cardId}`, {
        find: 'class="card"',
        replace: 'class="card v2"',
      })
      expect(edited.status, await edited.clone().text()).toBe(200)
      const res = await owner.post(`/api/canvases/${libraryId}/library/publish`, {})
      expect((await json<{ removed: unknown[] }>(res)).removed).toEqual([])

      const consumerId = await canvas('Pricing', workspaceId)
      const heroId = await frame(consumerId, '<doop-use component="Card"></doop-use>')
      const html = await htmlOf(consumerId, heroId)
      expect(html).toContain('card v2')
      expect(html).toContain('Start')
    })

    it('stops publishing it once nothing in use is built from it', async () => {
      const edited = await owner.patch(`/api/canvases/${libraryId}/components/${cardId}`, {
        html: '<div class="card v3"><h2>Plan</h2></div>',
      })
      expect(edited.status, await edited.clone().text()).toBe(200)
      const res = await owner.post(`/api/canvases/${libraryId}/library/publish`, {})
      const result = await json<{ removed: { id: string }[] }>(res)
      expect(result.removed.map((entry) => entry.id)).toEqual([buttonId])
    })
  })

  describe('a canvas that deleted a linked component', () => {
    let libraryId: string
    let chipId: string
    let panelId: string
    const consumers: { id: string; frameId: string; chip: Def }[] = []

    const chipOf = async (canvasId: string) => (await canvasOf(canvasId)).components!.find((def) => def.id === chipId)!

    beforeAll(async () => {
      const workspaceId = await workspace('Pulling')
      libraryId = await canvas('Kit', workspaceId)
      chipId = await component(libraryId, 'Chip', '<span class="chip">Chip</span>', '.chip { color: red }')
      panelId = await component(
        libraryId,
        'Panel',
        '<div class="panel"><h2>Panel</h2><doop-use component="Chip"></doop-use></div>',
        '.panel { margin: 4px }',
      )
      expect((await owner.post(`/api/canvases/${libraryId}/library/publish`, {})).status).toBe(200)
      for (const name of ['Synced', 'Pushed']) {
        const id = await canvas(name, workspaceId)
        const frameId = await frame(id, '<doop-use component="Panel"></doop-use>')
        /* this canvas deletes the Chip it took up with the Panel */
        expect((await owner.delete(`/api/canvases/${id}/components/${chipId}`)).status).toBe(200)
        consumers.push({ id, frameId, chip: await chipOf(id) })
      }
      /* the library moves both on, and publishes */
      for (const [id, find, replace] of [
        [chipId, 'class="chip"', 'class="chip v2"'],
        [panelId, 'class="panel"', 'class="panel v2"'],
      ] as const) {
        const edited = await owner.patch(`/api/canvases/${libraryId}/components/${id}`, { find, replace })
        expect(edited.status, await edited.clone().text()).toBe(200)
      }
      expect((await owner.post(`/api/canvases/${libraryId}/library/publish`, {})).status).toBe(200)
    }, 60_000)

    async function expectFrozen(consumer: (typeof consumers)[number]) {
      const html = await until(consumer.id, consumer.frameId, 'panel v2')
      /* the Panel is the new one; the Chip inside it is the one this canvas froze */
      expect(html).not.toContain('chip v2')
      expect(html).toContain('class="chip"')
      const chip = await chipOf(consumer.id)
      expect(chip.status).toBe('deleted')
      expect(chip.template).toBe(consumer.chip.template)
      expect(chip.rev).toBe(consumer.chip.rev)
      expect(chip.source?.rev).toBe(consumer.chip.source?.rev)
      /* nothing is left waiting: a deleted link is not an update to pull */
      expect((await libraryOf(consumer.id)).updates).toEqual([])
    }

    it('keeps it frozen when the component built from it is synced', async () => {
      const consumer = consumers[0]!
      expect((await libraryOf(consumer.id)).updates.map((entry) => entry.name)).toEqual(['Panel'])
      const res = await owner.post(`/api/canvases/${consumer.id}/components/${panelId}/sync`, {})
      expect(res.status, await res.clone().text()).toBe(200)
      await expectFrozen(consumer)
    })

    it('keeps it frozen when the library updates every canvas', async () => {
      const consumer = consumers[1]!
      const res = await owner.post(`/api/canvases/${libraryId}/library/update-consumers`, {})
      expect(res.status, await res.clone().text()).toBe(200)
      const report = await json<{ canvases: { canvas_id: string; updated: string[] }[] }>(res)
      expect(report.canvases).toMatchObject([{ canvas_id: consumer.id, updated: ['Panel'] }])
      await expectFrozen(consumer)
    })
  })
})
