import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { settleFonts } from '../server/renderFonts.ts'
import { findBrowserPath, openIsolatedPage, renderFrame } from '../server/screenshot.ts'
import type { Frame } from '../shared/types.ts'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

/**
 * A frame's fonts are in its screenshot. A face declared in a linked
 * stylesheet (how a frame loads Google Fonts) is requested only once layout
 * needs it, after Chrome has fired `load`, so a capture taken at `load`
 * showed the fallback whenever the font file was slower than the render.
 */

const FONT = fs.readFileSync(new URL('./fixtures/fonts/nunito-sans-bold-italic.woff2', import.meta.url))
const FACE =
  "font-family:Probe;font-weight:700;font-style:italic;font-display:swap;src:url(/a/font.woff2?delay={delay}) format('woff2')"
const TEXT = '<p style="font:italic 700 32px Probe, serif;margin:0">Hamburgefonts</p>'

/* the asset origin: font files (optionally delayed or never answered), a
   stylesheet declaring the face, and a 404 */
let server: http.Server
let origin = ''

function serve(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://assets')
  if (url.pathname === '/a/hang.woff2') return
  setTimeout(
    () => {
      if (url.pathname === '/a/face.css') {
        const delay = url.searchParams.get('font-delay') ?? '0'
        res.writeHead(200, { 'content-type': 'text/css' }).end(`@font-face{${FACE.replace('{delay}', delay)}}`)
      } else if (url.pathname === '/a/font.woff2') {
        res.writeHead(200, { 'content-type': 'font/woff2', 'access-control-allow-origin': '*' }).end(FONT)
      } else {
        res.writeHead(404).end()
      }
    },
    Number(url.searchParams.get('delay') ?? 0),
  )
}

beforeAll(async () => {
  server = http.createServer(serve)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  stubEnv('BETTER_AUTH_URL', origin)
})

afterAll(async () => {
  unstubAllEnvs()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})

const frame = (head: string): Frame => ({
  id: 'fonts',
  canvasId: 'fonts-canvas',
  name: 'Fonts',
  html: `<!doctype html><html><head>${head}</head><body style="margin:0">${TEXT}</body></html>`,
  x: 0,
  y: 0,
  width: 320,
  height: 80,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'alice',
})

const inlineFace = (delay: number): Frame =>
  frame(`<style>@font-face{${FACE.replace('{delay}', String(delay))}}</style>`)
const linkedFace = (fontDelay: number): Frame =>
  frame(`<link rel="stylesheet" href="/a/face.css?font-delay=${fontDelay}">`)

describe.skipIf(!findBrowserPath())('font readiness in server renders', () => {
  it('captures a face from a linked stylesheet whose file arrives after load', async () => {
    const withFont = await renderFrame(inlineFace(0))
    const fallback = await renderFrame(frame('<style>@font-face{font-family:Probe;src:url(/a/none.woff2)}</style>'))
    expect(withFont.equals(fallback)).toBe(false)

    const late = await renderFrame(linkedFace(1500))
    expect(late.equals(withFont)).toBe(true)
  }, 60_000)

  it('waits a bounded time for a font that never arrives, then gives up', async () => {
    const { page, close } = await openIsolatedPage()
    try {
      await page.setContent(
        `<!doctype html><html><head><base href="${origin}/"></head>` +
          '<body><p style="font-family:Hang, serif">Waiting</p>' +
          '<style>@font-face{font-family:Hang;src:url(/a/hang.woff2)}</style></body></html>',
        { waitUntil: 'domcontentloaded' },
      )
      const started = Date.now()
      expect(await settleFonts(page.mainFrame(), 300)).toBe('timed out')
      expect(Date.now() - started).toBeLessThan(2000)
    } finally {
      await close()
    }
  }, 30_000)

  /* a stylesheet that failed before the wait began (a 404, or a CDN the render
     guard blocks) never fires load or error again: it must not hold the
     render until the deadline, nor skip the wait for the fonts */
  it('does not wait on a stylesheet that already failed', async () => {
    const { page, close } = await openIsolatedPage()
    try {
      await page.setContent(
        `<!doctype html><html><head><base href="${origin}/"><link rel="stylesheet" href="/a/missing.css">` +
          `<link rel="stylesheet" href="/a/face.css?font-delay=500"></head><body>${TEXT}</body></html>`,
      )
      const started = Date.now()
      expect(await settleFonts(page.mainFrame())).toBe('loaded')
      expect(Date.now() - started).toBeLessThan(3000)
      expect(await page.evaluate(() => document.fonts.check('italic 700 32px Probe'))).toBe(true)
    } finally {
      await close()
    }
  }, 30_000)

  it('reports loaded once the fonts the text uses are in', async () => {
    const { page, close } = await openIsolatedPage()
    try {
      await page.setContent(
        `<!doctype html><html><head><base href="${origin}/"><link rel="stylesheet" href="/a/face.css?font-delay=500"></head>` +
          `<body>${TEXT}</body></html>`,
      )
      expect(await settleFonts(page.mainFrame())).toBe('loaded')
      expect(await page.evaluate(() => document.fonts.check('italic 700 32px Probe'))).toBe(true)
    } finally {
      await close()
    }
  }, 30_000)
})
