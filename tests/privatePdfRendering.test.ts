import { expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import sharp from 'sharp'
import * as mupdf from 'mupdf'
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib'
import { Client } from './harness'
import { startPrivateServer } from './privateServer'
import { startPrivateStorageFixture } from './privateStorageFixture'

it.each(['disk', 'bucket'] as const)(
  'renders real private images and an embedded font on both PDF pages through %s storage',
  async (backend) => {
    let bucket: Awaited<ReturnType<typeof startPrivateStorageFixture>> | undefined
    let fixture: Awaited<ReturnType<typeof startPrivateServer>> | undefined
    try {
      if (backend === 'bucket') bucket = await startPrivateStorageFixture()
      fixture = await startPrivateServer(bucket?.env)
      const owner = await new Client(fixture.server).signUp('pdf-visual@test.dev', 'PDF visual')
      const stranger = await new Client(fixture.server).signUp('pdf-foreign@test.dev', 'PDF foreign')
      const canvas = await (await owner.post('/api/canvases', { name: 'Actual private PDF' })).json()
      const colors = [
        [13, 165, 67],
        [26, 48, 210],
      ] as const
      const urls: string[] = []
      for (const color of colors) {
        const image = await sharp({
          create: {
            width: 16,
            height: 16,
            channels: 4,
            background: { r: color[0], g: color[1], b: color[2], alpha: 1 },
          },
        })
          .png()
          .toBuffer()
        const uploaded = await owner.req(`/api/canvases/${canvas.id}/assets`, {
          method: 'POST',
          headers: { 'Content-Type': 'image/png' },
          body: new Uint8Array(image),
        })
        expect(uploaded.status).toBe(200)
        urls.push((await uploaded.json()).url)
      }
      const fontBytes = await readFile('tests/fixtures/fonts/nunito-sans-bold-italic.woff2')
      const uploadedFont = await owner.req(`/api/fonts?canvas=${canvas.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'nunito-sans-bold-italic.woff2' },
        body: new Uint8Array(fontBytes),
      })
      expect(uploadedFont.status).toBe(200)
      const font = await uploadedFont.json()
      const frames = []
      for (let index = 0; index < 2; index++) {
        const response = await owner.post(`/api/canvases/${canvas.id}/frames`, {
          name: `Page ${index + 1}`,
          x: index * 400,
          y: 0,
          width: index ? 200 : 320,
          height: index ? 120 : 240,
          html: `<style>html,body{margin:0;background:white}.type{position:absolute;left:80px;top:0;color:black;font:italic 700 24px ${JSON.stringify(font.family)},serif}</style><img width="48" height="48" src="${urls[index]}"><span class="type">WWW</span>`,
        })
        expect(response.status).toBe(200)
        frames.push(await response.json())
      }
      bucket?.resetCounts()
      const screenshot = await owner.get(`/i/${frames[0].id}.png`)
      expect(screenshot.status).toBe(200)
      const screenshotPixels = await sharp(Buffer.from(await screenshot.arrayBuffer()))
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
      const at = (24 * screenshotPixels.info.width + 24) * screenshotPixels.info.channels
      expect([...screenshotPixels.data.subarray(at, at + 3)]).toEqual(colors[0])
      const url = `/api/canvases/${canvas.id}/export.pdf?frames=${frames.map((frame) => frame.id).join(',')}`
      const response = await owner.get(url)
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      const bytes = new Uint8Array(await response.arrayBuffer())
      const pdf = await PDFDocument.load(bytes)
      expect(pdf.getPages().map((page) => [page.getWidth(), page.getHeight()])).toEqual([
        [240, 180],
        [150, 90],
      ])
      const embedded = pdf.context
        .enumerateIndirectObjects()
        .some(
          ([, value]) =>
            value instanceof PDFDict &&
            /Nunito/i.test(String(value.get(PDFName.of('FontName')))) &&
            (value.has(PDFName.of('FontFile2')) || value.has(PDFName.of('FontFile3'))),
        )
      expect(embedded).toBe(true)
      const rendered = mupdf.Document.openDocument(bytes, 'application/pdf')
      try {
        expect(rendered.countPages()).toBe(2)
        for (let index = 0; index < 2; index++) {
          const page = rendered.loadPage(index)
          try {
            const pixmap = page.toPixmap([4 / 3, 0, 0, 4 / 3, 0, 0], mupdf.ColorSpace.DeviceRGB, false)
            try {
              expect(pixmap.getWidth()).toBe(index ? 200 : 320)
              expect(pixmap.getHeight()).toBe(index ? 120 : 240)
              const pixels = pixmap.getPixels()
              const pixel = 24 * pixmap.getStride() + 24 * pixmap.getNumberOfComponents()
              expect([...pixels.subarray(pixel, pixel + 3)]).toEqual(colors[index])
              let ink = 0
              for (let y = 0; y < 40; y++)
                for (let x = 80; x < 190; x++) {
                  const at = y * pixmap.getStride() + x * pixmap.getNumberOfComponents()
                  if (pixels[at]! < 160 && pixels[at + 1]! < 160 && pixels[at + 2]! < 160) ink++
                }
              expect(ink).toBeGreaterThan(100)
            } finally {
              pixmap.destroy()
            }
          } finally {
            page.destroy()
          }
        }
      } finally {
        rendered.destroy()
      }
      if (bucket) {
        expect(bucket.counts.GET).toBeGreaterThanOrEqual(3)
        for (const file of [...urls, font.url]) {
          const raw = await fetch(`${bucket.endpoint}/${bucket.bucket}/${new URL(file).pathname.slice(3)}`)
          expect(raw.status).toBe(403)
        }
      }
      expect((await stranger.get(url)).status).toBe(404)
      expect((await fetch(fixture.server.base + url)).status).toBe(401)
    } finally {
      try {
        await fixture?.close()
      } finally {
        await bucket?.close()
      }
    }
  },
  180_000,
)
