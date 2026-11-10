import { afterAll, beforeAll, expect, it } from 'vitest'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer as createHttpServer } from 'node:http'
import { once } from 'node:events'
import sharp from 'sharp'
import type { Frame as BrowserFrame, Page } from 'puppeteer-core'
import { createServer, type ViteDevServer } from 'vite'
import type { CustomFont } from '../shared/fonts.ts'
import type { Frame } from '../shared/types.ts'
import { Client } from './harness.ts'
import { startPrivateServer } from './privateServer.ts'
import { fixtureServerConfig, openBrowser } from './browser.ts'

let fixture: Awaited<ReturnType<typeof startPrivateServer>> | undefined
let browser: Awaited<ReturnType<typeof openBrowser>> | undefined
let web: ViteDevServer | undefined
let page: Page
let rendered: BrowserFrame
let owner: Client
let stranger: Client
let image: Buffer
let fontBytes: Buffer
let font: CustomFont
let assetPath: string
let frameId: string
let canvasId: string
let canonicalHtml: string
const color = [13, 165, 67]
const title = 'Private materialization specimen'

declare global {
  interface Window {
    focusPrivateFrame: (frame: Frame) => void
    clearPrivateImagePick: () => void
    debugPrivateImage: () => unknown
    pickPrivateImage: (id: string) => void
    readPrivateRendering: (
      id: string,
    ) => Promise<{ snapshot: string | null; code: string | null; image: string | null }>
    rasterPrivateRendering: (frame: Frame) => Promise<{ width: number; height: number; pixel: number[] }>
  }
}

beforeAll(async () => {
  fixture = await startPrivateServer()
  owner = await new Client(fixture.server).signUp('private-render-a@test.dev', 'Rendering A')
  stranger = await new Client(fixture.server).signUp('private-render-b@test.dev', 'Rendering B')
  const canvas = await (await owner.post('/api/canvases', { name: 'Private rendering' })).json()
  canvasId = canvas.id
  image = await sharp({
    create: { width: 16, height: 16, channels: 4, background: { r: color[0]!, g: color[1]!, b: color[2]!, alpha: 1 } },
  })
    .png()
    .toBuffer()
  const uploaded = await owner.req(`/api/canvases/${canvas.id}/assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: new Uint8Array(image),
  })
  expect(uploaded.status).toBe(200)
  const url = (await uploaded.json()).url as string
  assetPath = new URL(url).pathname
  fontBytes = await readFile('tests/fixtures/fonts/nunito-sans-bold-italic.woff2')
  const fontUpload = await owner.req(`/api/fonts?canvas=${canvas.id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'nunito-sans-bold-italic.woff2' },
    body: new Uint8Array(fontBytes),
  })
  expect(fontUpload.status).toBe(200)
  font = await fontUpload.json()
  const created = await owner.post(`/api/canvases/${canvas.id}/frames`, {
    name: title,
    x: 0,
    y: 0,
    width: 320,
    height: 180,
    html: `<!doctype html><html><head><style>html,body{margin:0;background:white}.private-type{position:absolute;top:64px;font:italic 700 32px ${JSON.stringify(font.family)},serif}</style></head><body><img data-private-image src="${url}" style="position:absolute;left:0;top:0;width:48px;height:48px"><span class="private-type">Private WWW</span></body></html>`,
  })
  expect(created.status).toBe(200)
  const frame = await created.json()
  frameId = frame.id
  canonicalHtml = frame.html
  expect(frame.html).toContain('data-doop-fonts')
  expect(frame.html).toContain(font.url)
  browser = await openBrowser()
  page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  const hostname = new URL(fixture.server.base).hostname
  const cookies = owner
    .header()
    .split(';')
    .map((pair) => {
      const at = pair.indexOf('=')
      return {
        name: pair.slice(0, at).trim(),
        value: pair.slice(at + 1).trim(),
        domain: hostname,
        path: '/',
        httpOnly: true,
        sameSite: 'Lax' as const,
        secure: false,
      }
    })
  // Normal first-party browser cookie jar. No request-wide credential headers.
  await page.browserContext().setCookie(...cookies)
  // The native HTTP harness intentionally serves no client bundle. Use the actual
  // app with the same Vite proxy shape as development, pointed at this owned server.
  web = await createServer(
    fixtureServerConfig({
      host: 'localhost',
      proxy: Object.fromEntries(
        ['/api', '/a/', '/i/', '/u/', '/ws'].map((path) => [
          path,
          { target: fixture!.server.base, ...(path === '/ws' ? { ws: true } : {}) },
        ]),
      ),
    }),
  )
  await web.listen()
  const origin = web.resolvedUrls?.local[0]
  if (!origin) throw new Error('actual app test server has no origin')
  await page.goto(`${origin}c/${canvas.id}`, { waitUntil: 'domcontentloaded' })
  const element = await page.waitForSelector(`iframe[title="${title}"]`, { timeout: 15_000 })
  const frameDocument = await element!.contentFrame()
  if (!frameDocument) throw new Error('actual editor iframe did not start')
  rendered = frameDocument
  await rendered.waitForSelector('[data-private-image]', { timeout: 15_000 })
  await page.addScriptTag({
    type: 'module',
    content: `
    import * as bridge from '/src/lib/frameBridge.ts'
    import { rasterizeFrame } from '/src/lib/frameRaster.ts'
    import { useStore } from '/src/lib/store.ts'
    window.focusPrivateFrame = frame => { const stage = document.querySelector('.stage'); if (!stage) throw new Error('stage unavailable'); useStore.getState().setViewport({ x: stage.clientWidth / 2 - frame.x - frame.width / 2, y: stage.clientHeight / 2 - frame.y - frame.height / 2, zoom: 1 }) }
    window.clearPrivateImagePick = () => useStore.getState().pickElement(null)
    window.debugPrivateImage = () => { const s = useStore.getState(); return { selectedId:s.selectedId, selected:s.selectedElement, elementPanelOpen:s.elementPanelOpen, inspectorOpen:s.inspectorOpen, tool:s.tool, role:s.role, notice:s.notice?.text } }
    window.pickPrivateImage = id => { useStore.getState().select(id); useStore.getState().pickElement({ frameId: id, selector: '[data-private-image]' }) }
    window.readPrivateRendering = async id => ({
      snapshot: (await bridge.snapshotFrame(id))?.html ?? null,
      code: (await bridge.requestFrame(id, 'doop:code', { selector: '[data-private-image]' }))?.html ?? null,
      image: (await bridge.inspectElement(id, '[data-private-image]'))?.image?.src ?? null,
    })
    window.rasterPrivateRendering = async frame => {
      const blob = await rasterizeFrame(frame, { scale: 1, type: 'png' })
      const bitmap = await createImageBitmap(blob)
      try {
        const canvas = document.createElement('canvas')
        canvas.width = bitmap.width; canvas.height = bitmap.height
        const context = canvas.getContext('2d')
        context.drawImage(bitmap, 0, 0)
        return { width: bitmap.width, height: bitmap.height, pixel: [...context.getImageData(24, 24, 1, 1).data].slice(0, 3) }
      } finally { bitmap.close() }
    }
  `,
  })
  await page.waitForFunction(() => typeof window.readPrivateRendering === 'function')
}, 70_000)
afterAll(async () => {
  try {
    await browser?.close()
  } finally {
    try {
      await web?.close()
    } finally {
      await fixture?.close()
    }
  }
})

it('the actual local browser raster prepares private files under current scope before drawing', async () => {
  const result = await page.evaluate((frame) => window.rasterPrivateRendering(frame), {
    id: frameId,
    canvasId,
    name: title,
    x: 0,
    y: 0,
    width: 320,
    height: 180,
    html: canonicalHtml,
    createdAt: 0,
    updatedAt: 0,
    updatedBy: 'fixture',
  } as Frame)
  expect(result).toEqual({ width: 320, height: 180, pixel: color })
})

it('the real browser export fetches public bytes anonymously and admits them before drawing', async () => {
  const requests: { path: string; cookie?: string; authorization?: string }[] = []
  const appOrigin = new URL(page.url()).origin
  const fontUrl = appOrigin + new URL(font.url).pathname
  const forbidden = await readFile('tests/fixtures/compressed-100m-pixel.png')
  const publicServer = createHttpServer((request, response) => {
    requests.push({ path: request.url!, cookie: request.headers.cookie, authorization: request.headers.authorization })
    response.setHeader('Access-Control-Allow-Origin', appOrigin)
    response.setHeader('Access-Control-Allow-Credentials', 'true')
    if (request.url === '/redirect.png') {
      response.writeHead(302, { Location: '/redirect-target.png' }).end()
    } else if (request.url === '/style.css') {
      response.setHeader('Content-Type', 'text/css')
      response.end(
        `@font-face{font-family:Imported;src:url("${fontUrl}")}html,body{margin:0}.private-type{font:italic 700 32px Imported}`,
      )
    } else if (request.url === '/large.png') {
      response.setHeader('Content-Type', 'image/png')
      response.end(forbidden)
    } else if (request.url === '/oversize.png') {
      response.setHeader('Content-Type', 'image/png')
      response.end(Buffer.alloc(800_000))
    } else {
      // Sniff actual bytes instead of trusting this misleading declaration.
      response.setHeader('Content-Type', 'text/plain')
      response.end(image)
    }
  })
  publicServer.listen(0, '127.0.0.1')
  await once(publicServer, 'listening')
  const address = publicServer.address()
  if (!address || typeof address === 'string') throw new Error('missing public fixture port')
  const origin = `http://localhost:${address.port}`
  const exportPage = await browser!.newPage()
  try {
    // A separate normal-cookie tab has no mounted copy of the tested frame;
    // editor repaint traffic cannot be mistaken for export fetches.
    await exportPage.goto(appOrigin + '/tests/fixtures/frameRaster.html')
    await exportPage.addScriptTag({
      type: 'module',
      content: `
      import { rasterizeFrame } from '/src/lib/frameRaster.ts'
      window.rasterPrivateRendering = async frame => {
        const blob = await rasterizeFrame(frame, { scale: 1, type: 'png' })
        const bitmap = await createImageBitmap(blob)
        try {
          const canvas = document.createElement('canvas')
          canvas.width = bitmap.width; canvas.height = bitmap.height
          const context = canvas.getContext('2d')
          context.drawImage(bitmap, 0, 0)
          return { width: bitmap.width, height: bitmap.height, pixel: [...context.getImageData(24, 24, 1, 1).data].slice(0, 3) }
        } finally { bitmap.close() }
      }
    `,
    })
    await exportPage.waitForFunction(() => typeof window.rasterPrivateRendering === 'function')
    // Positive control: this host receives the real first-party session cookie
    // on an ordinary credentialed request. Export fetches must omit it.
    expect(
      await exportPage.evaluate(
        async (url) => (await fetch(url, { credentials: 'include' })).status,
        origin + '/control',
      ),
    ).toBe(200)
    expect(requests[0]!.cookie).toContain('session')
    requests.length = 0
    const html = `<link rel="stylesheet" href="${origin}/style.css"><img src="${origin}/valid.png" width="48" height="48"><span class="private-type">Private WWW</span>`
    const created = await owner.post(`/api/canvases/${canvasId}/frames`, {
      name: 'Public export fixture',
      x: 400,
      y: 0,
      width: 320,
      height: 180,
      html: '<p>Export draft</p>',
    })
    expect(created.status).toBe(200)
    const frame = { ...(await created.json()), html }
    const result = await exportPage.evaluate((frame) => window.rasterPrivateRendering(frame), frame)
    expect(result).toEqual({ width: 320, height: 180, pixel: color })
    expect(requests.map((value) => value.path).sort()).toEqual(['/style.css', '/valid.png'])
    expect(requests.every((value) => !value.cookie && !value.authorization)).toBe(true)
    for (const path of ['/large.png', '/oversize.png', '/redirect.png']) {
      const output = await exportPage.evaluate(
        async ({ frame, html }) => {
          try {
            await window.rasterPrivateRendering({ ...frame, html })
            return 'unexpected success'
          } catch (error) {
            return error instanceof Error ? error.message : String(error)
          }
        },
        { frame, html: `<img src="${origin}${path}">` },
      )
      expect(output, path).not.toBe('unexpected success')
    }
    expect(requests.map((value) => value.path)).not.toContain('/redirect-target.png')
    expect(requests.every((value) => !value.cookie && !value.authorization)).toBe(true)
  } finally {
    await exportPage.close()
    publicServer.closeAllConnections()
    await new Promise<void>((resolve, reject) => publicServer.close((error) => (error ? reject(error) : resolve())))
  }
}, 30_000)

it('the current owner reads exact source image/font bytes while another account cannot', async () => {
  for (const [path, bytes] of [
    [assetPath, image],
    [new URL(font.url).pathname, fontBytes],
  ] as const) {
    const allowed = await owner.get(path)
    expect(allowed.status).toBe(200)
    expect(Buffer.from(await allowed.arrayBuffer())).toEqual(bytes)
    const denied = await stranger.get(path)
    expect(denied.status).toBe(404)
    expect((await denied.arrayBuffer()).byteLength).toBe(0)
  }
})
it('an authorized headless screenshot paints the private image pixels', async () => {
  const response = await owner.get(`/i/${frameId}.png`)
  expect(response.status).toBe(200)
  const { data, info } = await sharp(Buffer.from(await response.arrayBuffer()))
    .raw()
    .toBuffer({ resolveWithObject: true })
  const at = (24 * info.width + 24) * info.channels
  expect([...data.subarray(at, at + 3)]).toEqual(color)
})
it('the actual opaque editor iframe loads its authorized private image', async () => {
  const state = await rendered.$eval('[data-private-image]', (element) => ({
    width: (element as HTMLImageElement).naturalWidth,
    complete: (element as HTMLImageElement).complete,
  }))
  expect(state).toEqual({ width: 16, complete: true })
})
it('the actual opaque editor iframe loads its authorized private font face', async () => {
  const statuses = await rendered.evaluate(async (family) => {
    await document.fonts.ready
    return [...document.fonts]
      .filter((face) => face.family.replace(/^['"]|['"]$/g, '') === family)
      .map((face) => face.status)
  }, font.family)
  expect(statuses).toEqual(['loaded'])
})
it('materialization preserves the script-only sandbox and gives the frame no readable session cookie', async () => {
  expect(await page.$eval(`iframe[title="${title}"]`, (element) => element.getAttribute('sandbox'))).toBe(
    'allow-scripts',
  )
  const hasSession = await rendered.evaluate(() => {
    try {
      return document.cookie.length > 0
    } catch {
      return false
    }
  })
  expect(hasSession).toBe(false)
})

it('the authenticated materializer binds a draft to its live parent even when the reader owns both canvases', async () => {
  const other = await (await owner.post('/api/canvases', { name: 'Second owned parent' })).json()
  const foreignBytes = await sharp({ create: { width: 4, height: 4, channels: 4, background: 'blue' } })
    .png()
    .toBuffer()
  const uploaded = await owner.req(`/api/canvases/${other.id}/assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: new Uint8Array(foreignBytes),
  })
  expect(uploaded.status).toBe(200)
  const foreign = (await uploaded.json()).url as string
  const otherFrame = await (
    await owner.post(`/api/canvases/${other.id}/frames`, {
      name: 'Other',
      x: 0,
      y: 0,
      width: 16,
      height: 16,
      html: `<img src="${foreign}">`,
    })
  ).json()
  const request = (parent: string, id: string, source: string) =>
    owner.post(`/api/canvases/${parent}/private-materialization`, {
      source,
      syntax: 'html',
      context: { kind: 'frame', id },
    })
  const allowed = await request(canvasId, frameId, canonicalHtml)
  expect(allowed.status).toBe(200)
  expect(allowed.headers.get('cache-control')).toBe('private, no-store')
  const prepared = await allowed.json()
  expect(prepared.privateMedia).toBe(true)
  expect(prepared.replacements).toHaveLength(2)
  expect(prepared.html.includes(image.toString('base64'))).toBe(true)
  expect(prepared.html.includes(owner.header())).toBe(false)
  for (const source of [
    `<img src="${foreign}">`,
    `<style>body{background:url("${foreign}")}</style>`,
    `<svg><image href="${foreign}"/></svg>`,
    `<base href="https://untrusted.invalid/"><img src="${new URL(foreign).pathname}">`,
  ]) {
    const denied = await request(canvasId, frameId, source)
    expect(denied.status).toBe(404)
    expect((await denied.arrayBuffer()).byteLength).toBe(0)
  }
  const legitimateOther = await request(other.id, otherFrame.id, `<img src="${foreign}">`)
  expect(legitimateOther.status).toBe(200)
  expect((await legitimateOther.json()).html.includes(foreignBytes.toString('base64'))).toBe(true)
  const wrongIdentity = await request(canvasId, otherFrame.id, canonicalHtml)
  expect(wrongIdentity.status).toBe(404)
  expect((await wrongIdentity.arrayBuffer()).byteLength).toBe(0)
})

it('runtime snapshot and element code retain canonical private IDs without transient bytes', async () => {
  const result = await page.evaluate((id) => window.readPrivateRendering(id), frameId)
  expect(result.snapshot?.includes(assetPath)).toBe(true)
  expect(result.snapshot?.includes(new URL(font.url).pathname)).toBe(true)
  expect(result.snapshot?.includes(';doop-resource=')).toBe(false)
  expect(result.snapshot?.includes(image.toString('base64'))).toBe(false)
  expect(result.code?.includes(assetPath)).toBe(true)
  expect(result.code?.includes(';doop-resource=')).toBe(false)
  expect(new URL(result.image!).pathname).toBe(assetPath)
})

it('inline media and SVG failures are bounded while the actual source data remains canonical', async () => {
  const request = (source: string) =>
    owner.post(`/api/canvases/${canvasId}/private-materialization`, {
      source,
      syntax: 'html',
      context: { kind: 'frame', id: frameId },
    })
  const original = `<img src="data:image/png;base64,${image.toString('base64')}">`
  const inline = await request(original)
  expect(inline.status).toBe(200)
  const result = await inline.json()
  expect(result.html).toBe(original)
  expect(result.replacements).toEqual([])
  expect(result.privateMedia).toBe(true)
  const tooLarge = await readFile('tests/fixtures/compressed-100m-pixel.png')
  const denied = await request(`<img width="1" height="1" src="data:image/png;base64,${tooLarge.toString('base64')}">`)
  expect(denied.status).toBe(413)
  expect((await denied.json()).error).toBe('The document exceeds the private media budget.')
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><image href="https://foreign.invalid/private.png"/></svg>',
  )
  const badSvg = await request(`<img src="data:image/svg+xml;base64,${svg.toString('base64')}">`)
  expect(badSvg.status).toBe(422)
  expect((await badSvg.json()).error).toBe('The document contains an unsupported private media resource.')
})

it('normal scoped preparation returns real costs and only accepts reduced remaining budgets', async () => {
  const body = { source: `<img src="${assetPath}">`, syntax: 'html', context: { kind: 'frame', id: frameId } }
  const path = `/api/canvases/${canvasId}/private-materialization`
  const response = await owner.post(path, body)
  expect(response.status).toBe(200)
  const result = await response.json()
  expect(result.costs.references).toBe(1)
  expect(result.costs.parserWork).toBeGreaterThan(0)
  expect(result.costs.expandedBytes).toBe(Buffer.byteLength(result.html))
  expect(result.costs.resources).toHaveLength(1)
  expect(result.costs.resources[0]).toMatchObject({
    mime: 'image/png',
    encodedBytes: image.length,
    decodedBytes: 16 * 16 * 4,
  })
  expect(result.costs.resources[0].key).toContain(`private:${canvasId}:`)
  for (const remaining of [
    { encodedBytes: 0 },
    { decodedBytes: 0 },
    { references: 0 },
    { parserWork: 0 },
    { expandedBytes: 1 },
  ])
    expect((await owner.post(path, { ...body, remaining })).status).toBe(413)
  for (const remaining of [
    null,
    { costs: [] },
    { encodedBytes: 15_000_001 },
    { decodedBytes: 64 * 1024 * 1024 + 1 },
    { references: 0.5 },
  ])
    expect((await owner.post(path, { ...body, remaining })).status).toBe(400)
  expect((await owner.post(path, { ...body, costs: result.costs })).status).toBe(400)
  const current = await owner.post(path, {
    ...body,
    source: '',
    remaining: { encodedBytes: 0, decodedBytes: 0, references: 0, parserWork: 0, expandedBytes: 0 },
  })
  expect(current.status).toBe(200)
  expect((await current.json()).costs).toEqual({ resources: [], references: 0, parserWork: 0, expandedBytes: 0 })
})

it('source occurrences remain bounded even when a browser would coalesce repeated public requests', async () => {
  const path = `/api/canvases/${canvasId}/private-materialization`
  const request = (count: number) =>
    owner.post(path, {
      source: '<img src="https://public.invalid/repeated.png">'.repeat(count),
      syntax: 'html',
      context: { kind: 'frame', id: frameId },
    })
  const boundary = await request(64)
  expect(boundary.status).toBe(200)
  expect((await boundary.json()).costs.references).toBe(64)
  expect((await request(65)).status).toBe(413)
})

it('nested data documents share occurrence limits and URL-normalized data cannot hide a large raster', async () => {
  const path = `/api/canvases/${canvasId}/private-materialization`
  const request = (source: string) =>
    owner.post(path, { source, syntax: 'html', context: { kind: 'frame', id: frameId } })
  const nested = (count: number) =>
    `<iframe src="data:text/html;base64,${Buffer.from('<img src="https://public.invalid/repeated.png">'.repeat(count)).toString('base64')}"></iframe>`
  const boundary = await request(nested(63))
  expect(boundary.status).toBe(200)
  expect((await boundary.json()).costs.references).toBe(64)
  expect((await request(nested(64))).status).toBe(413)
  const forbidden = await readFile('tests/fixtures/compressed-100m-pixel.png')
  expect((await request(`<img src="d&#9;ata:image/png;base64,${forbidden.toString('base64')}">`)).status).toBe(413)
})

it('an image sink cannot bypass admission with an unknown binary format declared as plain text', async () => {
  // One tiny real BMP proves the browser sink; never decode a forbidden large file.
  const bmp = Buffer.alloc(58)
  bmp.write('BM')
  bmp.writeUInt32LE(58, 2)
  bmp.writeUInt32LE(54, 10)
  bmp.writeUInt32LE(40, 14)
  bmp.writeInt32LE(1, 18)
  bmp.writeInt32LE(1, 22)
  bmp.writeUInt16LE(1, 26)
  bmp.writeUInt16LE(24, 28)
  bmp.writeUInt32LE(4, 34)
  bmp[54] = 67
  bmp[55] = 165
  bmp[56] = 13
  const uri = `data:text/plain;base64,${bmp.toString('base64')}`
  const actual = await page.evaluate(async (url) => {
    const image = new Image()
    image.src = url
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const context = canvas.getContext('2d')!
    context.drawImage(image, 0, 0)
    return { width: image.naturalWidth, pixel: [...context.getImageData(0, 0, 1, 1).data].slice(0, 3) }
  }, uri)
  expect(actual).toEqual({ width: 1, pixel: color })
  for (const source of [
    `<img src="${uri}">`,
    `<img srcset="${uri} 1x">`,
    `<svg><image href="${uri}"></image></svg>`,
    `<style>.x{background:u\\72l("${uri.replace('data:', 'd\\61 ta:')}")}</style>`,
  ]) {
    const response = await owner.post(`/api/canvases/${canvasId}/private-materialization`, {
      source,
      syntax: 'html',
      context: { kind: 'frame', id: frameId },
    })
    expect(response.status, source.slice(0, 60)).toBe(422)
  }
  const plain = await owner.post(`/api/canvases/${canvasId}/private-materialization`, {
    source: '<a href="data:text/plain,hello">Download text</a>',
    syntax: 'html',
    context: { kind: 'frame', id: frameId },
  })
  expect(plain.status).toBe(200)
  expect((await plain.json()).html).toContain('data:text/plain,hello')
})

it('normal editor save persists canonical private IDs after a real DOM edit', async () => {
  await rendered.evaluate(() => {
    document.querySelector('[data-private-image]')!.setAttribute('data-real-edit-probe', 'saved')
  })
  await page.evaluate((title) => {
    const frame = document.querySelector<HTMLIFrameElement>(`iframe[title="${title}"]`)!
    frame.contentWindow!.postMessage({ type: 'doop:edit', on: true }, '*')
    frame.contentWindow!.postMessage({ type: 'doop:edit', on: false }, '*')
  }, title)
  let saved = ''
  await (async () => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const canvas = await (await owner.get(`/api/canvases/${canvasId}`)).json()
      saved = canvas.frames.find((frame: Frame) => frame.id === frameId)?.html ?? ''
      if (saved.includes('data-real-edit-probe="saved"')) return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error('normal editor did not persist the DOM edit')
  })()
  expect(saved).toContain(assetPath)
  expect(saved).toContain(new URL(font.url).pathname)
  expect(saved).not.toContain(';doop-resource=')
  expect(saved).not.toContain(image.toString('base64'))
  expect(saved).not.toContain(fontBytes.toString('base64'))
})

it('real editor roundtrip retains private hashes and deeply escaped srcdoc while preserving authored data URLs', async () => {
  const authored = `data:image/png;base64,${(
    await sharp({ create: { width: 2, height: 2, channels: 4, background: 'red' } })
      .png()
      .toBuffer()
  ).toString('base64')}`
  const canonical = `${fixture!.server.base}${assetPath}#roundtrip&tone=green`
  const escape = (html: string) => html.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
  const inner = `<img data-nested-private src="${canonical}">`
  const nested = `<iframe srcdoc="${escape(inner)}"></iframe>`
  const html = `<style>.escaped{width:16px;height:16px;background-image:u\\72l("${canonical}")}</style><div class="escaped"></div><img data-authored-inline src="${authored}"><iframe srcdoc="${escape(nested)}"></iframe>`
  const response = await owner.post(`/api/canvases/${canvasId}/frames`, {
    name: 'Private deep roundtrip',
    x: 0,
    y: 240,
    width: 320,
    height: 180,
    html,
  })
  expect(response.status).toBe(200)
  const frame = await response.json()
  await page.evaluate((frame) => window.focusPrivateFrame(frame), frame)
  const element = await page.waitForSelector('iframe[title="Private deep roundtrip"]')
  const root = await element!.contentFrame()
  if (!root) throw new Error('roundtrip editor iframe missing')
  await root.waitForSelector('[data-authored-inline]')
  const escaped = await root.waitForSelector('.escaped')
  // Wait for admitted data resources and a paint, not just DOM insertion.
  await root.evaluate(async () => {
    await Promise.all([...document.images].map((image) => image.decode()))
    const background = getComputedStyle(document.querySelector('.escaped')!).backgroundImage
    const image = new Image()
    image.src = JSON.parse(background.slice(4, -1))
    await image.decode()
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
  const painted = await sharp(await escaped!.screenshot({ type: 'png' }))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const at = (8 * painted.info.width + 8) * painted.info.channels
  expect([...painted.data.subarray(at, at + 3)]).toEqual(color)
  await root.waitForFunction(() => document.querySelectorAll('iframe').length === 1)
  const nestedElement = await root.$('iframe')
  const middle = await nestedElement!.contentFrame()
  if (!middle) throw new Error('middle srcdoc missing')
  await middle.waitForSelector('iframe')
  const deepestElement = await middle.$('iframe')
  const deepest = await deepestElement!.contentFrame()
  if (!deepest) throw new Error('deep srcdoc missing')
  await deepest.waitForFunction(
    () => document.querySelector<HTMLImageElement>('[data-nested-private]')?.naturalWidth === 16,
  )
  await root.evaluate(() => document.querySelector('.escaped')!.setAttribute('data-deep-edit', 'saved'))
  await element!.evaluate((element) => {
    const frame = element as HTMLIFrameElement
    frame.contentWindow!.postMessage({ type: 'doop:edit', on: true }, '*')
    frame.contentWindow!.postMessage({ type: 'doop:edit', on: false }, '*')
  })
  let saved = ''
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const current = await (await owner.get(`/api/canvases/${canvasId}`)).json()
    saved = current.frames.find((value: Frame) => value.id === frame.id)?.html ?? ''
    if (saved.includes('data-deep-edit="saved"')) break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  expect(saved).toContain('data-deep-edit="saved"')
  expect(saved).toContain(assetPath + '#roundtrip')
  expect(saved).toContain('tone=green')
  expect(saved).toContain(authored)
  expect(saved).not.toContain(image.toString('base64'))
  expect(saved).not.toContain(';doop-resource=')
})

it('the real Image fill URL edit prepares a new private file before the opaque child decodes it', async () => {
  const replacement = await sharp({
    create: { width: 8, height: 8, channels: 4, background: { r: 201, g: 43, b: 36, alpha: 1 } },
  })
    .png()
    .toBuffer()
  const upload = await owner.req(`/api/canvases/${canvasId}/assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: new Uint8Array(replacement),
  })
  expect(upload.status).toBe(200)
  const url = (await upload.json()).url as string
  const stored = await owner.get(new URL(url).pathname)
  expect(stored.status).toBe(200)
  const storedPixels = await sharp(Buffer.from(await stored.arrayBuffer()))
    .removeAlpha()
    .raw()
    .toBuffer()
  expect([...storedPixels.subarray(0, 3)]).toEqual([201, 43, 36])
  const steps: string[] = ['uploaded']
  const rawChildRequests: string[] = []
  const track = (request: import('puppeteer-core').HTTPRequest) => {
    if (request.frame() === rendered && new URL(request.url()).pathname.startsWith('/a/'))
      rawChildRequests.push(request.url())
  }
  page.on('request', track)
  try {
    await page.evaluate((id) => window.pickPrivateImage(id), frameId)
    await page.waitForSelector('[aria-label="Image fill"]', { timeout: 2000 })
    steps.push('picked')
    await page.click('[aria-label="Image fill"]')
    await page.locator('input[aria-label="Image URL"]').setTimeout(2000).fill(url)
    await page.focus('input[aria-label="Image URL"]')
    steps.push('filled')
    await page.keyboard.press('Enter')
    steps.push('submitted')
    await rendered.waitForFunction(
      () => document.querySelector<HTMLImageElement>('[data-private-image]')?.naturalWidth === 8,
      { timeout: 2000 },
    )
    steps.push('decoded')
    await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), { timeout: 2000 })
    steps.push('settled')
    await page.keyboard.press('Escape')
    await page.evaluate(() => window.clearPrivateImagePick())
    await page.waitForSelector('[aria-label="Image fill"]', { hidden: true, timeout: 2000 })
    const painted = await sharp(await (await rendered.$('[data-private-image]'))!.screenshot({ type: 'png' }))
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const at = (8 * painted.info.width + 8) * painted.info.channels
    expect([...painted.data.subarray(at, at + 3)]).toEqual([201, 43, 36])
    expect(rawChildRequests).toEqual([])
    const current = await (await owner.get(`/api/canvases/${canvasId}`)).json()
    const saved = current.frames.find((value: Frame) => value.id === frameId).html as string
    expect(saved).toContain(new URL(url).pathname)
    expect(saved).not.toContain(replacement.toString('base64'))
    expect(saved).not.toContain(';doop-resource=')
  } catch (error) {
    console.info('private ImageFill steps', steps)
    console.info('private ImageFill store', await page.evaluate(() => window.debugPrivateImage()))
    const capture = process.env.DOOP_PRIVATE_RENDER_CAPTURE
    if (capture) {
      await mkdir(capture, { recursive: true, mode: 0o700 })
      await page.screenshot({ path: join(capture, 'image-edit-failure.png') })
    }
    console.info(
      'private ImageFill UI',
      await page.evaluate(() => ({
        alerts: [...document.querySelectorAll('[role="alert"]')].map((element) => element.textContent),
        busy: document.querySelectorAll('[aria-busy="true"]').length,
        inputs: document.querySelectorAll('input[aria-label="Image URL"]').length,
      })),
    )
    throw error
  } finally {
    page.off('request', track)
    await page.keyboard.press('Escape')
  }
}, 15_000)

it('the actual editor removes old private frame bytes when its live canvas is deleted', async () => {
  expect((await owner.delete(`/api/canvases/${canvasId}`)).status).toBe(200)
  await page.waitForFunction((title) => !document.querySelector(`iframe[title="${title}"]`), {}, title)
  // The real deletion handler navigates to the dashboard and replaces the
  // document, so its prior bridge/helpers are gone along with every iframe.
  expect(new URL(page.url()).pathname).not.toContain(canvasId)
  await page.waitForFunction(() => (document.querySelector('#root')?.childElementCount ?? 0) > 0)
  const visible = await page.content()
  expect(visible).not.toContain(image.toString('base64'))
  expect(visible).not.toContain(';doop-resource=')
  const denied = await owner.post(`/api/canvases/${canvasId}/private-materialization`, {
    source: canonicalHtml,
    syntax: 'html',
    context: { kind: 'frame', id: frameId },
  })
  expect(denied.status).toBe(404)
  expect(await denied.text()).toBe('')
})
