import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness'

/* "Update everywhere" on the real server and database: one request from the
   library's side pulls its latest publication into every canvas of the
   workspace using it. The server is restarted first and canvases go idle
   before the real run (CANVAS_IDLE_MS is short), so no consumer has its frame
   HTML in memory when it is reached: each has to be loaded to be rewritten. */

const env = { CANVAS_IDLE_MS: '1500' }
const doc = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`

interface FrameBody {
  id: string
  html: string
  updatedAt: number
  approval?: { status: string }
}
interface CanvasBody {
  frames: FrameBody[]
}
interface LibraryBody {
  updates: { id: string; name: string }[]
  behind?: { id: string; name: string; components: string[] }[]
}
interface Report {
  dry_run: boolean
  canvases: {
    canvas_id: string
    canvas_name: string
    updated: string[]
    frames_changed: number
    approvals_withdrawn: number
  }[]
  skipped: { canvas_id?: string; canvas_name?: string; reason: string; message: string }[]
}

describe('update everywhere', () => {
  let server: Server
  let owner: Client
  let workspaceId: string
  let libraryId: string
  let consumers: { id: string; name: string }[]

  const json = async <T>(res: Response) => (await res.json()) as T
  const canvasOf = async (id: string) => json<CanvasBody>(await owner.get(`/api/canvases/${id}`))
  const libraryOf = async (id: string) => json<LibraryBody>(await owner.get(`/api/canvases/${id}/library`))
  const create = async (name: string) =>
    (await json<{ id: string }>(await owner.post('/api/canvases', { name, workspaceId }))).id
  const update = (client: Client, body: object = {}) =>
    client.post(`/api/canvases/${libraryId}/library/update-consumers`, body)
  /** canvases with frame HTML in memory, as /healthz/store reports it */
  const loadedCanvases = async () =>
    ((await (await fetch(`${server.base}/healthz/store`)).json()) as { loaded: number }).loaded

  beforeAll(async () => {
    const first = await startServer(env)
    owner = await new Client(first).signUp('owner@everywhere.test', 'Owner')
    workspaceId = (await json<{ id: string }>(await owner.post('/api/workspaces', { name: 'Team' }))).id
    libraryId = await create('Design system')
    const made = await owner.post(`/api/canvases/${libraryId}/components`, {
      name: 'Button',
      html: '<button class="btn"><span>Start</span></button>',
      css: '.btn { padding: 8px 14px }',
    })
    expect(made.status, await made.clone().text()).toBe(200)
    expect((await owner.post(`/api/canvases/${libraryId}/library/publish`, {})).status).toBe(200)

    consumers = []
    for (const name of ['Landing', 'Pricing', 'Docs']) {
      const id = await create(name)
      const frame = await owner.post(`/api/canvases/${id}/frames`, {
        name: 'Hero',
        html: doc('<doop-use component="Button"></doop-use>'),
      })
      expect(frame.status).toBe(200)
      consumers.push({ id, name })
    }
    /* Landing's frame is signed off: the update has to take that back */
    const hero = (await canvasOf(consumers[0]!.id)).frames[0]!
    const approved = await owner.put(`/api/frames/${hero.id}/approval`, {
      status: 'ready_for_dev',
      expectedUpdatedAt: hero.updatedAt,
    })
    expect(approved.status, await approved.clone().text()).toBe(200)

    const edit = await owner.patch(`/api/canvases/${libraryId}/components/Button`, { find: 'Start', replace: 'Begin' })
    expect(edit.status, await edit.clone().text()).toBe(200)
    expect((await owner.post(`/api/canvases/${libraryId}/library/publish`, {})).status).toBe(200)

    first.stop({ keepData: true })
    await first.stopped
    server = await startServer(env, first.dataDir)
    owner = new Client(server)
    const signIn = await owner.post('/api/auth/sign-in/email', {
      email: 'owner@everywhere.test',
      password: 'password12345',
    })
    expect(signIn.status).toBe(200)
  }, 120_000)

  afterAll(() => server?.stop())

  it('tells the library which canvases are on an older version', async () => {
    const status = await libraryOf(libraryId)
    expect(status.behind?.map((entry) => entry.name).sort()).toEqual(['Docs', 'Landing', 'Pricing'])
    expect(status.behind?.[0]?.components).toEqual(['Button'])
    const listed = await json<{ id: string; usedBy: number; behind: number }[]>(
      await owner.get(`/api/workspaces/${workspaceId}/libraries`),
    )
    expect(listed).toMatchObject([{ id: libraryId, usedBy: 3, behind: 3 }])
    /* a canvas that only uses the library has nobody behind it */
    expect((await libraryOf(consumers[0]!.id)).behind).toEqual([])
  })

  it('skips, and reports, the canvases the caller may not edit', async () => {
    /* someone outside the workspace who may edit the library canvas by its link,
       and only look at one of the canvases using it */
    expect((await owner.patch(`/api/canvases/${libraryId}`, { linkAccess: 'edit' })).status).toBe(200)
    expect((await owner.patch(`/api/canvases/${consumers[0]!.id}`, { linkAccess: 'view' })).status).toBe(200)
    const guest = await new Client(server).signUp('guest@everywhere.test', 'Guest')

    const res = await update(guest)
    expect(res.status, await res.clone().text()).toBe(200)
    const report = await json<Report>(res)
    expect(report.canvases).toEqual([])
    expect(report.skipped).toHaveLength(3)
    expect(report.skipped.every((entry) => entry.reason === 'no_edit_access')).toBe(true)
    /* named only where the guest can open the canvas */
    expect(report.skipped.flatMap((entry) => entry.canvas_name ?? [])).toEqual(['Landing'])
    expect(report.skipped.flatMap((entry) => entry.canvas_id ?? [])).toEqual([consumers[0]!.id])
    /* and the library's own count of who is behind shows a guest only that one */
    const seen = await json<LibraryBody>(await guest.get(`/api/canvases/${libraryId}/library`))
    expect(seen.behind?.map((entry) => entry.name)).toEqual(['Landing'])

    expect((await libraryOf(libraryId)).behind).toHaveLength(3)
    expect((await owner.patch(`/api/canvases/${libraryId}`, { linkAccess: 'none' })).status).toBe(200)
    expect((await update(guest)).status).toBe(403)
  })

  it('a dry run reports every canvas and changes none', async () => {
    const res = await update(owner, { dryRun: true })
    expect(res.status, await res.clone().text()).toBe(200)
    const report = await json<Report>(res)
    expect(report.dry_run).toBe(true)
    expect(report.skipped).toEqual([])
    expect(report.canvases.map((entry) => entry.canvas_name).sort()).toEqual(['Docs', 'Landing', 'Pricing'])
    for (const entry of report.canvases) {
      expect(entry.updated).toEqual(['Button'])
      expect(entry.frames_changed).toBe(1)
      expect(entry.approvals_withdrawn).toBe(0)
    }
    for (const consumer of consumers) {
      const frame = (await canvasOf(consumer.id)).frames[0]!
      expect(frame.html).toContain('Start')
      expect(frame.html).not.toContain('Begin')
      expect((await libraryOf(consumer.id)).updates).toHaveLength(1)
    }
    expect((await canvasOf(consumers[0]!.id)).frames[0]!.approval?.status).toBe('ready_for_dev')
  })

  it('updates every canvas, loading the ones whose frame HTML is not in memory', async () => {
    await expect.poll(loadedCanvases, { timeout: 10_000, interval: 250 }).toBe(0)

    const res = await update(owner)
    expect(res.status, await res.clone().text()).toBe(200)
    const report = await json<Report>(res)
    expect(report.dry_run).toBe(false)
    expect(report.skipped).toEqual([])
    expect(report.canvases.map((entry) => entry.canvas_name).sort()).toEqual(['Docs', 'Landing', 'Pricing'])
    for (const entry of report.canvases) {
      expect(entry.updated).toEqual(['Button'])
      expect(entry.frames_changed).toBe(1)
      expect(entry.approvals_withdrawn).toBe(0)
    }

    for (const consumer of consumers) {
      const frame = (await canvasOf(consumer.id)).frames[0]!
      expect(frame.html).toContain('Begin')
      expect(frame.html).not.toContain('Start')
      expect((await libraryOf(consumer.id)).updates).toEqual([])
    }
    /* a frame following its components keeps its sign-off */
    expect((await canvasOf(consumers[0]!.id)).frames[0]!.approval?.status).toBe('ready_for_dev')
    expect((await libraryOf(libraryId)).behind).toEqual([])
  }, 30_000)

  it('has nothing left to do afterwards, and is refused on a canvas that is not a library', async () => {
    const again = await json<Report>(await update(owner))
    expect(again.canvases).toEqual([])
    expect(again.skipped).toEqual([])

    const res = await owner.post(`/api/canvases/${consumers[0]!.id}/library/update-consumers`, {})
    expect(res.status).toBe(400)
    expect((await json<{ error: string }>(res)).error).toContain('has not published a library')

    const personal = (await json<{ id: string }>(await owner.post('/api/canvases', { name: 'Mine' }))).id
    const walled = await owner.post(`/api/canvases/${personal}/library/update-consumers`, {})
    expect(walled.status).toBe(402)
  })
})
