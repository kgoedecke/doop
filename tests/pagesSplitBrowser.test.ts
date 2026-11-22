import type { Page } from 'puppeteer-core'
import { beforeEach, describe, expect, it } from 'vitest'
import { findBrowserPath } from '../server/screenshot'
import { LAYERS_MIN_PX, PAGES_BASE_MIN_PX, PAGES_MOVE_PICKER_PX, pagesMinPx } from '../src/lib/pagesSplit'
import { pagePerTest } from './browser'
import { canvasFrame, openCanvasPage, showCanvasPage } from './canvasPageFixture'

/* enough pages to outgrow both the Pages list's 30vh default and the largest split an 800px window allows */
const PAGES = Array.from({ length: 30 }, (_, i) => ({ id: `p${i + 1}`, name: `Page ${i + 1}` }))
const FRAMES = [canvasFrame({ id: 'f1', name: 'Home', x: 0, y: 0, width: 100, height: 100 })]
const FRAME_ROW = '[role="treeitem"][data-row-key="f1"]'
const MOVE_PICKER = '[data-slot="pages-panel"] [data-slot="select-trigger"]'

/** the separator reports whole pixels, so it may differ from the laid-out size by one */
const withinPx = (reported: number, laidOut: number) => expect(Math.abs(reported - laidOut)).toBeLessThanOrEqual(1)

describe.skipIf(!findBrowserPath())('the Pages and Layers split', () => {
  const pages = pagePerTest()
  let page: Page

  beforeEach(async () => {
    page = await pages.open()
    await page.setViewport({ width: 1280, height: 800 })
    await openCanvasPage(page, FRAMES, '', { pages: PAGES })
  })

  /** the Pages section, the Layers tree and the rail they share, in px */
  const sizes = () =>
    page.evaluate(() => {
      const pagesEl = document.querySelector<HTMLElement>('[data-slot="pages-panel"]')!
      const rail = pagesEl.closest<HTMLElement>('[data-slot="panel"]')!
      const tree = rail.querySelector<HTMLElement>('[role="tree"]')!
      return {
        pages: pagesEl.getBoundingClientRect().height,
        tree: tree.getBoundingClientRect().height,
        rail: rail.getBoundingClientRect().height,
      }
    })

  /** what the separator reports */
  const separator = () =>
    page.evaluate(() => {
      const el = document.querySelector('[data-slot="pages-split"]')!
      const value = (name: string) => Number(el.getAttribute(name))
      return { now: value('aria-valuenow'), min: value('aria-valuemin'), max: value('aria-valuemax') }
    })

  /** the separator's values once they have caught up with the layout on screen */
  async function liveSeparator() {
    await page.waitForFunction(
      (layersMin) => {
        const el = document.querySelector('[data-slot="pages-split"]')!
        const pagesEl = document.querySelector('[data-slot="pages-panel"]')!
        const rail = pagesEl.closest('[data-slot="panel"]')!
        return (
          Math.abs(Number(el.getAttribute('aria-valuenow')) - pagesEl.getBoundingClientRect().height) <= 1 &&
          Math.abs(Number(el.getAttribute('aria-valuemax')) - (rail.getBoundingClientRect().height - layersMin)) <= 1
        )
      },
      {},
      LAYERS_MIN_PX,
    )
    return separator()
  }

  const focusSplit = async () => (await page.$('[data-slot="pages-split"]'))!.focus()

  /** press the split and drag it `dy` px, in steps the way a hand moves */
  async function dragSplit(dy: number) {
    const box = await (await page.$('[data-slot="pages-split"]'))!.boundingBox()
    const x = box!.x + box!.width / 2
    const y = box!.y + box!.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x, y + dy, { steps: 8 })
    await page.mouse.up()
    /* React renders a pointermove's update in a later task, not during the
       event: let the last step land before anything measures it */
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  }

  /** Leave a large split on the current canvas, then open a different canvas. */
  async function openAnotherCanvas(frames: typeof FRAMES, canvas: Parameters<typeof showCanvasPage>[3]) {
    await focusSplit()
    await page.keyboard.press('End')
    await showCanvasPage(
      page,
      frames.map((frame) => ({ ...frame, canvasId: 'small' })),
      '?fixtureCanvasId=small',
      canvas,
    )
  }

  /** the edges of a section's parts, for what must stay inside it */
  const fit = () =>
    page.evaluate((pickerSelector) => {
      const edges = (el: Element | null) => {
        if (!el) return null
        const { top, bottom, height } = el.getBoundingClientRect()
        return { top, bottom, height }
      }
      const pagesEl = document.querySelector('[data-slot="pages-panel"]')!
      const rows = [...pagesEl.querySelectorAll('[data-page-id]')]
      return {
        pages: edges(pagesEl)!,
        list: edges(rows[0]!.parentElement)!,
        firstRow: edges(rows[0]!)!,
        lastRow: edges(rows.at(-1)!)!,
        picker: edges(pagesEl.querySelector(pickerSelector)),
      }
    }, MOVE_PICKER)

  it('dragging the split up gives the Layers tree the room the Pages list gives up', async () => {
    const before = await sizes()
    await dragSplit(-120)
    const after = await sizes()
    expect(before.pages - after.pages).toBeCloseTo(120, 0)
    expect(after.tree - before.tree).toBeCloseTo(120, 0)
  })

  it('stops the split where the Layers tree keeps its minimum room', async () => {
    await dragSplit(2000)
    const { pages: pagesPx, rail } = await sizes()
    expect(pagesPx).toBeCloseTo(rail - LAYERS_MIN_PX, 0)
  })

  it('moves the split 10px an arrow press, and Home and End take it to its limits', async () => {
    const start = await sizes()
    await focusSplit()
    await page.keyboard.press('ArrowUp')
    expect((await sizes()).pages).toBeCloseTo(start.pages - 10, 0)
    await page.keyboard.press('Home')
    expect((await sizes()).pages).toBeCloseTo(pagesMinPx(false), 0)
    await page.keyboard.press('End')
    const end = await sizes()
    expect(end.pages).toBeCloseTo(end.rail - LAYERS_MIN_PX, 0)
  })

  it('keeps the split when the page loads again', async () => {
    await dragSplit(-120)
    const dragged = await sizes()
    await showCanvasPage(page, FRAMES, '', { pages: PAGES })
    expect((await sizes()).pages).toBeCloseTo(dragged.pages, 0)
  })

  it('drags past the last page row and still leaves a visible Layers row at the bottom', async () => {
    await showCanvasPage(page, FRAMES, '', { pages: PAGES.slice(0, 12) })
    const before = await fit()
    await dragSplit(500)
    const after = await sizes()
    expect(after.pages).toBeGreaterThanOrEqual(after.rail - 150)
    expect((await fit()).pages.bottom - before.lastRow.bottom).toBeGreaterThan(100)
    const rowVisible = await page.$eval(FRAME_ROW, (row) => {
      const tree = row.closest('[role="tree"]')!
      return row.getBoundingClientRect().bottom <= tree.getBoundingClientRect().bottom
    })
    expect(rowVisible).toBe(true)
    await showCanvasPage(page, FRAMES, '', { pages: PAGES.slice(0, 12) })
    expect((await sizes()).pages).toBeCloseTo(after.pages, 0)
  })

  it('reports where the split is and the range it can move in, as the keys, a drag and the window move it', async () => {
    const start = await liveSeparator()
    expect(start.min).toBe(pagesMinPx(false))
    const layout = await sizes()
    withinPx(start.now, layout.pages)
    withinPx(start.max, layout.rail - LAYERS_MIN_PX)

    await focusSplit()
    await page.keyboard.press('ArrowUp')
    withinPx((await liveSeparator()).now, start.now - 10)
    await page.keyboard.press('Home')
    expect((await liveSeparator()).now).toBe(start.min)
    await page.keyboard.press('End')
    withinPx((await liveSeparator()).now, start.max)

    await dragSplit(-120)
    const dragged = await liveSeparator()
    withinPx(dragged.now, start.max - 120)

    await page.setViewport({ width: 1280, height: 600 })
    const shrunk = await liveSeparator()
    const shrunkLayout = await sizes()
    expect(shrunk.max).toBeLessThan(start.max)
    withinPx(shrunk.now, shrunkLayout.pages)
    expect(shrunk.now).toBeLessThanOrEqual(shrunk.max + 1)
    expect(shrunk.now).toBeGreaterThanOrEqual(shrunk.min)
  })

  it('keeps one page row and the move picker inside the Pages section while a frame is selected', async () => {
    await focusSplit()
    await page.keyboard.press('Home')
    const bare = await liveSeparator()
    expect(bare.min).toBe(pagesMinPx(false))
    const unselected = await fit()
    expect(unselected.picker).toBeNull()
    expect(unselected.pages.height).toBeCloseTo(pagesMinPx(false), 0)
    expect(unselected.firstRow.bottom).toBeLessThanOrEqual(unselected.list.bottom + 0.5)

    await page.click(FRAME_ROW)
    await page.waitForSelector(MOVE_PICKER)
    const selected = await liveSeparator()
    expect(selected.min).toBe(pagesMinPx(true))
    withinPx(selected.now, pagesMinPx(true))
    const withPicker = await fit()
    expect(withPicker.pages.height).toBeCloseTo(pagesMinPx(true), 0)
    expect(withPicker.firstRow.bottom).toBeLessThanOrEqual(withPicker.list.bottom + 0.5)
    expect(withPicker.picker!.bottom).toBeLessThanOrEqual(withPicker.pages.bottom + 0.5)
  })

  describe('on another canvas after a large split was saved', () => {
    /** the divider as the section draws it, the panel's own outline color, and the room under it */
    const divider = () =>
      page.evaluate(() => {
        const pagesEl = document.querySelector<HTMLElement>('[data-slot="pages-panel"]')!
        const rail = pagesEl.closest<HTMLElement>('[data-slot="panel"]')!
        const probe = document.createElement('div')
        probe.className = 'border-t border-line-soft'
        document.body.append(probe)
        const panelOutline = getComputedStyle(probe).borderTopColor
        probe.remove()
        const style = getComputedStyle(pagesEl)
        const layersHeading = document.querySelector('[data-slot="frame-section-heading"]')!.parentElement!
        return {
          width: pagesEl.getBoundingClientRect().width,
          railWidth: rail.clientWidth,
          thickness: style.borderBottomWidth,
          line: style.borderBottomStyle,
          color: style.borderBottomColor,
          panelOutline,
          gapToLayers: layersHeading.getBoundingClientRect().top - pagesEl.getBoundingClientRect().bottom,
        }
      })

    it('sizes a single page to its row on an empty canvas, with a full-width divider in the panel outline color', async () => {
      await openAnotherCanvas([], { pages: [PAGES[0]!] })
      const section = await fit()
      /* the list's bottom padding and the divider are all that is left under the row */
      expect(section.pages.bottom - section.firstRow.bottom).toBeLessThanOrEqual(6)
      expect(section.pages.height).toBeCloseTo(PAGES_BASE_MIN_PX, 0)
      const sep = await liveSeparator()
      expect(sep.now).toBe(sep.min)
      expect(sep.max).toBeGreaterThan(sep.min)

      const line = await divider()
      expect(line.thickness).toBe('1px')
      expect(line.line).toBe('solid')
      expect(line.color).toBe(line.panelOutline)
      expect(line.width).toBeCloseTo(line.railWidth, 0)
      expect(line.gapToLayers).toBeLessThanOrEqual(8)
    })

    it('grows by the move picker while a frame is selected, keeping the row and the picker inside', async () => {
      await openAnotherCanvas(FRAMES, { pages: PAGES.slice(0, 2) })
      const before = await fit()
      expect(before.picker).toBeNull()
      expect(before.pages.bottom - before.lastRow.bottom).toBeLessThanOrEqual(6)

      await page.click(FRAME_ROW)
      await page.waitForSelector(MOVE_PICKER)
      const after = await fit()
      expect(after.pages.height - before.pages.height).toBeCloseTo(PAGES_MOVE_PICKER_PX, 0)
      expect(after.lastRow.bottom).toBeLessThanOrEqual(after.list.bottom + 0.5)
      expect(after.picker!.bottom).toBeLessThanOrEqual(after.pages.bottom + 0.5)
      const sep = await liveSeparator()
      expect(sep.min).toBe(pagesMinPx(true))
      withinPx(sep.now, after.pages.height)
    })

    it('keeps the divider and the resize for a viewer, who gets no move picker', async () => {
      await showCanvasPage(page, FRAMES, '', { pages: PAGES, role: 'view' })
      await page.click(FRAME_ROW)
      await page.waitForSelector(`${FRAME_ROW}[aria-selected="true"]`)
      expect(await page.$(MOVE_PICKER)).toBeNull()
      expect((await divider()).thickness).toBe('1px')
      await focusSplit()
      await page.keyboard.press('Home')
      const sep = await liveSeparator()
      expect(sep.min).toBe(pagesMinPx(false))
      expect(sep.now).toBe(pagesMinPx(false))
    })
  })
})
