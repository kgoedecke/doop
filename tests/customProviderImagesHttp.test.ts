import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import sharp from 'sharp'
import { Client, startServer, type Server } from './harness'

/**
 * A custom provider's image models end to end, against the real server and a
 * fake OpenAI Images endpoint on loopback (which needs the operator's
 * private-hosts switch): an admin lists image models on a shared provider,
 * every person finds them in the image-model picker, and generate_image draws
 * through the endpoint on the provider's key, which no response ever carries.
 * A person can neither change those image models nor borrow the key. A
 * personal provider's image models work the same way for their person.
 */

let server: Server
let boss: Client
let alice: Client
let bob: Client
let endpoint: http.Server
let base = ''
let png = ''
/* what the endpoint draws when asked for a transparent background */
let cutOut = ''
/* what the endpoint answers next: an image, or a refusal */
let answer: 'image' | 'refuse' = 'image'
const seen: { url: string; authorization?: string; body?: Record<string, unknown> }[] = []
/* every response body any test read, checked for the secrets at the end */
const bodies: string[] = []

const KEY = 'sk-images-shared-never-echoed'
const BOB_KEY = 'sk-images-bob-never-echoed'

beforeAll(async () => {
  png = (
    await sharp({ create: { width: 16, height: 12, channels: 4, background: '#2b6cb0' } })
      .png()
      .toBuffer()
  ).toString('base64')
  cutOut = (
    await sharp({ create: { width: 16, height: 12, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .png()
      .toBuffer()
  ).toString('base64')
  endpoint = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()))
    req.on('end', () => {
      seen.push({
        url: req.url ?? '',
        ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
        ...(raw ? { body: JSON.parse(raw) as Record<string, unknown> } : {}),
      })
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ data: [{ id: 'qwen3-coder' }, { id: 'flux-schnell' }] }))
      }
      if (req.url?.endsWith('/images/generations')) {
        if (answer === 'refuse') {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ error: { message: 'invalid key' } }))
        }
        const transparent = (JSON.parse(raw) as { background?: string }).background === 'transparent'
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ created: 1, data: [{ b64_json: transparent ? cutOut : png }] }))
      }
      res.writeHead(404)
      res.end()
    })
  })
  await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}/v1`
  server = await startServer({
    ANTHROPIC_API_KEY: '',
    OPENAI_API_KEY: '',
    GEMINI_API_KEY: '',
    ARK_API_KEY: '',
    DATABASE_URL: '',
    SMTP_HOST: '',
    ADMIN_EMAILS: 'images-boss@example.test',
    DOOP_CUSTOM_PROVIDER_PRIVATE_HOSTS: 'true',
  })
  boss = await new Client(server).signUp('images-boss@example.test', 'Boss')
  alice = await new Client(server).signUp('images-alice@example.test', 'Alice')
  bob = await new Client(server).signUp('images-bob@example.test', 'Bob')
}, 60000)
afterAll(async () => {
  await server?.stop()
  await new Promise<void>((resolve) => endpoint.close(() => resolve()))
})

interface ImageModel {
  id: string
  available: boolean
  selected: boolean
  custom?: { provider: string; name: string; shared?: true; transparent?: true }
}
interface AdminView {
  providers: { kind: string; custom: { imageModels?: { id: string; transparent?: true }[] } }[]
}

async function read<T>(response: Response): Promise<T> {
  const text = await response.text()
  bodies.push(text)
  return JSON.parse(text) as T
}
const imageModels = async (client: Client) =>
  (await read<{ models: ImageModel[] }>(await client.get('/api/image-model'))).models

/** generate_image over MCP, as the client's own agent key. */
async function generate(client: Client, args: Record<string, unknown>) {
  const canvasId = (await read<{ id: string }>(await client.post('/api/canvases', { name: 'Images' }))).id
  const secret = (await read<{ secret: string }>(await client.post('/api/agent-keys', { name: 'images-agent' }))).secret
  const res = await fetch(`${server.base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'generate_image', arguments: { canvas_id: canvasId, agent_name: 'Tester', ...args } },
    }),
  })
  expect(res.status).toBe(200)
  const text = await res.text()
  bodies.push(text)
  const body = JSON.parse(text) as { result: { isError?: boolean; content: { type: string; text?: string }[] } }
  return {
    isError: !!body.result.isError,
    text: body.result.content.map((block) => block.text ?? '').join('\n'),
  }
}

const provider = {
  name: 'Acme Images',
  apiType: 'openai-chat',
  models: [{ id: 'qwen3-coder', vision: true }],
  imageModels: [{ id: 'flux-schnell', name: 'FLUX schnell', transparent: true }],
}

let kind = ''

describe('a shared provider’s image models', () => {
  it('are added and kept by an admin, the key never coming back', async () => {
    const created = await read<AdminView>(
      await boss.post('/api/admin/shared-providers', { ...provider, baseUrl: base, apiKey: KEY }),
    )
    expect(created.providers).toHaveLength(1)
    kind = created.providers[0]!.kind
    expect(created.providers[0]!.custom.imageModels).toEqual([
      { id: 'flux-schnell', name: 'FLUX schnell', transparent: true },
    ])
  })

  it('can be filled from the endpoint’s model list', async () => {
    const listed = await read<{ models: string[] }>(
      await boss.post('/api/admin/shared-providers/models', { apiType: 'openai-chat', baseUrl: base, kind }),
    )
    expect(listed.models).toContain('flux-schnell')
  })

  it('are not a person’s to change: the admin routes are not there, and the personal ones refuse', async () => {
    const attempt = { ...provider, baseUrl: base, imageModels: [{ id: 'stolen' }] }
    expect((await alice.put(`/api/admin/shared-providers/${kind}`, attempt)).status).toBe(404)
    expect((await alice.post('/api/admin/shared-providers', attempt)).status).toBe(404)
    expect((await alice.put(`/api/custom-providers/${kind}`, attempt)).status).toBe(403)
    const view = await read<AdminView>(await boss.get('/api/admin/shared-providers'))
    expect(view.providers[0]!.custom.imageModels).toEqual([
      { id: 'flux-schnell', name: 'FLUX schnell', transparent: true },
    ])
  })

  it('show in everyone’s image-model picker, chosen by default for someone with nothing else that draws', async () => {
    const models = await imageModels(alice)
    expect(models.find((model) => model.custom)).toEqual({
      id: `${kind}/flux-schnell`,
      available: true,
      selected: true,
      custom: { provider: 'Acme Images', name: 'FLUX schnell', shared: true, transparent: true },
    })
    /* the registry is still there, and nothing on it can run without a key */
    expect(models.filter((model) => !model.custom).every((model) => !model.available)).toBe(true)
    /* the person's view of the provider lists them too */
    const accounts = await read<{ accounts: { kind: string; custom?: { imageModels?: unknown[] } }[] }>(
      await alice.get('/api/model-account'),
    )
    expect(accounts.accounts.find((account) => account.kind === kind)?.custom?.imageModels).toHaveLength(1)
  })

  it('can be picked, while an id no provider of the person lists cannot', async () => {
    const picked = await read<{ models: ImageModel[] }>(
      await alice.put('/api/image-model', { model: `${kind}/flux-schnell` }),
    )
    expect(picked.models.find((model) => model.selected)?.id).toBe(`${kind}/flux-schnell`)
    expect((await alice.put('/api/image-model', { model: `${kind}/flux-pro` })).status).toBe(400)
    expect((await alice.put('/api/image-model', { model: 'custom:0123456789abcdef01/flux' })).status).toBe(400)
  })

  it('draw through the endpoint on the shared key, billed to the provider', async () => {
    seen.length = 0
    const result = await generate(alice, { prompt: 'a blue square', aspect: 'landscape', transparent: true })
    expect(result.isError).toBe(false)
    const parsed = JSON.parse(result.text.split('\n\nPreview above')[0]!) as Record<string, unknown>
    expect(parsed).toMatchObject({ ok: true, billed_to: 'Acme Images', transparent: true, width: 16, height: 12 })
    const call = seen.find((entry) => entry.url.endsWith('/images/generations'))!
    expect(call.authorization).toBe(`Bearer ${KEY}`)
    expect(call.body).toEqual({
      model: 'flux-schnell',
      prompt: 'a blue square',
      n: 1,
      size: '1536x1024',
      quality: 'medium',
      output_format: 'png',
      background: 'transparent',
    })
    /* the stored asset is the image, recompressed */
    const asset = await fetch(String(parsed.url))
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toContain('image/webp')
  })

  it('tell a person to ask their admin when the endpoint refuses the shared key', async () => {
    answer = 'refuse'
    try {
      const result = await generate(alice, { prompt: 'a blue square' })
      expect(result.isError).toBe(true)
      expect(result.text).toMatch(/Acme Images turned down the shared connection your admin set up \(401\)/)
      expect(result.text).toContain('Ask your admin')
    } finally {
      answer = 'image'
    }
  })

  it('stop drawing, without a fallback, once the admin switches the provider off', async () => {
    expect((await boss.patch(`/api/admin/shared-providers/${kind}`, { enabled: false })).status).toBe(200)
    seen.length = 0
    const result = await generate(alice, { prompt: 'a blue square' })
    expect(result.isError).toBe(true)
    expect(seen).toHaveLength(0)
    expect((await imageModels(alice)).some((model) => model.custom)).toBe(false)
    expect((await boss.patch(`/api/admin/shared-providers/${kind}`, { enabled: true })).status).toBe(200)
  })
})

describe('a personal provider’s image models', () => {
  it('draw for their person on their own key, beside the shared ones', async () => {
    const added = await bob.post('/api/custom-providers', {
      name: 'Bob Studio',
      apiType: 'openai-chat',
      baseUrl: base,
      apiKey: BOB_KEY,
      models: [{ id: 'qwen3-coder', vision: true }],
      imageModels: [{ id: 'sdxl' }],
    })
    expect(added.status).toBe(200)
    bodies.push(await added.text())
    const models = await imageModels(bob)
    const own = models.find((model) => model.custom && !model.custom.shared)!
    expect(own.custom).toEqual({ provider: 'Bob Studio', name: 'sdxl' })
    /* the person's own come first; the shared one is still offered after them */
    expect(models.filter((model) => model.custom).map((model) => model.custom!.provider)).toEqual([
      'Bob Studio',
      'Acme Images',
    ])
    await read(await bob.put('/api/image-model', { model: own.id }))

    seen.length = 0
    const result = await generate(bob, { prompt: 'a mascot', transparent: true })
    expect(result.isError).toBe(false)
    expect(result.text).toContain('"billed_to": "Bob Studio"')
    /* sdxl was not said to draw cut-outs: none asked for, none claimed */
    expect(result.text).toContain('"transparent": false')
    const call = seen.find((entry) => entry.url.endsWith('/images/generations'))!
    expect(call.authorization).toBe(`Bearer ${BOB_KEY}`)
    expect(call.body).not.toHaveProperty('background')
    /* and nobody else gets them */
    expect((await imageModels(alice)).some((model) => model.custom?.provider === 'Bob Studio')).toBe(false)
  })
})

describe('picks on a provider that is gone', () => {
  it('go with a personal provider its person disconnects', async () => {
    const own = (await imageModels(bob)).find((model) => model.custom?.provider === 'Bob Studio')!
    expect(own.selected).toBe(true)
    const kindOf = own.id.slice(0, own.id.indexOf('/'))
    expect((await bob.delete(`/api/model-account/${kindOf}`)).status).toBe(200)
    /* the pick went with it: Bob draws on what is left (the shared provider),
       not refused for a pick on a provider that is no longer there */
    const result = await generate(bob, { prompt: 'a mascot' })
    expect(result.isError).toBe(false)
    expect(result.text).toContain('"billed_to": "Acme Images"')
  })

  it('go with a shared provider its admin deletes', async () => {
    expect((await imageModels(alice)).find((model) => model.selected)?.id).toBe(`${kind}/flux-schnell`)
    expect((await boss.delete(`/api/admin/shared-providers/${kind}`)).status).toBe(200)
    const result = await generate(alice, { prompt: 'a blue square' })
    expect(result.isError).toBe(true)
    /* nothing left to draw with, said as such: no stale pick to blame */
    expect(result.text).toContain('image generation is not available')
    expect(result.text).not.toContain('no longer connected')
  })
})

describe('the keys', () => {
  it('appear in no response', () => {
    expect(bodies.length).toBeGreaterThan(10)
    for (const body of bodies) {
      expect(body).not.toContain(KEY)
      expect(body).not.toContain(BOB_KEY)
    }
  })
})
