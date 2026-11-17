import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  saveFrame: () => {},
  saveActivity: () => {},
  saveFrameVersion: () => {},
  saveTask: () => {},
  saveComponent: () => {},
  deleteComponent: () => {},
  saveLibraryComponent: () => {},
  saveCanvasCopy: async () => {},
  deleteLibraryComponent: () => {},
}))

/* a workspace is its id here: creating a real one writes to the database. Its
   publish setting is this switch, and its only admin the account named in it */
const policy = vi.hoisted(() => ({ adminsOnly: false, admin: '' }))
vi.mock('../server/workspaces.ts', async (original) => ({
  ...(await original<typeof import('../server/workspaces.ts')>()),
  getWorkspace: (id: string) => ({ id, name: 'Team' }),
  isActive: () => true,
  mayPublishLibrary: (_workspaceId: string, userId: string | undefined) =>
    !policy.adminsOnly || userId === policy.admin,
}))

import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import { getActivity } from '../server/actions.ts'
import { unpublishLibrary } from '../server/componentLibrary.ts'

/* The workspace library as an agent meets it: the same tools the resident
   agent runs (server/componentTools.ts), over MCP. */

const OWNER = 'owner-1'
const AGENT = { agent_name: 'Tester' }

let client: Client

type ToolResponse = { content: { type: string; text?: string }[]; isError?: boolean }

async function call(
  name: string,
  args: Record<string, unknown>,
  // eslint-disable-next-line typescript/no-explicit-any
): Promise<{ data: any; text: string; isError: boolean }> {
  const response = (await client.callTool({ name, arguments: { ...AGENT, ...args } })) as ToolResponse
  const texts = response.content.flatMap((block) => (block.type === 'text' ? [block.text ?? ''] : []))
  let data: unknown
  try {
    data = JSON.parse(texts[0] ?? '')
  } catch {
    data = undefined
  }
  return { data, text: texts.join('\n'), isError: !!response.isError }
}

let workspaces = 0
const createWorkspace = (_name: string, _owner: string) => ({ id: `ws-${++workspaces}` })

function workspaceCanvas(name: string, workspaceId: string) {
  const canvas = store.createCanvas(name, OWNER)
  store.setWorkspace(canvas.id, workspaceId)
  return canvas
}

async function card(canvasId: string) {
  await call('create_component', {
    canvas_id: canvasId,
    name: 'Card',
    description: 'A titled surface',
    html: '<article class="card"><h3>Title</h3></article>',
    css: '.card { padding: 16px; border-radius: 12px }',
  })
}

beforeEach(async () => {
  policy.adminsOnly = false
  policy.admin = ''
  for (const c of store.allCanvases()) {
    unpublishLibrary(c.id)
    store.canvases.delete(c.id)
  }
  const server = buildMcpServer('Owner', OWNER)
  client = new Client({ name: 'library-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  await client.connect(a)
})

afterEach(async () => {
  await client.close()
})

describe('workspace library tools', () => {
  it('publishes, lists the library on other canvases, and resolves it by name on write', async () => {
    const workspace = createWorkspace('Team', OWNER)
    const library = workspaceCanvas('Design system', workspace.id)
    const consumer = workspaceCanvas('Landing', workspace.id)
    await card(library.id)

    const dry = await call('publish_library', { canvas_id: library.id, dry_run: true })
    expect(dry.data.published.map((entry: { name: string }) => entry.name)).toEqual(['Card'])
    expect((await call('get_canvas', { canvas_id: consumer.id })).data.workspaceLibraries).toBeUndefined()

    const published = await call('publish_library', { canvas_id: library.id })
    expect(published.isError).toBe(false)
    expect(published.data.is_library).toBe(true)
    expect(published.data.still_unpublished).toEqual([])

    const canvas = await call('get_canvas', { canvas_id: consumer.id })
    expect(canvas.data.workspaceLibraries[0]).toMatchObject({ canvas_id: library.id, canvas_name: 'Design system' })
    expect(canvas.data.workspaceLibraries[0].components[0].usage).toContain('<doop-use component="Card"')

    const frame = await call('create_frame', {
      canvas_id: consumer.id,
      name: 'Screen',
      html: '<!doctype html><html><head></head><body><doop-use component="Card"></doop-use></body></html>',
    })
    expect(frame.isError).toBe(false)
    const listed = await call('list_components', { canvas_id: consumer.id })
    expect(listed.data.components[0]).toMatchObject({ name: 'Card', instances: 1, library: { canvas_id: library.id } })
    /* in use now, so no longer offered as something to add */
    expect(listed.data.workspace_libraries).toBeUndefined()
  })

  it("refuses to publish or withdraw for someone the workspace's setting leaves out", async () => {
    const workspace = createWorkspace('Team', OWNER)
    const library = workspaceCanvas('Design system', workspace.id)
    await card(library.id)
    expect((await call('publish_library', { canvas_id: library.id })).isError).toBe(false)
    await call('update_component', { canvas_id: library.id, component: 'Card', find: 'Title', replace: 'Heading' })

    policy.adminsOnly = true
    for (const args of [{}, { dry_run: true }, { unpublish: true }]) {
      const refused = await call('publish_library', { canvas_id: library.id, ...args })
      expect(refused.isError).toBe(true)
      expect(refused.text).toContain('limited to its owner and admins')
    }

    /* the agent publishes as the account it works for: an admin's agent still may,
       and finds the change the refusals left unpublished */
    policy.admin = OWNER
    const published = await call('publish_library', { canvas_id: library.id })
    expect(published.isError).toBe(false)
    expect(published.data.published.map((entry: { name: string }) => entry.name)).toEqual(['Card'])
    expect(published.data.is_library).toBe(true)
  })

  it('reports an update only after a publish, and sync_component pulls it', async () => {
    const workspace = createWorkspace('Team', OWNER)
    const library = workspaceCanvas('Design system', workspace.id)
    const consumer = workspaceCanvas('Landing', workspace.id)
    await card(library.id)
    await call('publish_library', { canvas_id: library.id })
    await call('import_component', { canvas_id: consumer.id, source_canvas_id: library.id, component: 'Card' })

    /* a dry run on the library counts its own canvas, and names who else follows it */
    const dry = await call('update_component', {
      canvas_id: library.id,
      component: 'Card',
      find: 'Title',
      replace: 'Heading',
      dry_run: true,
    })
    expect(dry.data.impact.instances).toBe(0)
    expect(dry.data.library_used_by).toEqual([{ canvas_id: consumer.id, canvas_name: 'Landing', components: ['Card'] }])
    expect(dry.text).toContain('The impact counts this canvas only')
    /* find + replace is for the template: text that is in the CSS says so */
    const inCss = await call('update_component', {
      canvas_id: library.id,
      component: 'Card',
      find: 'border-radius: 12px',
      replace: 'border-radius: 16px',
    })
    expect(inCss.isError).toBe(true)
    expect(inCss.text).toContain('pass the whole changed stylesheet as css')

    await call('update_component', { canvas_id: library.id, component: 'Card', find: 'Title', replace: 'Heading' })
    const before = await call('list_components', { canvas_id: consumer.id })
    expect(before.data.components[0].library_update_available).toBeUndefined()

    const republished = await call('publish_library', { canvas_id: library.id })
    /* the publish says where it still has to be pulled */
    expect(republished.data.used_by).toEqual([
      { canvas_id: consumer.id, canvas_name: 'Landing', components: ['Card'], update_waiting: ['Card'] },
    ])
    const waiting = await call('list_components', { canvas_id: consumer.id })
    expect(waiting.data.components[0].library_update_available).toBeDefined()

    const refused = await call('update_component', {
      canvas_id: consumer.id,
      component: 'Card',
      find: 'Title',
      replace: 'X',
    })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('workspace library')

    /* without a component: every update waiting on the canvas */
    const synced = await call('sync_component', { canvas_id: consumer.id })
    expect(synced.data).toMatchObject({ updated: true, components: ['Card'] })
    /* a link counts in publications: its revision is the one it now shows */
    const linked = (await call('get_component', { canvas_id: consumer.id, component: 'Card' })).data
    expect(linked.rev).toBe(linked.library.rev)
    expect(linked.rev).toBe(waiting.data.components[0].library_update_available.to_rev)
    expect((await call('sync_component', { canvas_id: consumer.id })).data.updated).toBe(false)
    const edited = await call('update_component', {
      canvas_id: library.id,
      component: 'Card',
      find: 'Heading',
      replace: 'Headline',
    })
    expect(edited.text).toContain('This canvas is a workspace library')
    expect((await call('get_component', { canvas_id: consumer.id, component: 'Card' })).data.template).toContain(
      'Heading',
    )
  })

  it('brings along what a published component is built from, even from another library', async () => {
    const workspace = createWorkspace('Team', OWNER)
    const kit = workspaceCanvas('Design system', workspace.id)
    const pricing = workspaceCanvas('Pricing', workspace.id)
    const landing = workspaceCanvas('Landing', workspace.id)
    await card(kit.id)
    await call('publish_library', { canvas_id: kit.id })
    /* Pricing builds its own component out of the kit's, and publishes that */
    const plan = await call('create_component', {
      canvas_id: pricing.id,
      name: 'Plan',
      html: '<section class="plan"><doop-use component="Card"></doop-use><p>Per seat</p></section>',
      css: '.plan { padding: 24px }',
    })
    expect(plan.isError).toBe(false)
    const published = await call('publish_library', { canvas_id: pricing.id })
    expect(published.data.published.map((entry: { name: string }) => entry.name)).toEqual(['Plan'])

    const imported = await call('import_component', {
      canvas_id: landing.id,
      source_canvas_id: pricing.id,
      component: 'Plan',
    })
    expect(imported.isError).toBe(false)
    const listed = await call('list_components', { canvas_id: landing.id })
    const byName = Object.fromEntries(
      listed.data.components.map((entry: { name: string; library: { canvas_id: string } }) => [
        entry.name,
        entry.library.canvas_id,
      ]),
    )
    expect(byName).toEqual({ Card: kit.id, Plan: pricing.id })
  })

  it('updates every canvas using the library in one call, only where the account may edit', async () => {
    const workspace = createWorkspace('Team', OWNER)
    const library = workspaceCanvas('Design system', workspace.id)
    const landing = workspaceCanvas('Landing', workspace.id)
    const pricing = workspaceCanvas('Pricing', workspace.id)
    /* in the workspace, but nothing this account may open: workspace membership is not real here */
    const theirs = store.createCanvas('Theirs', 'someone-else')
    store.setWorkspace(theirs.id, workspace.id)
    await card(library.id)
    await call('publish_library', { canvas_id: library.id })
    const screen = '<!doctype html><html><head></head><body><doop-use component="Card"></doop-use></body></html>'
    for (const consumer of [landing, pricing]) {
      const made = await call('create_frame', { canvas_id: consumer.id, name: 'Screen', html: screen })
      expect(made.isError).toBe(false)
    }
    store.saveComponent(theirs.id, store.getComponents(landing.id)[0]!)

    /* nothing is behind yet: it says so and touches nothing */
    const early = await call('update_library_everywhere', { canvas_id: library.id })
    expect(early.data).toMatchObject({ dry_run: false, canvases: [], skipped: [] })
    expect(early.text).toContain('already has its latest publication')

    await call('update_component', { canvas_id: library.id, component: 'Card', find: 'Title', replace: 'Heading' })
    const republished = await call('publish_library', { canvas_id: library.id })
    /* publishing pushed nothing, and points at the explicit tool */
    expect(republished.text).toContain('update_library_everywhere')
    expect(landing.frames[0]!.html).toContain('Title')

    const dry = await call('update_library_everywhere', { canvas_id: library.id, dry_run: true })
    expect(dry.isError).toBe(false)
    expect(dry.data.dry_run).toBe(true)
    expect(dry.data.canvases).toEqual([
      { canvas_id: landing.id, canvas_name: 'Landing', updated: ['Card'], frames_changed: 1, approvals_withdrawn: 0 },
      { canvas_id: pricing.id, canvas_name: 'Pricing', updated: ['Card'], frames_changed: 1, approvals_withdrawn: 0 },
    ])
    /* the canvas this account cannot open is counted, not named */
    expect(dry.data.skipped).toEqual([expect.objectContaining({ reason: 'no_edit_access' })])
    expect(dry.data.skipped[0].canvas_id).toBeUndefined()
    expect(dry.text).toContain('nothing was changed')
    expect(landing.frames[0]!.html).toContain('Title')
    expect(pricing.frames[0]!.html).toContain('Title')

    const done = await call('update_library_everywhere', { canvas_id: library.id })
    expect(done.isError).toBe(false)
    expect(done.data.canvases).toEqual(dry.data.canvases)
    expect(done.data.skipped).toHaveLength(1)
    expect(done.text).toContain('Updated 2 canvases')
    for (const consumer of [landing, pricing]) {
      expect(consumer.frames[0]!.html).toContain('Heading')
      expect(consumer.frames[0]!.html).not.toContain('Title')
      expect((await call('list_components', { canvas_id: consumer.id })).data.components[0]).not.toHaveProperty(
        'library_update_available',
      )
      /* one line on each canvas that names the library it came from */
      expect(getActivity(consumer.id).filter((item) => item.message.includes('“Design system”'))).toHaveLength(1)
    }
    expect(store.getComponents(theirs.id)[0]!.template).toContain('Title')
    expect((await call('publish_library', { canvas_id: library.id, dry_run: true })).data.used_by).toEqual([
      { canvas_id: landing.id, canvas_name: 'Landing', components: ['Card'] },
      { canvas_id: pricing.id, canvas_name: 'Pricing', components: ['Card'] },
    ])
  })

  it('refuses to update everywhere from a canvas that has not published', async () => {
    const workspace = createWorkspace('Team', OWNER)
    const plain = workspaceCanvas('Landing', workspace.id)
    const refused = await call('update_library_everywhere', { canvas_id: plain.id })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('has not published a library')
    const personal = store.createCanvas('Mine', OWNER)
    expect((await call('update_library_everywhere', { canvas_id: personal.id })).text).toContain('Team plan')
  })

  it('follows the library a nested component is linked to, not another publishing the same id', async () => {
    const workspace = createWorkspace('Team', OWNER)
    const kit = workspaceCanvas('Kit', workspace.id)
    await card(kit.id)
    /* a copied canvas keeps its component ids: two libraries now publish a "Card" under one id */
    const copy = (await store.duplicateCanvas(kit.id, OWNER, 'Owner', { name: 'Kit copy', workspaceId: workspace.id }))!
    await call('update_component', { canvas_id: copy.id, component: 'Card', find: 'Title', replace: 'Copied' })
    await call('publish_library', { canvas_id: kit.id })
    await call('publish_library', { canvas_id: copy.id })

    const pricing = workspaceCanvas('Pricing', workspace.id)
    await call('import_component', { canvas_id: pricing.id, source_canvas_id: copy.id, component: 'Card' })
    await call('create_component', {
      canvas_id: pricing.id,
      name: 'Plan',
      html: '<section class="plan"><doop-use component="Card"></doop-use></section>',
    })
    await call('publish_library', { canvas_id: pricing.id, components: ['Plan'] })

    const landing = workspaceCanvas('Landing', workspace.id)
    await call('import_component', { canvas_id: landing.id, source_canvas_id: pricing.id, component: 'Plan' })
    const nested = (await call('get_component', { canvas_id: landing.id, component: 'Card' })).data
    expect(nested.library.canvas_id).toBe(copy.id)
    expect(nested.template).toContain('Copied')
  })

  it('refuses a pull that needs a component this canvas has as its own, and changes nothing', async () => {
    const workspace = createWorkspace('Team', OWNER)
    const kit = workspaceCanvas('Kit', workspace.id)
    await card(kit.id)
    await call('publish_library', { canvas_id: kit.id })
    /* the consumer is a copy of the kit, so it has its own Card under the kit's id */
    const consumer = (await store.duplicateCanvas(kit.id, OWNER, 'Owner', { name: 'Site', workspaceId: workspace.id }))!

    const pricing = workspaceCanvas('Pricing', workspace.id)
    await call('create_component', {
      canvas_id: pricing.id,
      name: 'Plan',
      html: '<section class="plan"><p>Per seat</p></section>',
    })
    await call('publish_library', { canvas_id: pricing.id })
    await call('import_component', { canvas_id: consumer.id, source_canvas_id: pricing.id, component: 'Plan' })
    const before = (await call('get_component', { canvas_id: consumer.id, component: 'Plan' })).data

    /* the next publication of Plan is built from the kit's Card */
    await call('import_component', { canvas_id: pricing.id, source_canvas_id: kit.id, component: 'Card' })
    await call('update_component', {
      canvas_id: pricing.id,
      component: 'Plan',
      html: '<section class="plan"><doop-use component="Card"></doop-use><p>Per seat</p></section>',
    })
    await call('publish_library', { canvas_id: pricing.id, components: ['Plan'] })

    const pulled = await call('sync_component', { canvas_id: consumer.id, component: 'Plan' })
    expect(pulled.isError).toBe(true)
    expect(pulled.text).toContain('nothing was changed')
    const after = (await call('get_component', { canvas_id: consumer.id, component: 'Plan' })).data
    expect(after.rev).toBe(before.rev)
    expect(after.template).toBe(before.template)
    /* and it still shows as waiting, rather than as taken */
    expect(after.library_update_available).toBeDefined()
  })

  it('says what is in the way on a personal canvas', async () => {
    const personal = store.createCanvas('Mine', OWNER)
    await card(personal.id)
    const refused = await call('publish_library', { canvas_id: personal.id })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('Team plan')
  })

  it('asks which library when two publish the same name', async () => {
    const workspace = createWorkspace('Team', OWNER)
    const first = workspaceCanvas('Web kit', workspace.id)
    const second = workspaceCanvas('App kit', workspace.id)
    const consumer = workspaceCanvas('Landing', workspace.id)
    for (const library of [first, second]) {
      await card(library.id)
      await call('publish_library', { canvas_id: library.id })
    }
    const frame = await call('create_frame', {
      canvas_id: consumer.id,
      name: 'Screen',
      html: '<!doctype html><html><head></head><body><doop-use component="Card"></doop-use></body></html>',
    })
    expect(frame.text).toContain('more than one library')
    const picked = await call('import_component', {
      canvas_id: consumer.id,
      source_canvas_id: second.id,
      component: 'Card',
    })
    expect(picked.data.component.library.canvas_id).toBe(second.id)
  })
})
