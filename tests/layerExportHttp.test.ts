import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findBrowserPath } from '../server/screenshot.ts'
import type { Canvas, Frame } from '../shared/types'
import { Client, startServer, type Server } from './harness.ts'

/** `/i/<frameId>.png?element=` / `?selector=`: the URL export_layer hands out. */

const HTML = `<!doctype html><html><body style="margin:0">
  <div data-doop-id="logo01" style="position:absolute;left:20px;top:10px;width:64px;height:32px;background:#e11"></div>
  <p class="tagline" style="position:absolute;left:0;top:100px;margin:0;width:150px;height:24px;background:#11e"></p>
</body></html>`

let server: Server
let frame: Frame

beforeAll(async () => {
  server = await startServer()
  const owner = new Client(server)
  await owner.signUp('layers@test.dev', 'Layer Owner')
  const canvas: Canvas = await (await owner.post('/api/canvases', { name: 'Layers' })).json()
  frame = await (
    await owner.post(`/api/canvases/${canvas.id}/frames`, { name: 'Header', html: HTML, width: 300, height: 200 })
  ).json()
}, 60_000)

afterAll(() => server?.stop())

const image = (query: string) => fetch(`http://127.0.0.1:${server.port}/i/${frame.id}.png?${query}`)

it('refuses a malformed layer name before rendering', async () => {
  expect((await image('element=NOT-AN-ID')).status).toBe(400)
  expect((await image('selector=')).status).toBe(400)
})

describe.skipIf(!findBrowserPath())('with a renderer', () => {
  it('serves the layer cut from the frame, by id or by selector', async () => {
    const byId = await image('scale=2&element=logo01')
    expect(byId.status).toBe(200)
    const png = Buffer.from(await byId.arrayBuffer())
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([128, 64])

    const bySelector = await image(`scale=1&selector=${encodeURIComponent('p.tagline')}&download`)
    expect(bySelector.status).toBe(200)
    expect(bySelector.headers.get('content-disposition')).toMatch(/Header layer\.png/)
    const tagline = Buffer.from(await bySelector.arrayBuffer())
    expect([tagline.readUInt32BE(16), tagline.readUInt32BE(20)]).toEqual([150, 24])
  }, 60_000)

  it('answers 404 for a layer that is not there', async () => {
    expect((await image('element=zzzzzz')).status).toBe(404)
  }, 60_000)
})
