import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import type { Frame } from 'puppeteer-core'
import { createServer } from 'vite'
import { describe, expect, it } from 'vitest'
import { doopSourceCanvas } from '../server/sourceCanvasPlugin.ts'
import { findBrowserPath } from '../server/screenshot.ts'
import { SOURCE_CANVAS_PATH, sourceSelection } from '../shared/sourceCanvas.ts'
import { fixtureUrl, pagePerTest } from './browser.ts'

const content = `import React from 'react'
export default function Demo() {
  return <main>
    <h1 id="headline" data-doop-edit="headline" style={{ color: '#334455', margin: 0 }}
      onMouseDown={(event) => event.currentTarget.setAttribute('data-mouse-down', '')}
      onPointerUp={(event) => event.currentTarget.setAttribute('data-pointer-up', '')}>First draft</h1>
    <div id="nested" style={{ height: 120, width: 260, overflow: 'auto', overscrollBehavior: 'contain' }}>
      <div style={{ height: 800 }}>Nested content</div>
    </div>
    <div style={{ height: 1400 }}>Long document</div>
    <p id="end">End of page</p>
  </main>
}`

describe.skipIf(!findBrowserPath())('local source canvas', () => {
  const pages = pagePerTest()

  it('runs two React cards, saves JSX, refreshes from disk, and separates pan from native scroll', async () => {
    const page = await pages.open()
    await page.setViewport({ width: 1300, height: 800 })
    const host = new URL('/local-canvas.html', fixtureUrl('prototype.html'))
    const root = await mkdtemp(path.join(process.cwd(), '.doop-source-test-'))
    const file = path.join(root, 'Demo.tsx')
    let project: Awaited<ReturnType<typeof createServer>> | undefined
    try {
      await writeFile(file, content)
      project = await createServer({
        root,
        configFile: false,
        logLevel: 'error',
        appType: 'custom',
        optimizeDeps: { include: ['react', 'react-dom/client'] },
        server: { host: '127.0.0.1', port: 0 },
        plugins: [
          react(),
          doopSourceCanvas({
            doopOrigin: host.origin,
            name: 'Test project',
            cards: ['large', 'small'].map((id) => ({
              id,
              name: id,
              width: id === 'large' ? 480 : 360,
              height: 360,
              entry: 'Demo.tsx',
              source: 'Demo.tsx',
            })),
          }),
        ],
      })
      await project.listen()
      const origin = new URL(project.resolvedUrls!.local[0]!).origin
      const endpoint = origin + SOURCE_CANVAS_PATH
      const selectionHeaders = { Origin: host.origin }
      expect((await fetch(endpoint + '/project', { headers: { Origin: 'https://example.com' } })).status).toBe(403)
      const initial = sourceSelection.parse(
        await (await fetch(endpoint + '/selection?card=large&marker=headline', { headers: selectionHeaders })).json(),
      )

      await page.goto(host.href)
      await page.locator('input[placeholder="http://127.0.0.1:5173"]').fill(origin)
      await page.locator('::-p-text(Connect project)').click()

      async function card(id: string): Promise<Frame> {
        const iframe = await page.waitForSelector(`iframe[data-source-card="${id}"]`)
        const screen = await iframe!.contentFrame()
        await screen.waitForSelector('#headline')
        return screen
      }

      const large = await card('large')
      const small = await card('small')
      expect(await large.$eval('#headline', (el) => el.textContent)).toBe('First draft')
      expect(await small.$eval('#headline', (el) => el.textContent)).toBe('First draft')

      async function over(x: number, y: number) {
        const box = await page.$eval('iframe[data-source-card="large"]', (el) => {
          const rect = el.getBoundingClientRect()
          return { x: rect.x, y: rect.y, scale: rect.width / (el as HTMLIFrameElement).offsetWidth }
        })
        await page.mouse.move(box.x + x * box.scale, box.y + y * box.scale)
      }

      await over(60, 15)
      await page.mouse.down()
      await page.mouse.up()
      const inspector = 'aside[aria-label="Source inspector"]'
      await page.locator(inspector + ' label:first-child input').fill('Saved by Doop')
      expect(await large.$eval('#headline', (el) => el.hasAttribute('data-mouse-down'))).toBe(false)
      expect(await large.$eval('#headline', (el) => el.hasAttribute('data-pointer-up'))).toBe(false)
      await page.locator(inspector + ' label:nth-child(2) input').fill('#cc4422')
      const [write] = await Promise.all([
        page.waitForResponse(
          (response) => response.url() === endpoint + '/edit' && response.request().method() === 'POST',
        ),
        page.locator(inspector + ' button[type="submit"]').click(),
      ])
      expect(write.status(), await write.text()).toBe(200)
      const saved = content.replace('First draft', '{"Saved by Doop"}').replace('#334455', '#cc4422')
      await expect.poll(() => readFile(file, 'utf8')).toBe(saved)
      await large.waitForFunction(() => document.querySelector('#headline')?.textContent === 'Saved by Doop')
      await small.waitForFunction(
        () => getComputedStyle(document.querySelector('#headline')!).color === 'rgb(204, 68, 34)',
      )
      const screenshot = process.env.DOOP_SOURCE_CAPTURE
      if (screenshot) await page.screenshot({ path: screenshot })

      await writeFile(file, saved.replace('Saved by Doop', 'Changed on disk'))
      await large.waitForFunction(() => document.querySelector('#headline')?.textContent === 'Changed on disk')
      expect(
        (
          await fetch(endpoint + '/edit', {
            method: 'POST',
            headers: { ...selectionHeaders, 'Content-Type': 'application/json', 'X-Doop-Source': '1' },
            body: JSON.stringify({
              card: 'large',
              marker: 'headline',
              revision: initial.revision,
              fields: { text: 'Stale edit' },
            }),
          })
        ).status,
      ).toBe(409)

      await page.reload()
      const reloaded = await card('large')
      expect(await reloaded.$eval('#headline', (el) => el.textContent)).toBe('Changed on disk')
      const camera = () => page.$eval('[data-source-world]', (el) => (el as HTMLElement).style.transform)
      const initialCamera = await camera()
      await over(60, 200)
      await page.mouse.wheel({ deltaY: 50 })
      await expect.poll(camera).not.toBe(initialCamera)
      expect(await reloaded.evaluate(() => scrollY)).toBe(0)
      await page.locator('::-p-text(Reset view)').click()
      await page.locator('article:first-child button').click()
      await page.waitForSelector('article:first-child button[aria-pressed="true"]')

      const playCamera = await camera()
      await over(60, 15)
      await page.mouse.down()
      await page.mouse.up()
      await reloaded.waitForSelector('#headline[data-mouse-down][data-pointer-up]')
      await over(60, 70)
      await page.mouse.wheel({ deltaY: 70 })
      await reloaded.waitForFunction(() => (document.querySelector('#nested')?.scrollTop ?? 0) > 0)
      expect(await reloaded.evaluate(() => scrollY)).toBe(0)
      await over(60, 220)
      await page.mouse.wheel({ deltaY: 140 })
      await reloaded.waitForFunction(() => scrollY > 0)
      expect(await camera()).toBe(playCamera)
    } finally {
      try {
        await page.close()
        await project?.close()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  }, 90_000)
})
