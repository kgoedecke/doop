import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Canvas } from '../shared/types'
import type { StorybookRunResult } from '../shared/storybookSource'
import { Client, startServer, type Server } from './harness.ts'

/*
 * A real Storybook on the internet, imported by the server's renderer through the import section's
 * routes. Opt-in, since it needs the network and the Storybook's goodwill:
 *   STORYBOOK_LIVE_URL=https://react.carbondesignsystem.com STORYBOOK_LIVE_TITLES="Components/Button,Components/Tag" \
 *     bunx vitest run tests/storybookLive.test.ts
 */

const url = process.env.STORYBOOK_LIVE_URL
const titles = (process.env.STORYBOOK_LIVE_TITLES ?? '')
  .split(',')
  .map((title) => title.trim())
  .filter(Boolean)

describe.skipIf(!url || !titles.length)('a live Storybook', () => {
  let server: Server
  let owner: Client

  beforeAll(async () => {
    server = await startServer()
    owner = await new Client(server).signUp('storybook-live@test.dev', 'Live Owner')
  }, 60_000)

  afterAll(() => server?.stop())

  it('imports the picked components with props, tokens and a fidelity reading', async () => {
    const canvas: Canvas = await (await owner.post('/api/canvases', { name: 'Live kit' })).json()
    const discovered = (await (await owner.post(`/api/canvases/${canvas.id}/storybook/discover`, { url })).json()) as {
      components: { title: string }[]
    }
    for (const title of titles) expect(discovered.components.map((c) => c.title)).toContain(title)

    const started = await owner.post(`/api/canvases/${canvas.id}/storybook/import`, { url, components: titles })
    expect(started.status).toBe(202)
    let { job } = (await started.json()) as {
      job: { id: string; state: string; result?: StorybookRunResult; error?: string }
    }
    for (let i = 0; i < 240 && job.state === 'running'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      job = (
        (await (await owner.get(`/api/canvases/${canvas.id}/storybook/jobs/${job.id}`)).json()) as { job: typeof job }
      ).job
    }
    console.log(JSON.stringify(job.result ?? job.error, null, 2))
    expect(job.state).toBe('done')
    for (const component of job.result!.components) {
      expect(component.outcome).toBe('created')
      expect(component.fidelity).toBeGreaterThan(0.5)
    }
  }, 300_000)
})
