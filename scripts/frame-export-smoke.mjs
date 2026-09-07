/* global document, fetch, performance */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import puppeteer from 'puppeteer-core'
import { unzipSync } from 'fflate'

const base = process.env.DOOP_TEST_BASE || 'http://127.0.0.1:4300'
const email = process.env.DOOP_TEST_EMAIL
const password = process.env.DOOP_TEST_PASSWORD
assert.ok(email && password, 'Set DOOP_TEST_EMAIL and DOOP_TEST_PASSWORD to an existing test account.')
const output = await mkdtemp(path.join(tmpdir(), 'doop-export-'))
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 1000 })
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
const client = await page.createCDPSession()
await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: output })

async function api(url, body) {
  return page.evaluate(
    async ({ url, body }) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) throw new Error(`Request failed: ${response.status}`)
      return response.json()
    },
    { url, body },
  )
}
async function layer(name) {
  await page.locator('[aria-label="Search layers and assets"]').fill(name)
  await page.locator(`[role="treeitem"][aria-label="${name}"]`).click()
  await page.click('[aria-label="Search layers and assets"]', { clickCount: 3 })
  await page.keyboard.down('Control')
  await page.keyboard.press('a')
  await page.keyboard.up('Control')
  await page.keyboard.press('Backspace')
  await page.waitForSelector('[data-testid="design-selection-outline"]')
}
async function openExport() {
  await page.locator('[title="Export current selection"]').click()
  await page.waitForSelector('[role="dialog"]')
}
async function download() {
  const destination = await mkdtemp(path.join(output, 'download-'))
  await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: destination })
  const previous = new Set()
  await page.locator('[role="dialog"] [data-slot="modal-actions"] button:last-child').click()
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    const file = (await readdir(destination)).find((name) => !previous.has(name) && !name.endsWith('.crdownload'))
    if (file) {
      await page.waitForFunction(() => !document.querySelector('[role="dialog"]'))
      return { name: file, bytes: await readFile(path.join(destination, file)) }
    }
    const error = await page.$eval('body', (body) => body.querySelector('[role="dialog"] [role="alert"]')?.textContent)
    if (error) throw new Error(error)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Download did not finish.')
}
function dimensions(png) {
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  return [png.readUInt32BE(16), png.readUInt32BE(20)]
}

try {
  await page.goto(base, { waitUntil: 'networkidle0' })
  await page.locator('input[type="email"]').fill(email)
  await page.locator('input[type="password"]').fill(password)
  await page.locator('button[type="submit"]').click()
  await page.waitForFunction(() => !document.querySelector('input[type="password"]'))
  const canvas = await api('/api/canvases', { name: 'Editor export · Test' })
  const html = await readFile(new URL('../tests/fixtures/design-editor.html', import.meta.url), 'utf8')
  const frame = await api(`/api/canvases/${canvas.id}/frames`, {
    name: 'Orbit',
    html,
    width: 880,
    height: 740,
    x: 0,
    y: 0,
  })
  await page.goto(`${base}/c/${canvas.id}?frame=${frame.id}`, { waitUntil: 'networkidle0' })
  await page.waitForSelector('[aria-label="Layer navigator"]')
  await layer('Headline')
  await openExport()
  assert.equal(await page.$eval('#export-scope', (select) => select.value), 'element')
  const preview = await page.$eval('[aria-label="Files to export"]', (list) =>
    list.textContent
      .match(/(\d+) × (\d+) px/)
      .slice(1)
      .map(Number),
  )
  await page.screenshot({ path: path.join(output, 'editor-export.png') })
  assert.deepEqual(dimensions((await download()).bytes), preview)
  console.log('PASS layer navigator selection exports the measured element')

  await page.locator('[aria-label="Font size"]').fill('60')
  await page.keyboard.press('Enter')
  await openExport()
  const updated = await page.$eval('[aria-label="Files to export"]', (list) =>
    list.textContent
      .match(/(\d+) × (\d+) px/)
      .slice(1)
      .map(Number),
  )
  assert.deepEqual(dimensions((await download()).bytes), updated)
  console.log('PASS export waits for edited source and refreshed bounds')

  await page.locator('[aria-label="Select parent layer"]').click()
  await openExport()
  assert.equal(await page.$eval('#export-scope', (select) => select.value), 'element')
  const parent = await page.$eval('[aria-label="Files to export"]', (list) =>
    list.textContent
      .match(/(\d+) × (\d+) px/)
      .slice(1)
      .map(Number),
  )
  assert.deepEqual(dimensions((await download()).bytes), parent)
  console.log('PASS parent-layer selection updates the export target')

  await page.locator('[role="treeitem"][aria-label="Orbit"]').click()
  await openExport()
  assert.equal(await page.$('#export-scope'), null)
  await page.select('#export-scale', '0.5')
  assert.deepEqual(dimensions((await download()).bytes), [440, 370])
  console.log('PASS selecting the frame clears the previous element target')

  await api(`/api/canvases/${canvas.id}/frames`, {
    name: 'Orbit',
    html: '<body style="margin:0;background:#123456">Second</body>',
    width: 200,
    height: 100,
    x: 960,
    y: 0,
  })
  // Marquee all frames through the canvas selection API; the export itself
  // uses the visible toolbar and dialog, including the real download action.
  await page.waitForFunction(async () => {
    const { useStore } = await import(
      performance.getEntriesByType('resource').find((entry) => entry.name.includes('/src/lib/store.ts')).name
    )
    return useStore.getState().canvas?.frames.length === 2
  })
  await page.evaluate(async () => {
    const { useStore } = await import(
      performance.getEntriesByType('resource').find((entry) => entry.name.includes('/src/lib/store.ts')).name
    )
    useStore.getState().selectMany(useStore.getState().canvas.frames.map((frame) => frame.id))
  })
  await openExport()
  const zipped = unzipSync((await download()).bytes)
  assert.deepEqual(Object.keys(zipped), ['Orbit.png', 'Orbit (2).png'])
  console.log('PASS multi-frame ZIP preserves duplicate names as distinct files')
  await openExport()
  await page.select('#export-mode', 'combined')
  await page.select('#export-scale', '1')
  assert.deepEqual(dimensions((await download()).bytes), [1160, 740])
  console.log('PASS combined export preserves frame positions and spacing')
  await openExport()
  await page.keyboard.press('Escape')
  await openExport()
  assert.ok(await page.$('#export-mode'))
  await page.setViewport({ width: 390, height: 844 })
  await page.screenshot({ path: path.join(output, 'editor-export-mobile.png') })
  assert.equal(await page.$eval('[role="dialog"]', (dialog) => dialog.scrollWidth > dialog.clientWidth), false)
  assert.deepEqual(errors, [])
  console.log(`PASS Escape and mobile dialog; artifacts: ${output}; canvas: ${canvas.id}`)
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failure.png') })
  throw error
} finally {
  await browser.close()
}
