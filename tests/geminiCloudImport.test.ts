import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

let server: Server
let alice: Client
let bob: Client
let canvasId: string
let bobCanvasId: string
const env = {
  ANTHROPIC_API_KEY: '',
  OPENAI_API_KEY: '',
  DATABASE_URL: '',
  SMTP_HOST: '',
  DOOP_GEMINI_CLOUD_WORKERS: '',
}

beforeAll(async () => {
  server = await startServer(5017, env)
  alice = await new Client(server).signUp('gemini-import-alice@example.test', 'Alice')
  bob = await new Client(server).signUp('gemini-import-bob@example.test', 'Bob')
  const { id: userId } = await (await alice.get('/api/me')).json()
  canvasId = (await (await alice.post('/api/canvases', { name: 'Pilot' })).json()).id
  bobCanvasId = (await (await bob.post('/api/canvases', { name: 'Other user' })).json()).id
  server.stop({ keepData: true })
  await server.stopped
  server = await startServer(
    5017,
    {
      ...env,
      DOOP_GEMINI_CLOUD_WORKERS: JSON.stringify({ [userId]: { url: 'http://127.0.0.1:1', token: 'x'.repeat(32) } }),
    },
    server.dataDir,
  )
}, 120_000)

afterAll(() => server?.stop())

it('rejects pilot repository imports before connection lookup or queue side effects', async () => {
  const before = await (await alice.get(`/api/canvases/${canvasId}`)).json()
  for (const body of [{ design_system: true }, { design_system: false, screens: [{ sourcePath: 'app/page.tsx' }] }]) {
    const response = await alice.post(`/api/canvases/${canvasId}/github/not-looked-up/import`, body)
    expect(response.status).toBe(409)
    expect((await response.json()).error).toContain(
      'Repository imports are unavailable while the Gemini cloud pilot is selected',
    )
  }
  expect(await (await alice.get(`/api/canvases/${canvasId}`)).json()).toEqual(before)
})

it('keeps canvas authorization and non-pilot import behavior intact', async () => {
  expect((await alice.post(`/api/canvases/${bobCanvasId}/github/missing/import`, {})).status).toBe(403)
  const response = await bob.post(`/api/canvases/${bobCanvasId}/github/missing/import`, {})
  expect(response.status).toBe(404)
  expect(await response.json()).toEqual({ error: 'connection not found' })
})
