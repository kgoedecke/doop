import { afterAll, beforeAll, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { readFile } from 'node:fs/promises'
import sharp from 'sharp'
import { createServer, type ViteDevServer } from 'vite'
import type { Canvas, Frame } from '../shared/types'
import { Client } from './harness'
import { startPrivateServer } from './privateServer'
import { fixtureServerConfig, openBrowser } from './browser'

type Kind = 'prototype' | 'history' | 'memory' | 'drag'
declare global {
  interface Window {
    mountPrivateConsumer: (kind: Kind, canvas: Canvas, frame: Frame) => void
    exportPrivatePng: (frame: Frame) => Promise<boolean>
    exportPrivateHtml: (frame: Frame) => Promise<{ url: string; source: string }>
    clearPrivateFixture: () => void
  }
}
let fixture: Awaited<ReturnType<typeof startPrivateServer>> | undefined
let browser: Awaited<ReturnType<typeof openBrowser>> | undefined
let web: ViteDevServer | undefined
let canvas: Canvas
let frame: Frame
let owner: Client
let image: Buffer
let fontBytes: Buffer
let family: string
let fontUrl: string
let imageUrl: string
let origin: string
beforeAll(async () => {
  fixture = await startPrivateServer()
  owner = await new Client(fixture.server).signUp('private-consumers@test.dev', 'Private consumers')
  canvas = await (await owner.post('/api/canvases', { name: 'Private consumers' })).json()
  image = await sharp({
    create: { width: 16, height: 16, channels: 4, background: { r: 13, g: 165, b: 67, alpha: 1 } },
  })
    .png()
    .toBuffer()
  const uploaded = await owner.req(`/api/canvases/${canvas.id}/assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: new Uint8Array(image),
  })
  expect(uploaded.status).toBe(200)
  const url = (await uploaded.json()).url
  imageUrl = url
  fontBytes = await readFile('tests/fixtures/fonts/nunito-sans-bold-italic.woff2')
  const uploadedFont = await owner.req(`/api/fonts?canvas=${canvas.id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'nunito-sans-bold-italic.woff2' },
    body: new Uint8Array(fontBytes),
  })
  expect(uploadedFont.status).toBe(200)
  const font = await uploadedFont.json()
  family = font.family
  fontUrl = font.url
  const html = `<style>html,body{margin:0;background:white}.type{position:absolute;left:80px;top:0;font:italic 700 24px ${JSON.stringify(family)},serif}</style><img data-private-image width="48" height="48" src="${url}"><span class="type">WWW</span>`
  const createFrame = async (name: string) => {
    const response = await owner.post(`/api/canvases/${canvas.id}/frames`, {
      name,
      x: 0,
      y: 0,
      width: 320,
      height: 180,
      html,
    })
    expect(response.status).toBe(200)
    return response.json() as Promise<Frame>
  }
  frame = await createFrame('Private live consumer')
  const pinned = await createFrame('Private pinned consumer')
  expect((await owner.post(`/api/canvases/${canvas.id}/references`, { frameId: pinned.id })).status).toBe(200)
  expect((await owner.delete(`/api/frames/${pinned.id}`)).status).toBe(200)
  canvas = await (await owner.get(`/api/canvases/${canvas.id}`)).json()
  expect(canvas.references).toHaveLength(1)
  expect(canvas.frames.some((value) => value.id === pinned.id)).toBe(false)
  browser = await openBrowser()
  await browser.newPage().then(async (page) => {
    await page.browserContext().setCookie(
      ...owner
        .header()
        .split(';')
        .map((pair) => {
          const at = pair.indexOf('=')
          return {
            name: pair.slice(0, at).trim(),
            value: pair.slice(at + 1).trim(),
            domain: new URL(fixture!.server.base).hostname,
            path: '/',
            httpOnly: true,
            sameSite: 'Lax' as const,
            secure: false,
          }
        }),
    )
    await page.close()
  })
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
  origin = web.resolvedUrls!.local[0]!
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
async function openPage(): Promise<Page> {
  const page = await browser!.newPage()
  await page.goto(origin + 'tests/fixtures/privateConsumers.html')
  await page.waitForFunction(() => typeof window.mountPrivateConsumer === 'function')
  return page
}
async function assertPainted(page: Page, selector = 'iframe') {
  const element = await page.waitForSelector(selector)
  const child = await element!.contentFrame()
  if (!child) throw new Error('private consumer iframe missing')
  await child.waitForFunction(
    async (family) => {
      await document.fonts.ready
      const image = document.querySelector<HTMLImageElement>('[data-private-image]')
      const font = [...document.fonts].find((face) => face.family.replace(/^['"]|['"]$/g, '') === family)
      return image?.naturalWidth === 16 && font?.status === 'loaded'
    },
    {},
    family,
  )
  const screenshot = await element!.screenshot({ type: 'png' })
  const { data, info } = await sharp(screenshot).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const at = (8 * info.width + 8) * info.channels
  expect([...data.subarray(at, at + 3)]).toEqual([13, 165, 67])
  expect(
    await child.evaluate(() => {
      try {
        return document.cookie.length
      } catch {
        return 0
      }
    }),
  ).toBe(0)
  return element
}
it.each(['prototype', 'history', 'memory'] as const)(
  'the actual %s component paints scoped private files with its normal cookie API',
  async (kind) => {
    const page = await openPage()
    try {
      await page.evaluate(({ kind, canvas, frame }) => window.mountPrivateConsumer(kind, canvas, frame), {
        kind,
        canvas,
        frame,
      })
      if (kind === 'history')
        await page.evaluate(() => {
          const button = [...document.querySelectorAll('button')].find((button) =>
            button.textContent?.trim().startsWith('Current'),
          )
          if (!button) throw new Error('history current row missing')
          button.click()
        })
      const element = await assertPainted(page)
      expect(await element!.evaluate((element) => element.getAttribute('sandbox'))).toBe(
        kind === 'prototype' ? 'allow-scripts' : '',
      )
      if (kind === 'memory') {
        await page.locator('button:has(iframe)').click()
        await assertPainted(page, '[role="dialog"] iframe')
      }
    } finally {
      await page.close()
    }
  },
)
it('normal HTML download embeds exact authorized private bytes and observable invalidation revokes its real object URL', async () => {
  const page = await openPage()
  try {
    const result = await page.evaluate((frame) => window.exportPrivateHtml(frame), frame)
    expect(result.source).toContain(image.toString('base64'))
    expect(result.source).toContain(fontBytes.toString('base64'))
    expect(result.source).not.toContain(owner.header())
    await page.evaluate(() => window.clearPrivateFixture())
    expect(
      await page.evaluate(async (url) => {
        try {
          await fetch(url)
          return 'readable'
        } catch {
          return 'revoked'
        }
      }, result.url),
    ).toBe('revoked')
  } finally {
    await page.close()
  }
})

it('a real foreign-parent draft cannot fall back to a successful older stored image', async () => {
  const other = await (await owner.post('/api/canvases', { name: 'Other export parent' })).json()
  const uploaded = await owner.req(`/api/canvases/${other.id}/assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: new Uint8Array(image),
  })
  expect(uploaded.status).toBe(200)
  const url = (await uploaded.json()).url
  const page = await openPage()
  const requests: string[] = []
  page.on('request', (request) => {
    requests.push(new URL(request.url()).pathname)
  })
  try {
    expect(
      await page.evaluate((frame) => window.exportPrivatePng(frame), { ...frame, html: `<img src="${url}">` }),
    ).toBe(false)
    expect(requests.filter((path) => path.startsWith('/i/'))).toEqual([])
    // Resource denial did not falsely revoke the still-authorized canvas.
    expect(await page.evaluate((frame) => window.exportPrivatePng(frame), frame)).toBe(true)
  } finally {
    await page.close()
  }
})

it('the real drawing drag preview materializes private image and font bytes under its source frame', async () => {
  const html = `<html><body><div data-doop-drawing="rectangle" style="position:absolute;left:40px;top:40px;width:150px;height:80px"><style>@font-face{font-family:DragPrivate;src:url("${fontUrl}")}</style><img data-private-image width="48" height="48" src="${imageUrl}"><span style="font:24px DragPrivate">WWW</span></div></body></html>`
  const response = await owner.post(`/api/canvases/${canvas.id}/frames`, {
    name: 'Private drag source',
    x: 0,
    y: 0,
    width: 320,
    height: 180,
    html,
  })
  expect(response.status).toBe(200)
  const frame = await response.json()
  const current = await (await owner.get(`/api/canvases/${canvas.id}`)).json()
  const page = await openPage()
  try {
    await page.evaluate(({ canvas, frame }) => window.mountPrivateConsumer('drag', canvas, frame), {
      canvas: current,
      frame,
    })
    const element = await page.waitForSelector('iframe[title="Private drag source"]')
    const source = await element!.contentFrame()
    if (!source) throw new Error('drag source frame missing')
    await source.waitForFunction(
      () => document.querySelector<HTMLImageElement>('[data-private-image]')?.naturalWidth === 16,
    )
    const drawing = await source.$('[data-doop-drawing]')
    const box = await drawing!.boundingBox()
    if (!box) throw new Error('drag source drawing is not visible')
    await page.mouse.move(box.x + 20, box.y + 20)
    await page.mouse.down()
    await page.mouse.move(box.x + 80, box.y + 50, { steps: 5 })
    const previewElement = await page.waitForSelector('iframe[title="Moving drawing"]')
    const preview = await previewElement!.contentFrame()
    if (!preview) throw new Error('private drag preview missing')
    await preview.waitForFunction(async () => {
      await document.fonts.ready
      return (
        document.querySelector<HTMLImageElement>('[data-private-image]')?.naturalWidth === 16 &&
        [...document.fonts].some(
          (font) => font.family.replace(/^['"]|['"]$/g, '') === 'DragPrivate' && font.status === 'loaded',
        )
      )
    })
    expect(await previewElement!.evaluate((element) => element.getAttribute('sandbox'))).toBe('')
    const painted = await sharp(await previewElement!.screenshot({ type: 'png' }))
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const at = (8 * painted.info.width + 8) * painted.info.channels
    expect(painted.data[at + 1]!).toBeGreaterThan(painted.data[at]! + 60)
    expect(painted.data[at + 1]!).toBeGreaterThan(painted.data[at + 2]! + 40)
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await page.waitForFunction(() => !document.querySelector('iframe[title="Moving drawing"]'))
  } finally {
    await page.close()
  }
})
