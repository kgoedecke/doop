import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { fixtureUrl, openBrowser, type TestBrowser } from './browser'
import type { ElementComment, Frame } from '../shared/types'

declare global {
  interface Window {
    commentPositionStore: typeof import('../src/lib/store').useStore
  }
}

const html = (left: number) =>
  `<body style="margin:0"><div data-doop-id="aaaaaa" style="position:absolute;left:${left}px;top:50px;width:200px;height:100px;background:#ddd">Target</div></body>`
const frame: Frame = {
  id: 'f',
  canvasId: 'c',
  name: 'Comments',
  x: 40,
  y: 60,
  width: 600,
  height: 500,
  html: html(100),
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'Tester',
}
const comment: ElementComment = {
  id: 'comment',
  canvasId: 'c',
  frameId: 'f',
  elementId: 'aaaaaa',
  snippet: '',
  text: 'Here',
  from: 'Tester',
  at: 0,
  x: 145,
  y: 87,
  elementOrigin: { x: 100, y: 50 },
}

describe.skipIf(!findBrowserPath())('element comment pin placement', () => {
  let browser: TestBrowser
  let page: Page
  const errors: string[] = []

  beforeAll(async () => {
    browser = await openBrowser()
    page = await browser.newPage()
    page.on('pageerror', (error) => errors.push(String(error)))
    await page.goto(fixtureUrl('elementPanel.html'))
    await page.addScriptTag({
      type: 'module',
      content: "import { useStore } from '/src/lib/store.ts'; window.commentPositionStore = useStore",
    })
    await page.waitForFunction(() => !!window.commentPositionStore)
    await page.evaluate(
      ({ frame, comment }) => {
        const useStore = window.commentPositionStore
        useStore.getState().setCanvas({ id: 'c', name: 'Comments', frames: [frame], createdAt: 0, updatedAt: 0 })
        useStore.setState({ comments: [comment] })
      },
      { frame, comment },
    )
    await page.waitForSelector('[title="Tester: Here"]')
  }, 60_000)

  afterAll(async () => {
    await page?.close()
    await browser?.close()
    expect(errors).toEqual([])
  })

  const position = () =>
    page.$eval('[title="Tester: Here"]', (el) => {
      const style = (el as HTMLElement).style
      return { x: parseFloat(style.left), y: parseFloat(style.top) }
    })

  it('renders the saved point, follows frame movement, and falls back when the element moves', async () => {
    expect(await position()).toEqual({ x: 145, y: 87 })
    await page.evaluate(
      (frame) => {
        const useStore = window.commentPositionStore
        useStore.getState().setCanvas({ ...useStore.getState().canvas!, frames: [frame] })
      },
      { ...frame, x: 80, y: 90 },
    )
    expect(await position()).toEqual({ x: 145, y: 87 })
    await page.evaluate(
      (frame) => {
        const useStore = window.commentPositionStore
        useStore.getState().setCanvas({ ...useStore.getState().canvas!, frames: [frame] })
      },
      { ...frame, html: html(110), updatedAt: 1 },
    )
    await expect.poll(position).toEqual({ x: 110, y: 50 })
  })
})
