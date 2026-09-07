/* global document, window, getComputedStyle, fetch */
/** Browser regression loop for the design editor. Supply an isolated development
 * server and existing test login through DOOP_TEST_BASE, DOOP_TEST_EMAIL and
 * DOOP_TEST_PASSWORD. Each run creates a fresh test canvas. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'

const base = process.env.DOOP_TEST_BASE || 'http://127.0.0.1:4300'
const email = process.env.DOOP_TEST_EMAIL
const password = process.env.DOOP_TEST_PASSWORD
assert.ok(email && password, 'Set DOOP_TEST_EMAIL and DOOP_TEST_PASSWORD to an existing test account.')
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
let canvasId
let frameId
const fixture = await readFile(new URL('../tests/fixtures/design-editor.html', import.meta.url), 'utf8')
const checks = []
function passed(name) {
  checks.push(name)
  console.log(`PASS ${name}`)
}

async function api(path, body, method = 'POST', target = page) {
  return target.evaluate(
    async ({ path, body, method }) => {
      const response = await fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: response.status, data: await response.json() }
    },
    { path, body, method },
  )
}
async function waitSaved() {
  await page.waitForFunction(
    () =>
      !document.querySelector('[aria-label="Design inspector"] footer [role="status"]')?.textContent.includes('Saving'),
  )
  const error = await page.$eval(
    '[aria-label="Design inspector"] footer',
    (footer) => footer.querySelector('[role="alert"]')?.textContent || null,
  )
  assert.equal(error, null)
}
async function typeValue(selector, value) {
  await page.waitForSelector(selector)
  await page.click(selector, { clickCount: 3 })
  await page.keyboard.down('Control')
  await page.keyboard.press('a')
  await page.keyboard.up('Control')
  if (value) await page.keyboard.type(value)
  else await page.keyboard.press('Backspace')
}
async function holdNextHtmlSave() {
  let resolveRequest
  const held = new Promise((resolve) => {
    resolveRequest = resolve
  })
  let captured = false
  await page.setRequestInterception(true)
  const handler = (request) => {
    const patch = request.method() === 'PATCH' ? JSON.parse(request.postData() || '{}') : null
    if (!captured && request.url().endsWith(`/api/frames/${frameId}`) && patch?.html !== undefined) {
      captured = true
      resolveRequest(request)
    } else void request.continue()
  }
  page.on('request', handler)
  return {
    held,
    async stop() {
      await page.setRequestInterception(false)
      page.off('request', handler)
    },
  }
}
async function field(label, value) {
  await typeValue(`[aria-label="${label}"]`, value)
  await page.keyboard.press('Enter')
  await waitSaved()
}
async function select(selector) {
  const names = {
    '#hero-title': 'Headline',
    '#hero': 'Hero · grid layout',
    '#art': 'Gradient artwork',
    '.orb': 'Orb · shadows',
    '#description': 'Description',
  }
  const name = names[selector]
  assert.ok(name, 'fixture layer has a visible name')
  await typeValue('[aria-label="Search layers and assets"]', name)
  await page.click(`[role="treeitem"][aria-label="${name}"]`)
  await page.waitForFunction((name) => document.querySelector('[aria-label="Layer name"]')?.value === name, {}, name)
  await typeValue('[aria-label="Search layers and assets"]', '')
  await page.keyboard.press('Tab')
  await page.waitForFunction(() => !!document.querySelector('[aria-label="Width"]')?.value)
}
function artboard() {
  const frame = page.frames().find((item) => item.url() === 'about:srcdoc')
  assert.ok(frame, 'rendered frame exists')
  return frame
}
async function clickDesignElement(selector, clickCount = 1) {
  // Puppeteer's frame.click does not account for the canvas transform. Convert
  // the element's rendered coordinates through the scaled iframe explicitly.
  const bounds = await page.$eval('iframe[title="Orbit · Landing page"]', (iframe) => {
    const rect = iframe.getBoundingClientRect()
    return { x: rect.x, y: rect.y, scale: rect.width / iframe.clientWidth }
  })
  const point = await artboard().$eval(selector, (element) => {
    const rect = element.getBoundingClientRect()
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  })
  await page.mouse.click(bounds.x + point.x * bounds.scale, bounds.y + point.y * bounds.scale, { count: clickCount })
}
async function waitRendered(selector, property, expected) {
  await artboard().waitForFunction(
    ({ selector, property, expected }) =>
      getComputedStyle(document.querySelector(selector)).getPropertyValue(property) === expected,
    {},
    { selector, property, expected },
  )
}
async function historyKey(key) {
  await page.keyboard.down('Control')
  await page.keyboard.press(key)
  await page.keyboard.up('Control')
}
async function rendered(selector, property) {
  const frame =
    page.frames().find((item) => item.url() === 'about:srcdoc' && item.name()) ||
    page.frames().find((item) => item.url() === 'about:srcdoc')
  assert.ok(frame, 'rendered frame exists')
  await frame.waitForFunction(
    ({ selector, property }) =>
      !!document.querySelector(selector) &&
      !!getComputedStyle(document.querySelector(selector)).getPropertyValue(property),
    {},
    { selector, property },
  )
  return frame.evaluate(
    ({ selector, property }) => getComputedStyle(document.querySelector(selector)).getPropertyValue(property),
    { selector, property },
  )
}
try {
  await page.goto(base, { waitUntil: 'networkidle0' })
  await page.type('input[type="email"]', email)
  await page.type('input[type="password"]', password)
  await page.click('button[type="submit"]')
  await page.waitForFunction(() => !document.querySelector('input[type="password"]'))
  passed('normal email/password login')

  const created = await api('/api/canvases', { name: 'Design editor · Test' })
  assert.equal(created.status, 200)
  canvasId = created.data.id
  const createdFrame = await api(`/api/canvases/${canvasId}/frames`, {
    name: 'Orbit · Landing page',
    html: fixture,
    width: 880,
    height: 740,
    x: 0,
    y: 0,
  })
  assert.equal(createdFrame.status, 200)
  frameId = createdFrame.data.id
  await page.goto(`${base}/c/${canvasId}?frame=${frameId}`, { waitUntil: 'networkidle0' })
  await page.waitForSelector('[aria-label="Layer navigator"]')
  await select('#hero-title')
  await field('Font size', '60')
  await waitRendered('#hero-title', 'font-size', '60px')
  assert.equal(await rendered('#hero-title', 'font-size'), '60px')
  let stored = await api(`/api/canvases/${canvasId}`, undefined, 'GET')
  assert.match(stored.data.frames.find((frame) => frame.id === frameId).html, /font-size: 60px !important/)
  passed('typography control changes rendered pixels and persisted source')

  await historyKey('z')
  await waitRendered('#hero-title', 'font-size', '52px')
  await historyKey('y')
  await waitRendered('#hero-title', 'font-size', '60px')
  passed('undo and redo restore computed typography')

  await page.reload({ waitUntil: 'networkidle0' })
  await select('#hero-title')
  assert.equal(await rendered('#hero-title', 'font-size'), '60px')
  await page.click('[aria-label="Reset Font size"]')
  await waitSaved()
  await waitRendered('#hero-title', 'font-size', '52px')
  passed('reload retains edits; reset reveals the original stylesheet')

  await select('#hero')
  await field('Column gap', '48')
  await waitRendered('#hero', 'column-gap', '48px')
  await page.select('[aria-label="Layout"]', 'flex')
  await waitSaved()
  await page.select('[aria-label="Direction"]', 'column')
  await waitSaved()
  passed('auto layout controls write gap, display and direction')

  await select('#art')
  await field('Fill 1 direction', '90')
  await field('Fill 1 stop 2 color', '#c4d3ff')
  assert.match(await rendered('#art', 'background-image'), /90deg/)
  passed('gradient angle and color-stop controls change the rendered fill')

  await select('.orb')
  if ((await page.$eval('[aria-label="Effects"]', (button) => button.getAttribute('aria-expanded'))) === 'false')
    await page.click('[aria-label="Effects"]')
  await field('Shadow 1 blur', '42')
  assert.match(await rendered('.orb', 'box-shadow'), /42px/)
  await historyKey('z')
  await page.waitForFunction(() => document.querySelector('[aria-label="Layer name"]')?.value === 'Orb · shadows')
  await historyKey('y')
  await page.waitForFunction(() => document.querySelector('[aria-label="Layer name"]')?.value === 'Orb · shadows')
  assert.match(await rendered('.orb', 'box-shadow'), /42px/)
  passed('shadow controls preserve the stack and change the rendered blur')

  // Hold the first inline save while another snapshot is queued. Reject the
  // first request and verify that its successor uses the confirmed source.
  const interrupted = await holdNextHtmlSave()
  await page.evaluate(() => {
    window.__doopFinalInline = false
    window.__doopCaptureInline = (event) => {
      if (
        event.source === document.querySelector('iframe')?.contentWindow &&
        event.data?.type === 'doop:edited' &&
        event.data.editing === false
      )
        window.__doopFinalInline = true
    }
    window.addEventListener('message', window.__doopCaptureInline)
  })
  await clickDesignElement('#description', 2)
  await artboard().waitForSelector('style[data-v-edit]')
  await clickDesignElement('#description')
  await page.keyboard.down('Control')
  await page.keyboard.press('a')
  await page.keyboard.up('Control')
  await page.keyboard.type('Fresh inline copy.')
  const firstSave = await interrupted.held
  await page.keyboard.type(' More details.')
  await select('#art')
  await page.waitForFunction(() => window.__doopFinalInline)
  await firstSave.respond({
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'Injected first-save failure' }),
  })
  await page.waitForFunction(() =>
    document.querySelector('[aria-label="Design inspector"] footer [role="status"]')?.textContent.includes('Saved'),
  )
  await interrupted.stop()
  await page.evaluate(() => {
    window.removeEventListener('message', window.__doopCaptureInline)
    delete window.__doopCaptureInline
    delete window.__doopFinalInline
  })
  assert.equal(await page.$('[aria-label="Unsaved HTML"]'), null)
  stored = await api(`/api/canvases/${canvasId}`, undefined, 'GET')
  const inlineSource = stored.data.frames.find((frame) => frame.id === frameId).html
  assert.ok(inlineSource.includes('Fresh inline copy. More details.'))
  assert.ok(!inlineSource.includes('data-v-active'))
  assert.ok(inlineSource.includes('42px'))
  passed('switching from inline text to the inspector flushes text without losing styles')
  passed('queued inline edits recover from a rejected save without discarding the latest text')

  await page.click('[aria-label="Collapse inspector"]')
  await page.waitForSelector('[aria-label="Open inspector"]')
  await page.click('[aria-label="Open inspector"]')
  await page.click('[aria-label="Collapse layers"]')
  await page.waitForSelector('[aria-label="Open layers"]')
  await page.click('[aria-label="Open layers"]')
  await page.type('[aria-label="Search layers and assets"]', 'Headline')
  await page.waitForSelector('[role="treeitem"][aria-label="Headline"]')
  await page.click('[role="treeitem"][aria-label="Headline"]')
  assert.equal(await page.$eval('[aria-label="Layer name"]', (input) => input.value), 'Headline')
  passed('collapse/restore, nested layer search and selection')

  const sourceTests = await page.evaluate(async () => {
    const { editDesign, parseDesign, readLayers, flattenLayers, sourceElement } =
      await import('/src/lib/designDocument.ts')
    const original =
      '<!doctype html><html lang="en"><head><style>.card{color:var(--ink)}</style><script>window.boot=1</script></head><body><!--keep--><section id="container"><p id="title">Hello <b>world</b></p><img id="photo" src="a.png"><svg id="icon"><defs><linearGradient id="paint"><stop offset="0" /></linearGradient></defs><rect id="shape" fill="url(#paint)" /></svg></section></body></html>'
    const edited = editDesign(original, '#title', { type: 'style', values: { color: 'var(--ink, red)', width: '50%' } })
    const doc = parseDesign(edited.html)
    const tests = {
      sourcePreserved:
        doc.querySelector('script').textContent === 'window.boot=1' &&
        doc.querySelector('style').textContent === '.card{color:var(--ink)}' &&
        !!doc.querySelector('#title b') &&
        edited.html.includes('<!--keep-->'),
      valuesPreserved:
        doc.querySelector('#title').style.width === '50%' &&
        doc.querySelector('#title').style.color === 'var(--ink, red)',
      internalsExcluded: !flattenLayers(readLayers(doc).layers).some((layer) =>
        ['style', 'script'].includes(layer.tag),
      ),
    }
    const rejects = (fn) => {
      try {
        fn()
        return false
      } catch {
        return true
      }
    }
    tests.badCssRejected = rejects(() =>
      editDesign(original, '#title', { type: 'style', values: { color: 'definitely-not-a-color' } }),
    )
    tests.missingRejected = rejects(() => editDesign(original, '#missing', { type: 'style', values: { color: 'red' } }))
    tests.nestedTextPreserved = rejects(() => editDesign(original, '#title', { type: 'text', text: 'erase children' }))
    tests.unsafeImageRejected = rejects(() =>
      editDesign(original, '#photo', { type: 'image', src: 'javascript:alert(1)' }),
    )
    const locked = editDesign(original, '#container', { type: 'lock' })
    tests.parentLockHonored = rejects(() =>
      editDesign(locked.html, '#title', { type: 'style', values: { color: 'red' } }),
    )
    const hidden = editDesign(original, '#container', { type: 'visibility' })
    const visible = editDesign(hidden.html, '#container', { type: 'visibility' })
    tests.hideRestoresCascade = !parseDesign(visible.html).querySelector('#container').style.display
    const show = (attributes) =>
      parseDesign(
        editDesign(`<div id="visible" ${attributes}>Text</div>`, '#visible', { type: 'visibility' }).html,
      ).querySelector('#visible')
    const hiddenFlex = show('hidden style="display:flex!important;visibility:visible!important;color:red"')
    tests.showPreservesAuthoredFlex =
      !hiddenFlex.hasAttribute('hidden') &&
      hiddenFlex.style.display === 'flex' &&
      hiddenFlex.style.getPropertyPriority('display') === 'important' &&
      hiddenFlex.style.visibility === 'visible' &&
      hiddenFlex.style.getPropertyPriority('visibility') === 'important' &&
      hiddenFlex.style.color === 'red'
    const hiddenGrid = show('style="visibility:hidden!important;display:grid!important"')
    tests.showPreservesAuthoredGrid =
      hiddenGrid.style.display === 'grid' &&
      hiddenGrid.style.getPropertyPriority('display') === 'important' &&
      !hiddenGrid.style.visibility
    const hiddenDisplay = show('style="display:none!important;visibility:visible!important"')
    tests.showPreservesAuthoredVisibility =
      !hiddenDisplay.style.display &&
      hiddenDisplay.style.visibility === 'visible' &&
      hiddenDisplay.style.getPropertyPriority('visibility') === 'important'
    const allHidden = show('hidden style="display:none!important;visibility:hidden!important;color:red"')
    tests.showRemovesOnlyHidingState =
      !allHidden.hasAttribute('hidden') &&
      !allHidden.style.display &&
      !allHidden.style.visibility &&
      allHidden.style.color === 'red'
    const authored = '<div id="visible" style="display:flex!important;visibility:visible!important">Text</div>'
    const hiddenAuthored = editDesign(authored, '#visible', { type: 'visibility' })
    const restored = parseDesign(
      editDesign(hiddenAuthored.html, '#visible', { type: 'visibility' }).html,
    ).querySelector('#visible')
    tests.editorHideShowPreservesPriority =
      restored.style.display === 'flex' &&
      restored.style.getPropertyPriority('display') === 'important' &&
      restored.style.visibility === 'visible' &&
      restored.style.getPropertyPriority('visibility') === 'important'
    const copy = editDesign(original, '#icon', { type: 'duplicate' })
    const copyDoc = parseDesign(copy.html)
    const copyEl = sourceElement(copyDoc, copy.selector)
    const ids = [...copyDoc.querySelectorAll('[id]')].map((node) => node.id)
    tests.copyIdsUnique =
      new Set(ids).size === ids.length &&
      copyEl.querySelector('rect').getAttribute('fill') === `url(#${copyEl.querySelector('linearGradient').id})`
    const styledCopy = editDesign(
      '<style>.shared, #button { color: red } .shared { color: blue } @media (min-width: 1px) { #button { padding: 12px } }</style><button id="button">Test</button>',
      '#button',
      { type: 'duplicate' },
    )
    const styleDoc = parseDesign(styledCopy.html)
    const copiedRules = styleDoc.querySelector('style[data-doop-copy-styles]').textContent
    tests.copyRetainsIdStyles =
      copiedRules.includes(styledCopy.selector) && copiedRules.includes('color: red') && copiedRules.includes('@media')
    tests.copyDoesNotRestyleOtherLayers = !copiedRules.includes('.shared')
    const moved = editDesign(original, '#title', { type: 'reorder', direction: 'down' })
    tests.reorderFollowsSelection =
      parseDesign(moved.html).querySelector('#container').children[1].id === 'title' && moved.selector === '#title'
    const removed = editDesign(original, '#title', { type: 'delete' })
    tests.deleteSelectsParent = removed.selector === '#container' && !parseDesign(removed.html).querySelector('#title')
    const inserted = editDesign(original, '#container', { type: 'insert', kind: 'text' })
    tests.insertSelectsNewLayer =
      sourceElement(parseDesign(inserted.html), inserted.selector).textContent === 'Your text'
    return tests
  })
  for (const [name, ok] of Object.entries(sourceTests)) assert.equal(ok, true, name)
  passed(`${Object.keys(sourceTests).length} browser source-integrity and structural-edit cases`)

  // A second authenticated session edits between selection and commit.
  stored = await api(`/api/canvases/${canvasId}`, undefined, 'GET')
  const sourceBefore = stored.data.frames.find((frame) => frame.id === frameId).html
  const conflicting = await holdNextHtmlSave()
  await typeValue('[aria-label="Font size"]', '80')
  await page.keyboard.press('Enter')
  const staleSave = await conflicting.held
  const unsavedSource = JSON.parse(staleSave.postData()).html
  const second = await browser.newPage()
  await second.goto(`${base}/c/${canvasId}`, { waitUntil: 'networkidle0' })
  const remote = await api(
    `/api/frames/${frameId}`,
    { html: sourceBefore.replace('possibility.', 'possibilities.') },
    'PATCH',
    second,
  )
  assert.equal(remote.status, 200)
  await page.bringToFront()
  await staleSave.continue()
  await page.waitForSelector('[aria-label="Unsaved HTML"]')
  assert.equal(await page.$eval('[aria-label="Unsaved HTML"]', (input) => input.value), unsavedSource)
  assert.ok(unsavedSource.includes('80px'))
  await conflicting.stop()
  await artboard().waitForFunction(() => document.querySelector('#hero-title').textContent.includes('possibilities.'), {
    polling: 100,
  })
  const stale = await api(`/api/frames/${frameId}`, { html: sourceBefore, expectedHtml: sourceBefore }, 'PATCH')
  assert.equal(stale.status, 409)
  await second.close()
  passed('second-tab edits sync live and stale source writes are rejected')
  await page.click('[aria-label="Design inspector"] footer summary')
  await page.waitForSelector('[aria-label="Unsaved HTML"]', { visible: true })
  passed('a conflicting inspector edit leaves the latest unsaved HTML available for recovery')

  // Leave a clean, attractive fixture on the review canvas.
  await api(`/api/frames/${frameId}`, { html: fixture }, 'PATCH')
  await page.reload({ waitUntil: 'networkidle0' })
  await select('#hero-title')
  await page.click('[title="Fit all frames (Shift+1)"]')
  const exported = await page.evaluate(async (frameId) => {
    const response = await fetch(`/i/${frameId}.png?scale=1`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    return { status: response.status, signature: [...bytes.slice(0, 8)], length: bytes.length }
  }, frameId)
  assert.equal(exported.status, 200, 'frame export succeeds')
  assert.deepEqual(exported.signature, [137, 80, 78, 71, 13, 10, 26, 10])
  assert.ok(exported.length > 1000)
  passed('the edited design exports as a real PNG')
  await page.screenshot({ path: '/tmp/doop-design-desktop.png' })
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 })
  // Resizing replaces the desktop panel with a sheet. Wait on its layout
  // without retaining an element handle from the outgoing desktop tree.
  await page.waitForFunction(() => {
    const panel = document.querySelector('[aria-label="Design inspector"]')
    const rect = panel?.getBoundingClientRect()
    return rect && rect.width > 0 && rect.right <= window.innerWidth
  })
  await page.screenshot({ path: '/tmp/doop-design-mobile.png' })
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
  assert.equal(overflow, false, 'mobile page must not overflow horizontally')
  await page.click('[aria-label="Collapse inspector"]')
  await page.click('[aria-label="Open layers"]')
  await page.waitForSelector('[aria-label="Layer navigator"]')
  passed('mobile inspector and layer sheets fit the viewport')
  assert.deepEqual(errors, [])
  passed('no browser runtime errors')
  const report = { base, url: `${base}/c/${canvasId}?frame=${frameId}`, canvasId, frameId, checks }
  await writeFile('/tmp/doop-design-test.json', JSON.stringify(report, null, 2), { mode: 0o600 })
  console.log(`Test canvas: ${report.url}`)
  console.log('Test report: /tmp/doop-design-test.json')
} catch (error) {
  await page.screenshot({ path: '/tmp/doop-design-failure.png' }).catch(() => {})
  console.error(error, errors)
  process.exitCode = 1
} finally {
  await browser.close()
}
