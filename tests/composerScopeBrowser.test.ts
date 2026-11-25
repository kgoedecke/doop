import { beforeEach, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import type { AgentTask } from '../shared/types'
import { pagePerTest } from './browser'
import { canvasFrame, openCanvasPage } from './canvasPageFixture'

const HERO = `<!doctype html><html><head><style>
  body { margin: 0; font-family: sans-serif }
  h1 { position: absolute; left: 40px; top: 40px; width: 220px; height: 40px; margin: 0 }
</style></head><body><h1>You're in.</h1></body></html>`

const FIELD = 'textarea[aria-label="Ask the Doop Agent"]'
const CHAT = 'section[aria-label="Chat with the agents"]'

/** prompts sent from the composer, enough to make the chat scroll */
const PROMPTS: AgentTask[] = Array.from({ length: 12 }, (_, i) => ({
  id: `card-${i}`,
  agentName: '',
  color: '#888',
  status: `Prompt ${i + 1}: make the ticket card a deeper colour and tighten the spacing`,
  startedAt: 1_000 + i,
  queuedBy: 'Tester',
  queuedByUserId: 'u',
}))

/* Picking an element or a frame scopes the composer's next prompt, and the
   chip that says so sits on top of the composer. Nothing in the panel may
   move for it: not the field, and not the agents' conversation above it,
   which used to jump by the chip's row on every pick and back on every
   deselect. */
describe.skipIf(!findBrowserPath())('composer scope chip', () => {
  const pages = pagePerTest()
  let page: Page
  const FRAME = { ...canvasFrame({ id: 'hero', name: 'Hero', x: 0, y: 0, width: 300, height: 200 }), html: HERO }

  beforeEach(async () => {
    page = await pages.open()
    page.setDefaultTimeout(10_000)
    await page.setViewport({ width: 1600, height: 1000 })
    await openCanvasPage(page, [FRAME])
    await page.waitForSelector(FIELD)
  })

  /** where the composer and its field sit, and how tall the composer is */
  function composer() {
    return page.$eval(FIELD, (field) => {
      const box = field.closest('form')!.parentElement!.getBoundingClientRect()
      return { top: box.top, height: box.height, fieldTop: field.getBoundingClientRect().top }
    })
  }
  /** the chat's scroll position and where each of its turns sits on screen */
  function chat() {
    return page.$eval(CHAT, (list) => ({
      scrollTop: list.scrollTop,
      turns: [...list.children].map((turn) => turn.getBoundingClientRect().top),
    }))
  }
  const chipShown = (label: string) => page.$(`[aria-label="${label}"]`).then((el) => el !== null)
  async function pickHeading() {
    const h1 = await page.$eval('[data-frame-surface]', (surface) => {
      const r = surface.getBoundingClientRect()
      const scale = r.width / (surface as HTMLElement).offsetWidth
      return { x: r.left + 150 * scale, y: r.top + 60 * scale }
    })
    await page.mouse.click(h1.x, h1.y)
    await expect.poll(() => chipShown('Remove element scope')).toBe(true)
  }

  it('keeps the composer still when an element is picked and dropped', async () => {
    const resting = await composer()
    await pickHeading()
    expect(await composer()).toEqual(resting)
    await page.click('[aria-label="Remove element scope"]')
    await expect.poll(() => chipShown('Remove element scope')).toBe(false)
    expect(await composer()).toEqual(resting)
  })

  it('keeps the composer still when a frame is picked', async () => {
    const resting = await composer()
    await page.click('[data-frame-title]')
    await expect.poll(() => chipShown('Remove frame scope')).toBe(true)
    expect(await composer()).toEqual(resting)
  })

  it('keeps the conversation still, and its last turn in view, when an element is picked', async () => {
    await page.evaluate((tasks) => window.canvasPageHarness.setTasks(tasks), PROMPTS)
    await page.waitForSelector(CHAT)
    /* read at its end, as it follows the conversation */
    await page.$eval(CHAT, (list) => (list.scrollTop = list.scrollHeight))
    const resting = await chat()
    await pickHeading()
    expect(await chat()).toEqual(resting)
    /* the chip's row covers only the strip the chat keeps clear at its end */
    const { lastTurnBottom, chipRowTop } = await page.$eval(CHAT, (list) => ({
      lastTurnBottom: list.lastElementChild!.getBoundingClientRect().bottom,
      chipRowTop: document
        .querySelector('[aria-label="Remove element scope"]')!
        .parentElement!.parentElement!.getBoundingClientRect().top,
    }))
    expect(lastTurnBottom).toBeLessThanOrEqual(chipRowTop)
  })

  it('keeps the conversation still when it is scrolled back and an element is picked', async () => {
    await page.evaluate((tasks) => window.canvasPageHarness.setTasks(tasks), PROMPTS)
    await page.waitForSelector(CHAT)
    await page.$eval(CHAT, (list) => (list.scrollTop = list.scrollHeight - list.clientHeight - 150))
    const resting = await chat()
    await pickHeading()
    expect(await chat()).toEqual(resting)
  })
})
