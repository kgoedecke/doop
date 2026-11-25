import { beforeEach, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import type { AgentTask } from '../shared/types'
import { pagePerTest } from './browser'
import { canvasFrame, openCanvasPage } from './canvasPageFixture'

/* The Agents tab's Recent tasks strip shows three rows and a "Show all"
   toggle. Opened on a long history the rows scroll, and the toggle, now
   "Show less", must stay in reach however far they are scrolled: it stays
   after the rows, pinned to the strip's bottom edge. */

/** A finished status task, ended `i` minutes before the test runs. */
function finished(i: number): AgentTask {
  const at = Date.now() - i * 60_000
  return {
    id: `t${i}`,
    agentName: 'Doop',
    color: '#0177d3',
    status: `Task number ${i}`,
    startedAt: at - 30_000,
    endedAt: at,
  }
}

/** A prompt from the composer, which puts the chat under the strip. */
const chatCard: AgentTask = {
  ...finished(0),
  id: 'card',
  queuedBy: 'Tester',
  queuedByUserId: 'u',
  status: 'Make it blue',
}

const many = Array.from({ length: 40 }, (_, i) => finished(i + 1))

describe.skipIf(!findBrowserPath())('the Recent tasks toggle', () => {
  const pages = pagePerTest()
  let page: Page
  beforeEach(async () => {
    page = await pages.open()
    page.setDefaultTimeout(10_000)
    await page.setViewport({ width: 1400, height: 800 })
    await openCanvasPage(page, [canvasFrame({ id: 'board', name: 'Board', x: 0, y: 0, width: 300, height: 200 })])
  })

  const toggleSelector = 'section[aria-label="Recent tasks"] button[aria-expanded]'

  async function seed(tasks: AgentTask[]) {
    await page.evaluate((tasks) => window.canvasPageHarness.setTasks(tasks), tasks)
    await page.waitForSelector(toggleSelector)
  }

  /** Whether the toggle is the topmost thing at its own centre: on screen and not clipped. */
  const toggleReachable = () =>
    page.$eval(toggleSelector, (toggle) => {
      const box = toggle.getBoundingClientRect()
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
      return !!hit && toggle.contains(hit)
    })

  /* whichever box scrolls the rows: found by what it does, not by the markup,
     so the test reads the same over any layout of the strip */
  const scrollList = (to: 'top' | 'middle' | 'bottom') =>
    page.$eval(
      'section[aria-label="Recent tasks"]',
      (section, to) => {
        const ancestors: Element[] = []
        for (let el = section.parentElement; el; el = el.parentElement) ancestors.push(el)
        const list = [...section.querySelectorAll('*'), section, ...ancestors].find(
          (el): el is HTMLElement =>
            el instanceof HTMLElement &&
            /auto|scroll/.test(getComputedStyle(el).overflowY) &&
            el.scrollHeight > el.clientHeight,
        )
        if (!list) return { scrollTop: 0, end: 0 }
        list.dataset.testScroller = ''
        const end = list.scrollHeight - list.clientHeight
        list.scrollTop = to === 'top' ? 0 : to === 'middle' ? end / 2 : end
        return { scrollTop: list.scrollTop, end }
      },
      to,
    )

  async function clickToggle() {
    /* a click where the toggle is drawn, never scrolling it into view first */
    const box = await page.$eval(toggleSelector, (el) => el.getBoundingClientRect().toJSON())
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  }

  async function expandScrollAndCollapse() {
    expect(await toggleReachable()).toBe(true)
    await clickToggle()
    await page.waitForSelector(`${toggleSelector}[aria-expanded="true"]`)
    expect(await page.$eval(toggleSelector, (el) => el.textContent)).toContain('Show less')

    /* the history overflows the strip, so the list scrolls */
    const { end } = await scrollList('top')
    expect(end).toBeGreaterThan(0)
    for (const to of ['top', 'middle', 'bottom'] as const) {
      await scrollList(to)
      expect(await toggleReachable(), `toggle reachable with the list scrolled to the ${to}`).toBe(true)
    }

    /* collapsing from the bottom puts the three rows back at the top */
    await clickToggle()
    await page.waitForSelector(`${toggleSelector}[aria-expanded="false"]`)
    expect(await page.$eval(toggleSelector, (el) => el.textContent)).toContain('Show all')
    expect(await page.$eval('[data-test-scroller]', (list) => list.scrollTop)).toBe(0)
  }

  it('stays in reach over a long history, then collapses it', { timeout: 20_000 }, async () => {
    await seed(many)
    await expandScrollAndCollapse()
  })

  it('stays in reach above the chat, then collapses it', { timeout: 20_000 }, async () => {
    await seed([chatCard, ...many])
    /* the line between the strip and the chat is still there to drag */
    const separator = '[role="separator"][aria-label^="Drag to resize the chat"]'
    expect(await page.$(separator)).not.toBeNull()
    await expandScrollAndCollapse()

    /* squeezed to its smallest, the strip still shows the toggle, collapsed or open */
    await page.focus(separator)
    await page.keyboard.press('Home')
    expect(await toggleReachable(), 'toggle reachable with the strip at its smallest').toBe(true)
    await clickToggle()
    await page.waitForSelector(`${toggleSelector}[aria-expanded="true"]`)
    for (const to of ['top', 'bottom'] as const) {
      await scrollList(to)
      expect(await toggleReachable(), `toggle reachable in the smallest strip scrolled to the ${to}`).toBe(true)
    }
  })
})
