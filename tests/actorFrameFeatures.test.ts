import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/* Frames live in canvas actors. One pass over the REST surface that main
   grew around frames (optimistic saves, sign-off, hide/lock, design history,
   element ids, page copies, flow starts, actor tickets, share-link roles),
   against a real server and the isolated local actor runtime. */

let server: Server
let alice: Client

beforeAll(async () => {
  server = await startServer()
  alice = await new Client(server).signUp('actor-features-alice@test.dev', 'Alice')
}, 90_000)

afterAll(() => server?.stop())

it('keeps sign-off, history, locks, pages and access working with frames in actors', async () => {
  const canvas = await (await alice.post('/api/canvases', { name: 'Actor features' })).json()
  const page = canvas.pages[0].id
  const created = await alice.post(`/api/canvases/${canvas.id}/frames`, {
    name: 'Hero',
    pageId: page,
    html: '<!doctype html><html><body><h1>Hi</h1><p>One</p></body></html>',
    width: 400,
    height: 300,
  })
  expect(created.status).toBe(200)
  const frame = await created.json()
  expect(frame.id.startsWith(`${canvas.id}.`)).toBe(true)

  const loaded = await (await alice.get(`/api/canvases/${canvas.id}`)).json()
  expect(loaded.frames.map((f: { id: string }) => f.id)).toEqual([frame.id])
  expect(loaded.role).toBe('edit')

  // stale optimistic save → 409 with the current frame
  const stale = await alice.patch(`/api/frames/${frame.id}`, { name: 'X', expectedUpdatedAt: frame.updatedAt - 1 })
  expect(stale.status).toBe(409)
  expect((await stale.json()).frame.id).toBe(frame.id)

  // approval, then a design edit moves it to needs_review
  const approved = await (
    await alice.put(`/api/frames/${frame.id}/approval`, { status: 'ready_for_dev', expectedUpdatedAt: frame.updatedAt })
  ).json()
  expect(approved.approval.status).toBe('ready_for_dev')
  const edited = await alice.patch(`/api/frames/${frame.id}`, {
    html: `<main>${'A completely different layout. '.repeat(20)}</main>`,
    expectedUpdatedAt: approved.updatedAt,
  })
  expect(edited.status).toBe(200)
  expect((await edited.json()).approval.status).toBe('needs_review')

  // hide and lock survive in the actor
  await alice.patch(`/api/frames/${frame.id}`, { hidden: true, locked: true })
  const reread = await (await alice.get(`/api/canvases/${canvas.id}`)).json()
  expect(reread.frames[0]).toMatchObject({ hidden: true, locked: true })

  // design history lives in the actor and restores
  const versions = await (await alice.get(`/api/frames/${frame.id}/versions`)).json()
  expect(versions.length).toBeGreaterThan(0)
  const restored = await (await alice.post(`/api/frames/${frame.id}/versions/${versions[0].id}/restore`)).json()
  expect(restored.frame.html).toContain('<p>One</p>')

  // element id stamping is an annotation: sign-off is untouched
  const stamp = await (await alice.post(`/api/frames/${frame.id}/element-id`, { selector: 'body > h1' })).json()
  expect(stamp.elementId).toBeTruthy()

  // pages: an occupied page cannot be deleted; a copy carries its frames
  const pages = [canvas.pages[0], { id: 'second', name: 'Second' }]
  expect((await alice.put(`/api/canvases/${canvas.id}/pages`, { pages, expectedPages: canvas.pages })).status).toBe(200)
  const drop = await alice.put(`/api/canvases/${canvas.id}/pages`, { pages: [pages[1]], expectedPages: pages })
  expect(drop.status).toBe(400)
  const copy = await (await alice.post(`/api/canvases/${canvas.id}/pages/${page}/duplicate`)).json()
  expect(copy.frames).toHaveLength(1)
  const flow = await alice.put(`/api/canvases/${canvas.id}/pages/${page}/flow-start`, { frameId: frame.id })
  expect((await flow.json()).find((p: { id: string }) => p.id === page).startFrameId).toBe(frame.id)

  // the canvas actor ticket
  const grant = await (await alice.get(`/api/canvases/${canvas.id}/actor?clientId=actor-features`)).json()
  expect(typeof grant.websocketUrl).toBe('string')

  // a view-only link visitor gets a read-only canvas and no writes
  await alice.patch(`/api/canvases/${canvas.id}`, { linkAccess: 'view' })
  const bob = await new Client(server).signUp('actor-features-bob@test.dev', 'Bob')
  const view = await (await bob.get(`/api/canvases/${canvas.id}`)).json()
  expect(view.role).toBe('view')
  expect((await bob.patch(`/api/frames/${frame.id}`, { name: 'Nope' })).status).toBe(403)

  // deleting removes it from the canvas
  expect((await alice.delete(`/api/frames/${frame.id}`)).status).toBe(200)
  const after = await (await alice.get(`/api/canvases/${canvas.id}`)).json()
  expect(after.frames.map((f: { id: string }) => f.id)).not.toContain(frame.id)
}, 90_000)
