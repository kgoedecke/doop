import { createServer } from 'node:http'
import { symlinkSync } from 'node:fs'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { findBrowserPath } from '../server/screenshot'
import { pagePerTest } from './browser'
import { Client, startServer, type Server } from './harness'

describe.skipIf(!findBrowserPath())('prompting with a frame selection', () => {
  const pages = pagePerTest()
  let server: Server
  let instructions = ''
  const model = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const message = body && JSON.parse(body).messages?.[0]?.content
    if (typeof message === 'string' && message.includes('Redesign these screens')) instructions = message
    response.writeHead(400, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'End of test' } }))
  })

  beforeAll(async () => {
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve))
    server = await startServer({
      NODE_ENV: 'production',
      BETTER_AUTH_SECRET: 'only-for-the-local-browser-test',
      DOOP_AGENT_PROVIDER: 'anthropic',
      RESIDENT_TASK_LIMIT: '5',
      ANTHROPIC_API_KEY: 'local-test',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${(model.address() as AddressInfo).port}`,
    })
    symlinkSync(inject('browserRig')!.builtDir, path.join(server.dataDir, 'dist'), 'junction')
  }, 60_000)
  afterAll(async () => {
    server?.stop()
    await new Promise<void>((resolve) => model.close(() => resolve()))
  })

  it('saves exactly the three selected frames and sends them to the resident agent', async () => {
    const owner = await new Client(server).signUp('scope@test.dev', 'Scope Tester')
    const canvas = await (await owner.post('/api/canvases', { name: 'Scope test' })).json()
    const ids: string[] = []
    for (const name of ['Home', 'Pricing', 'Account', 'Unselected']) {
      const frame = await (
        await owner.post(`/api/canvases/${canvas.id}/frames`, { name, width: 200, height: 100 })
      ).json()
      ids.push(frame.id)
    }
    const selected = ids.slice(0, 3)
    const page = await pages.open()
    await page.setViewport({ width: 1500, height: 900 })
    await page
      .browserContext()
      .setCookie(...Array.from(owner.cookies, ([name, value]) => ({ name, value, domain: 'localhost' })))
    await page.goto(`${server.base}/c/${canvas.id}`)
    const row = (id: string) => `[data-row-key="${id}"]`
    await page.waitForSelector(row(selected[0]!))
    await page.click(row(selected[0]!))
    await page.keyboard.down('Meta')
    for (const id of selected.slice(1)) await page.click(row(id))
    await page.keyboard.up('Meta')
    await page.keyboard.press('/')
    const composer = 'textarea[aria-label="Ask the Doop Agent"]'
    await page.waitForSelector(composer, { visible: true })
    await page.click(composer)
    await page.type(composer, 'Redesign these screens')
    const saved = page.waitForResponse(
      (r) => r.url().endsWith(`/canvases/${canvas.id}/cards`) && r.request().method() === 'POST',
    )
    await page.click('button[aria-label=Send]')
    const card = await (await saved).json()
    await expect.poll(() => instructions, { timeout: 15_000 }).toContain('Redesign these screens')
    const cardInstructions = instructions.split('\n\n')[0]!
    expect([...cardInstructions.matchAll(/frame ([\w-]+) \("/g)].map((match) => match[1])).toEqual(selected)
    expect(cardInstructions).not.toContain(ids[3]!)
    expect(instructions.split('Frames currently on the canvas:')[1]).toContain(ids[3]!)
    expect(instructions).not.toContain('Deliver TWO new frames')

    server.stop({ keepData: true })
    await server.stopped
    const db = new PGlite(path.join(server.dataDir, 'data', 'pg'))
    try {
      const { rows } = await db.query<{ scope: string }>('SELECT scope FROM tasks WHERE id = $1', [card.id])
      expect(rows).toHaveLength(1)
      expect(JSON.parse(rows[0]?.scope ?? 'null')).toEqual({
        frameId: selected[2],
        additionalTargets: selected.slice(0, 2).map((frameId) => ({ frameId })),
      })
    } finally {
      await db.close()
    }
  }, 60_000)
})
