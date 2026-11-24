import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness'

/* The real server and database (billing off, so every workspace may have a
   library): publishing snapshots, using a published component by name and by
   import, updates that wait to be pulled, and what a personal canvas is told. */

const doc = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`

interface Def {
  id: string
  name: string
  description?: string
  rev: number
  mainFrameId: string | null
  template: string
  source?: { canvasId: string; rev: number; library?: boolean }
}
interface CanvasBody {
  components?: Def[]
  tokens?: { name: string; value: string }[]
  frames: { id: string; html: string }[]
  pages?: { id: string; name: string }[]
  landingPageId?: string
}
interface LibraryBody {
  entitled: boolean
  canPublish: boolean
  blocked?: string
  library: boolean
  changes: { id: string; name: string; change: string }[]
  updates: { id: string; name: string }[]
}

describe('workspace component library', () => {
  let server: Server
  let owner: Client
  let workspaceId: string
  let libraryId: string
  let consumerId: string
  let buttonId: string

  const json = async <T>(res: Response) => (await res.json()) as T
  const canvasOf = async (id: string) => json<CanvasBody>(await owner.get(`/api/canvases/${id}`))
  const libraryOf = async (id: string) => json<LibraryBody>(await owner.get(`/api/canvases/${id}/library`))

  beforeAll(async () => {
    server = await startServer()
    owner = await new Client(server).signUp('owner@library.test', 'Owner')
    workspaceId = (await json<{ id: string }>(await owner.post('/api/workspaces', { name: 'Team' }))).id
    libraryId = (await json<{ id: string }>(await owner.post('/api/canvases', { name: 'Design system', workspaceId })))
      .id
    consumerId = (await json<{ id: string }>(await owner.post('/api/canvases', { name: 'Landing', workspaceId }))).id
    await owner.post(`/api/canvases/${libraryId}/tokens`, {
      tokens: [{ name: '--brand', type: 'color', value: '#0177d3' }],
    })
    const made = await owner.post(`/api/canvases/${libraryId}/components`, {
      name: 'Button',
      html: '<button class="btn"><span>Start</span></button>',
      css: '.btn { padding: 8px 14px; background: var(--brand); color: #fff }',
    })
    expect(made.status, await made.clone().text()).toBe(200)
    buttonId = (await json<{ component: Def }>(made)).component.id
  }, 60_000)

  afterAll(() => server?.stop())

  it('offers nothing until the library publishes', async () => {
    const status = await libraryOf(libraryId)
    expect(status.entitled).toBe(true)
    expect(status.library).toBe(false)
    expect(status.changes).toEqual([{ id: buttonId, name: 'Button', change: 'new' }])
    const offered = await json<{ library?: boolean }[]>(
      await owner.get(`/api/canvases/${consumerId}/component-libraries`),
    )
    expect(offered.filter((entry) => entry.library)).toEqual([])
    /* with nothing published it opens on its first page, as any canvas does */
    expect((await canvasOf(libraryId)).landingPageId).toBeUndefined()
  })

  it('publishes a snapshot', async () => {
    expect((await libraryOf(libraryId)).library).toBe(false)

    const res = await owner.post(`/api/canvases/${libraryId}/library/publish`, {})
    expect(res.status, await res.clone().text()).toBe(200)
    expect((await json<{ published: unknown[] }>(res.clone())).published).toHaveLength(1)
    const status = await libraryOf(libraryId)
    expect(status.library).toBe(true)
    expect(status.changes[0]!.change).toBe('unchanged')

    const offered = await json<{ id: string; library?: boolean; components: { name: string }[] }[]>(
      await owner.get(`/api/canvases/${consumerId}/component-libraries`),
    )
    const shared = offered.find((entry) => entry.library)
    expect(shared?.id).toBe(libraryId)
    expect(shared?.components.map((entry) => entry.name)).toEqual(['Button'])
  })

  it('tells the editor to open a library on the page its published mains are on', async () => {
    const canvas = await canvasOf(libraryId)
    const components = canvas.pages?.find((page) => page.name === 'Components')
    expect(components).toBeDefined()
    expect(canvas.pages?.[0]?.id).not.toBe(components?.id)
    expect(canvas.landingPageId).toBe(components?.id)
    /* a canvas that only uses the library is not one */
    expect((await canvasOf(consumerId)).landingPageId).toBeUndefined()
  })

  it('a frame naming a published component takes it up, linked and without a main', async () => {
    const frame = await owner.post(`/api/canvases/${consumerId}/frames`, {
      name: 'Hero',
      html: doc('<doop-use component="Button"></doop-use>'),
    })
    expect(frame.status).toBe(200)
    const canvas = await canvasOf(consumerId)
    const def = canvas.components?.find((entry) => entry.id === buttonId)
    expect(def?.source).toMatchObject({ canvasId: libraryId, library: true })
    expect(def?.mainFrameId).toBeNull()
    expect(canvas.frames).toHaveLength(1)
    expect(canvas.frames[0]!.html).toContain(`data-doop-instance="${buttonId}"`)
    expect(canvas.frames[0]!.html).toContain('padding: 8px 14px')
    /* the token its CSS names came along, and the frame resolves it */
    expect(canvas.tokens?.map((token) => token.name)).toContain('--brand')
    expect(canvas.frames[0]!.html).toContain('--brand:#0177d3')
  })

  it('refuses to change a linked component away from its library', async () => {
    const res = await owner.patch(`/api/canvases/${consumerId}/components/${buttonId}`, {
      html: '<button class="btn">Changed here</button>',
    })
    expect(res.status).toBe(400)
    expect((await json<{ error: string }>(res)).error).toContain('workspace library')
  })

  it('keeps work in progress to itself until it is published, then offers an update', async () => {
    const edit = await owner.patch(`/api/canvases/${libraryId}/components/${buttonId}`, {
      find: 'Start',
      replace: 'Begin',
    })
    expect(edit.status, await edit.clone().text()).toBe(200)
    expect((await libraryOf(consumerId)).updates).toEqual([])
    expect((await libraryOf(libraryId)).changes[0]!.change).toBe('changed')

    await owner.post(`/api/canvases/${libraryId}/library/publish`, {})
    expect((await libraryOf(consumerId)).updates.map((entry) => entry.id)).toEqual([buttonId])
    /* never pushed: the consumer still shows what it had */
    expect((await canvasOf(consumerId)).frames[0]!.html).toContain('Start')
  })

  it('pulls the update into every instance on request', async () => {
    const res = await owner.post(`/api/canvases/${consumerId}/components/${buttonId}/sync`, {})
    expect(res.status, await res.clone().text()).toBe(200)
    expect((await json<{ updated: boolean }>(res)).updated).toBe(true)
    const canvas = await canvasOf(consumerId)
    expect(canvas.frames[0]!.html).toContain('Begin')
    expect(canvas.frames[0]!.html).not.toContain('Start')
    expect(canvas.components?.find((entry) => entry.id === buttonId)?.mainFrameId).toBeNull()
    expect((await libraryOf(consumerId)).updates).toEqual([])
  })

  it('offers a change that leaves the revision alone, such as a new description', async () => {
    const edit = await owner.patch(`/api/canvases/${libraryId}/components/${buttonId}`, {
      description: 'The primary action',
    })
    expect(edit.status).toBe(200)
    await owner.post(`/api/canvases/${libraryId}/library/publish`, {})
    expect((await libraryOf(consumerId)).updates.map((entry) => entry.id)).toEqual([buttonId])
    await owner.post(`/api/canvases/${consumerId}/components/${buttonId}/sync`, {})
    const def = (await canvasOf(consumerId)).components?.find((entry) => entry.id === buttonId)
    expect(def?.description).toBe('The primary action')
    expect((await libraryOf(consumerId)).updates).toEqual([])
  })

  it('brings the tokens an update starts naming', async () => {
    await owner.post(`/api/canvases/${libraryId}/tokens`, {
      tokens: [{ name: '--accent', type: 'color', value: '#ff5500' }],
    })
    const edit = await owner.patch(`/api/canvases/${libraryId}/components/${buttonId}`, {
      css: '.btn { padding: 8px 14px; background: var(--brand); color: var(--accent) }',
    })
    expect(edit.status, await edit.clone().text()).toBe(200)
    await owner.post(`/api/canvases/${libraryId}/library/publish`, {})
    expect((await canvasOf(consumerId)).tokens?.map((token) => token.name)).not.toContain('--accent')
    await owner.post(`/api/canvases/${consumerId}/components/${buttonId}/sync`, {})
    const canvas = await canvasOf(consumerId)
    expect(canvas.tokens?.map((token) => token.name)).toContain('--accent')
    expect(canvas.frames[0]!.html).toContain('--accent:#ff5500')
    /* previews resolve tokens too: the canvas's own, and a library's before it is used here */
    const own = await json<{ html: string }>(
      await owner.get(`/api/canvases/${libraryId}/components/${buttonId}/preview`),
    )
    expect(own.html).toContain('--accent:#ff5500')
    const fresh = (await json<{ id: string }>(await owner.post('/api/canvases', { name: 'Fresh', workspaceId }))).id
    const offered = await json<{ html: string }>(
      await owner.get(`/api/canvases/${fresh}/components/${buttonId}/preview?library=${libraryId}`),
    )
    expect(offered.html).toContain('--accent:#ff5500')
  })

  it('treats a pasted main of a linked component as an instance, not a new main', async () => {
    const before = (await canvasOf(consumerId)).components?.find((entry) => entry.id === buttonId)
    const pasted = await owner.post(`/api/canvases/${consumerId}/frames`, {
      name: 'Pasted',
      html: doc(`<button class="btn" data-doop-component="${buttonId}"><span>Hijacked</span></button>`),
    })
    expect(pasted.status).toBe(200)
    const pastedId = (await json<{ id: string }>(pasted)).id
    const canvas = await canvasOf(consumerId)
    const def = canvas.components?.find((entry) => entry.id === buttonId)
    expect(def?.mainFrameId).toBeNull()
    expect(def?.source?.library).toBe(true)
    expect(def?.template).toBe(before?.template)
    const frame = canvas.frames.find((entry) => entry.id === pastedId)
    expect(frame?.html).toContain(`data-doop-instance="${buttonId}"`)
    expect(frame?.html).not.toContain('data-doop-component=')
    expect(frame?.html).not.toContain('Hijacked')
  })

  it("lists the workspace's libraries for its members only", async () => {
    const listed = await json<{ id: string; components: number; usedBy: number }[]>(
      await owner.get(`/api/workspaces/${workspaceId}/libraries`),
    )
    expect(listed).toMatchObject([{ id: libraryId, components: 1, usedBy: 1 }])
    const stranger = await new Client(server).signUp('stranger@library.test', 'Stranger')
    expect((await stranger.get(`/api/workspaces/${workspaceId}/libraries`)).status).toBe(404)
    /* nor can someone outside the workspace reach its library through a canvas of their own */
    const theirs = (await json<{ id: string }>(await stranger.post('/api/canvases', { name: 'Theirs' }))).id
    const grab = await stranger.post(`/api/canvases/${theirs}/components/import`, {
      sourceCanvasId: libraryId,
      component: 'Button',
    })
    expect(grab.status).toBe(403)
  })

  it('imports by request too, and survives a withdrawn library', async () => {
    const other = (await json<{ id: string }>(await owner.post('/api/canvases', { name: 'Pricing', workspaceId }))).id
    const imported = await owner.post(`/api/canvases/${other}/components/import`, {
      sourceCanvasId: libraryId,
      component: 'Button',
    })
    expect(imported.status, await imported.clone().text()).toBe(200)
    expect((await json<Def>(imported)).source?.library).toBe(true)
    expect((await canvasOf(other)).frames).toHaveLength(0)

    const gone = await owner.delete(`/api/canvases/${libraryId}/library`)
    expect(gone.status).toBe(200)
    expect((await libraryOf(libraryId)).library).toBe(false)
    const canvas = await canvasOf(consumerId)
    expect(canvas.components?.some((entry) => entry.id === buttonId)).toBe(true)
    expect(canvas.frames[0]!.html).toContain(`data-doop-instance="${buttonId}"`)
  })

  it('keeps publishing to the owner and admins when the workspace says so', async () => {
    const member = await new Client(server).signUp('member@library.test', 'Member')
    const admin = await new Client(server).signUp('admin@library.test', 'Admin')
    await owner.post(`/api/workspaces/${workspaceId}/members`, { email: 'member@library.test' })
    await owner.post(`/api/workspaces/${workspaceId}/members`, { email: 'admin@library.test', role: 'admin' })
    const kit = (await json<{ id: string }>(await owner.post('/api/canvases', { name: 'Kit', workspaceId }))).id
    await member.post(`/api/canvases/${kit}/components`, { name: 'Tag', html: '<span class="tag">New</span>' })
    const statusFor = async (who: Client) => json<LibraryBody>(await who.get(`/api/canvases/${kit}/library`))
    const policyOf = async () =>
      (await json<{ libraryPublish: string }>(await owner.get(`/api/workspaces/${workspaceId}`))).libraryPublish

    /* the default: whoever can edit the canvas publishes */
    expect(await policyOf()).toBe('everyone')
    expect((await statusFor(member)).canPublish).toBe(true)
    expect((await member.post(`/api/canvases/${kit}/library/publish`, {})).status).toBe(200)
    expect((await statusFor(member)).library).toBe(true)

    /* the setting is an admin's to change, and takes one of two values */
    expect((await member.patch(`/api/workspaces/${workspaceId}`, { libraryPublish: 'admins' })).status).toBe(403)
    expect((await owner.patch(`/api/workspaces/${workspaceId}`, { libraryPublish: 'nobody' })).status).toBe(400)
    const set = await admin.patch(`/api/workspaces/${workspaceId}`, { libraryPublish: 'admins' })
    expect(set.status).toBe(200)
    expect((await json<{ name: string }>(set)).name).toBe('Team')
    expect(await policyOf()).toBe('admins')

    await member.post(`/api/canvases/${kit}/components`, { name: 'Pill', html: '<span class="pill">Beta</span>' })
    expect((await statusFor(member)).canPublish).toBe(false)
    expect((await statusFor(admin)).canPublish).toBe(true)
    for (const refused of [
      await member.post(`/api/canvases/${kit}/library/publish`, {}),
      await member.delete(`/api/canvases/${kit}/library`),
    ]) {
      expect(refused.status).toBe(403)
      expect((await json<{ error: string }>(refused)).error).toContain('limited to its owner and admins')
    }
    /* the refusals changed nothing: Tag is still shared, Pill still waits */
    expect((await statusFor(member)).changes.map((entry) => entry.change).sort()).toEqual(['new', 'unchanged'])
    /* using the library is not publishing: the member still takes a component up */
    const used = await member.post(`/api/canvases/${consumerId}/components/import`, {
      sourceCanvasId: kit,
      component: 'Tag',
    })
    expect(used.status, await used.clone().text()).toBe(200)

    const published = await admin.post(`/api/canvases/${kit}/library/publish`, {})
    expect(published.status).toBe(200)
    expect((await json<{ published: { name: string }[] }>(published)).published.map((entry) => entry.name)).toEqual([
      'Pill',
    ])
    expect((await owner.delete(`/api/canvases/${kit}/library`)).status).toBe(200)

    expect((await owner.patch(`/api/workspaces/${workspaceId}`, { libraryPublish: 'everyone' })).status).toBe(200)
    expect((await statusFor(member)).canPublish).toBe(true)
  })

  it('tells a personal canvas that a library needs a workspace', async () => {
    const personal = (await json<{ id: string }>(await owner.post('/api/canvases', { name: 'Mine' }))).id
    await owner.post(`/api/canvases/${personal}/components`, { name: 'Chip', html: '<span class="chip">New</span>' })
    const status = await libraryOf(personal)
    expect(status.entitled).toBe(false)
    expect(status.blocked).toBe('no_workspace')
    const res = await owner.post(`/api/canvases/${personal}/library/publish`, {})
    expect(res.status).toBe(402)
    expect((await json<{ error: string }>(res)).error).toBe('library_needs_workspace')
  })
})
