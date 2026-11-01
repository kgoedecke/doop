import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'
import type { LibrarySnapshot } from '../shared/designSystem.ts'
import type { Frame } from '../shared/types.ts'

let server: Server
let owner: Client
let visitor: Client
beforeAll(async () => {
  server = await startServer()
  owner = new Client(server)
  await owner.signUp('library-owner@test.dev', 'Library Owner')
  visitor = new Client(server)
  await visitor.signUp('library-visitor@test.dev', 'Link Visitor')
}, 60_000)
afterAll(() => server?.stop())

const library = (client: Client, canvasId: string) => client.get(`/api/library?canvas=${canvasId}`)
const getFrame = async (client: Client, canvasId: string, frameId: string): Promise<Frame> => {
  const canvas = await (await client.get(`/api/canvases/${canvasId}`)).json()
  return canvas.frames.find((f: Frame) => f.id === frameId)
}

const button = {
  name: 'Button',
  slug: 'button',
  groupId: 'buttons',
  kind: 'Button',
  description: 'The primary action',
  html: '<button class="button">Go</button>',
  css: '.button { background: var(--color-primary); }',
  js: '',
  variants: [{ name: 'Ghost', html: '<button class="button button--ghost">Go</button>' }],
}

it('stamps components into frames, restamps them on edits, gates writes and survives a restart', async () => {
  const canvas = await (await owner.post('/api/canvases', { name: 'Library' })).json()

  const empty: LibrarySnapshot = await (await library(owner, canvas.id)).json()
  expect(empty).toEqual(
    expect.objectContaining({ scope: expect.stringMatching(/^user:/), initialized: false, canEdit: true }),
  )
  expect(empty.groups.map((g) => g.id)).toContain('buttons')

  const created = await owner.post(`/api/library/components?canvas=${canvas.id}`, button)
  expect(created.status).toBe(200)
  const snapshot: LibrarySnapshot = await created.json()
  expect(snapshot.initialized).toBe(true)
  const [component] = snapshot.components
  /* the root is marked as an instance, the variant too */
  expect(component!.html).toBe('<button class="button" data-doop-component="button" data-name="Button">Go</button>')
  expect(component!.variants[0]!.html).toContain('data-doop-component="button"')

  /* a frame naming the component is stamped on save */
  const frame: Frame = await (
    await owner.post(`/api/canvases/${canvas.id}/frames`, {
      name: 'Screen',
      html: `<!doctype html><html><head></head><body>${component!.html}</body></html>`,
    })
  ).json()
  expect(frame.html).toContain('<style data-doop-library="css:button">')
  expect(frame.html).toContain('<style data-doop-library="tokens">')

  /* editing the component restamps every frame that uses it */
  const edited = await owner.req(`/api/library/components/${component!.id}?canvas=${canvas.id}`, {
    method: 'PUT',
    body: JSON.stringify({ css: '.button { background: hotpink; }' }),
  })
  expect(edited.status).toBe(200)
  expect((await getFrame(owner, canvas.id, frame.id)).html).toContain('hotpink')

  /* renaming the slug points the frame's instances at the new one */
  await owner.req(`/api/library/components/${component!.id}?canvas=${canvas.id}`, {
    method: 'PUT',
    body: JSON.stringify({ slug: 'action' }),
  })
  const renamed = await getFrame(owner, canvas.id, frame.id)
  expect(renamed.html).toContain('data-doop-component="action"')
  expect(renamed.html).toContain('data-doop-library="css:action"')
  expect(renamed.html).not.toContain('css:button')

  /* a share-link editor edits the canvas, never the owner's personal library */
  await owner.patch(`/api/canvases/${canvas.id}`, { linkAccess: 'edit' })
  expect((await library(visitor, canvas.id)).status).toBe(200)
  const denied = await visitor.post(`/api/library/components?canvas=${canvas.id}`, { ...button, slug: 'x' })
  expect(denied.status).toBe(403)
  await owner.patch(`/api/canvases/${canvas.id}`, { linkAccess: 'none' })
  expect((await library(visitor, canvas.id)).status).toBe(403)

  /* validation */
  const clash = await owner.post(`/api/library/components?canvas=${canvas.id}`, { ...button, slug: 'action' })
  expect(clash.status).toBe(409)
  const noGroup = await owner.post(`/api/library/components?canvas=${canvas.id}`, {
    ...button,
    slug: 'y',
    groupId: 'nope',
  })
  expect(noGroup.status).toBe(400)

  /* custom groups: added, used, and only deletable when empty */
  const withGroup: LibrarySnapshot = await (
    await owner.post(`/api/library/groups?canvas=${canvas.id}`, { name: 'Marketing' })
  ).json()
  const marketing = withGroup.groups.find((g) => g.name === 'Marketing')!
  expect(marketing.preset).toBe(false)
  const hero = await owner.post(`/api/library/components?canvas=${canvas.id}`, {
    name: 'Hero',
    groupId: marketing.id,
    html: '<section class="hero">Hi</section>',
  })
  expect(hero.status).toBe(200)
  expect((await owner.delete(`/api/library/groups/${marketing.id}?canvas=${canvas.id}`)).status).toBe(409)

  /* deleting a component keeps the look of frames already using it */
  await owner.delete(`/api/library/components/${component!.id}?canvas=${canvas.id}`)
  expect((await getFrame(owner, canvas.id, frame.id)).html).toContain('data-doop-library="css:action"')

  /* the library is the owner's: another canvas of theirs draws from it */
  const second = await (await owner.post('/api/canvases', { name: 'Library 2' })).json()
  const shared: LibrarySnapshot = await (await library(owner, second.id)).json()
  expect(shared.components.map((c) => c.slug)).toEqual(['hero'])

  await new Promise((resolve) => setTimeout(resolve, 600))
  server.stop({ keepData: true })
  await server.stopped
  server = await startServer({}, server.dataDir)
  const persisted: LibrarySnapshot = await (await library(owner, canvas.id)).json()
  expect(persisted.initialized).toBe(true)
  expect(persisted.components.map((c) => c.slug)).toEqual(['hero'])
  expect(persisted.groups.some((g) => g.name === 'Marketing')).toBe(true)
}, 90_000)

it('gives a workspace one library for its members', async () => {
  const ws = await (await owner.post('/api/workspaces', { name: 'Team' })).json()
  const snapshot: LibrarySnapshot = await (await owner.get(`/api/library?workspace=${ws.id}`)).json()
  expect(snapshot.scope).toBe(`workspace:${ws.id}`)
  expect((await visitor.get(`/api/library?workspace=${ws.id}`)).status).toBe(404)

  const styles = await owner.put(`/api/library/styles?workspace=${ws.id}`, { globalCss: ':root { --brand: red; }' })
  expect(styles.status).toBe(200)
  expect(((await styles.json()) as LibrarySnapshot).styles.globalCss).toContain('--brand')
}, 60_000)
