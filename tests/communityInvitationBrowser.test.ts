import type { Page } from 'puppeteer-core'
import { beforeEach, describe, expect, it } from 'vitest'
import { findBrowserPath } from '../server/screenshot'
import type { AgentTask, Canvas, Frame, ServerMessage } from '../shared/types'
import { fixtureUrl, pagePerTest } from './browser'

declare global {
  interface Window {
    invitationSocket: { onmessage?: (event: MessageEvent) => void }
  }
}

const owner = { id: 'owner', name: 'Example Designer', email: 'owner@example.test' }
const canvas: Canvas = { id: 'c', ownerId: owner.id, name: 'Sample canvas', frames: [], createdAt: 10, updatedAt: 10 }
const frame: Frame = {
  id: 'sample',
  canvasId: canvas.id,
  name: 'Sample frame',
  x: 20,
  y: 20,
  width: 480,
  height: 360,
  html: '<h1>Example design</h1>',
  createdAt: 30,
  updatedAt: 30,
  updatedBy: 'Doop',
}
const card: AgentTask = {
  id: 'generation',
  agentName: 'Doop',
  color: '#808080',
  status: 'Generate a new design',
  startedAt: 20,
  queuedBy: owner.name,
  queuedByUserId: owner.id,
  frameIds: [frame.id],
}
const invitation = '[data-slot="community-invitation"]'

describe.skipIf(!findBrowserPath())('community invitation', () => {
  const pages = pagePerTest()
  let page: Page
  let appUrl: URL
  let publishRequests: string[]
  let beforePublishResponse: (() => Promise<void>) | undefined

  beforeEach(async () => {
    page = await pages.open()
    publishRequests = []
    beforePublishResponse = undefined
    await page.setViewport({ width: 1280, height: 850 })
    await page.evaluateOnNewDocument(() => {
      if (window !== window.top) return
      history.replaceState(null, '', '/c/c')
      Object.defineProperty(window, 'WebSocket', {
        value: class {
          static OPEN = 1
          readyState = 1
          onopen?: () => void
          onmessage?: (event: MessageEvent) => void

          constructor() {
            window.invitationSocket = this
            queueMicrotask(() => this.onopen?.())
          }

          close() {}
          send() {}
        },
      })
    })
    appUrl = new URL('/index.html', fixtureUrl('placeholder'))
    await page.setRequestInterception(true)
    page.on('request', async (request) => {
      const requestUrl = new URL(request.url())
      if (requestUrl.origin !== appUrl.origin) return request.abort()
      const { pathname } = requestUrl
      if (!pathname.startsWith('/api/')) return request.continue()
      let body: unknown = {}
      if (pathname === '/api/auth/get-session') body = { user: owner, session: { id: 'test-session' } }
      if (pathname === '/api/canvases/c/fonts' || pathname === '/api/canvases/c/members') body = []
      if (pathname === '/api/workspaces') body = { workspaces: [] }
      if (pathname === '/api/canvases/c/publish') {
        publishRequests.push(request.method())
        await beforePublishResponse?.()
        body = { publishedAt: 41, category: 'website' }
      }
      await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    })
    await page.goto(appUrl.href)
    await page.waitForFunction(() => !!window.invitationSocket?.onmessage)
    await page.evaluate(() => localStorage.clear())
  })

  async function send(message: ServerMessage) {
    await page.evaluate((message) => {
      window.invitationSocket.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) }))
    }, message)
  }

  async function init(listing: Partial<Canvas> = {}, tasks: AgentTask[] = []) {
    await send({
      type: 'init',
      canvas: { ...canvas, frames: [frame], ...listing },
      presences: [],
      activity: [],
      tasks,
      feedback: [],
      comments: [],
      decisions: [],
      proposals: [],
      selfColor: '#808080',
      serverBuild: 'dev',
    })
    await page.waitForFunction(() => document.body.textContent?.includes('Sample canvas'))
  }

  async function complete(id: string) {
    await send({ type: 'task', task: { ...card, id } })
    await send({ type: 'task', task: { ...card, id, endedAt: 40 } })
    await send({ type: 'canvas:design-generated', frameIds: [frame.id] })
  }

  const reviews = () => page.locator('::-p-aria(Review sharing)')
  const gallery = () => page.locator('::-p-text(Show in the community gallery)')
  const publishButton = () => page.locator('::-p-aria(Publish canvas)')
  const visibleInvitation = () =>
    page.$eval('body', (el) => el.textContent?.includes('Share this design with the community?'))

  it('only offers for live success and only publishes after the separate Share confirmation', async () => {
    await init({}, [{ ...card, id: 'old', endedAt: 40 }])
    await send({ type: 'task', task: { ...card, id: 'failed' } })
    await send({ type: 'task', task: { ...card, id: 'failed', failedAt: 40 } })
    const edit = { ...card, id: 'marked-done-manually' }
    await send({ type: 'task', task: edit })
    await send({ type: 'task', task: { ...edit, endedAt: 40 } })
    const collaborator = { ...card, id: 'collaborator-generation', queuedByUserId: 'collaborator' }
    await send({ type: 'task', task: collaborator })
    await send({ type: 'task', task: { ...collaborator, endedAt: 40 } })
    expect(await visibleInvitation()).toBe(false)

    await complete(card.id)
    await reviews().wait()
    expect(await page.$eval(invitation, (el) => el.contains(document.activeElement))).toBe(false)
    await send({ type: 'task', task: { ...card, endedAt: 40 } })
    await send({ type: 'canvas:design-generated', frameIds: [frame.id] })
    expect(
      await page.$$eval(
        'h2',
        (titles) => titles.filter((el) => el.textContent?.startsWith('Share this design')).length,
      ),
    ).toBe(1)
    expect(publishRequests).toEqual([])

    await reviews().click()
    await gallery().wait()
    expect(publishRequests).toEqual([])
    await gallery().click()
    await publishButton().wait()
    expect(publishRequests).toEqual([])
    await page.locator('::-p-aria(Cancel)').click()
    expect(publishRequests).toEqual([])
    expect(await page.$('::-p-aria(Publish canvas)')).toBeNull()

    await gallery().click()
    await publishButton().click()
    await expect.poll(() => publishRequests).toEqual(['PUT'])
    await page.waitForSelector('::-p-aria(Publish canvas)', { hidden: true })
    await page.keyboard.press('Escape')
    await complete('after-publishing')
    expect(await visibleInvitation()).toBe(false)
    expect(publishRequests).toEqual(['PUT'])
  }, 30_000)

  it('persists dismissal across reload and suppresses new invitations after opting out', async () => {
    await init()
    await complete('first')
    await page.locator('::-p-aria(Not now)').click()
    expect(await visibleInvitation()).toBe(false)

    await page.goto(appUrl.href)
    await page.waitForFunction(() => !!window.invitationSocket?.onmessage)
    await init()
    await complete('within-cooldown')
    expect(await visibleInvitation()).toBe(false)

    await page.evaluate(() => localStorage.setItem('doop:community-invitation:owner', '1'))
    await complete('after-cooldown')
    await page.locator('::-p-aria(Don’t ask again)').click()
    await page.goto(appUrl.href)
    await page.waitForFunction(() => !!window.invitationSocket?.onmessage)
    await init()
    await complete('after-opt-out')
    expect(await visibleInvitation()).toBe(false)
    expect(publishRequests).toEqual([])
  }, 30_000)

  it('ignores existing listings and dismisses an invitation if another tab publishes', async () => {
    await init({ publishedAt: 12 })
    await complete('published')
    expect(await visibleInvitation()).toBe(false)

    await send({ type: 'canvas:listing', listing: {} })
    await complete('eligible')
    await reviews().wait()
    await send({ type: 'canvas:listing', listing: { publishedAt: 44 } })
    await page.waitForSelector('::-p-aria(Review sharing)', { hidden: true })
    await complete('published-remotely')
    expect(await visibleInvitation()).toBe(false)
    expect(publishRequests).toEqual([])
  }, 30_000)

  it('keeps a newer listing event when an older unpublish response arrives later', async () => {
    await init({ publishedAt: 12 })
    await page.locator('::-p-aria(Share)').click()
    await gallery().wait()
    beforePublishResponse = () => send({ type: 'canvas:listing', listing: { publishedAt: 44 } })
    await gallery().click()
    await expect.poll(() => publishRequests).toEqual(['DELETE'])
    await page.waitForFunction(() => {
      const checkbox = document.querySelector<HTMLInputElement>('[data-slot="checkbox"]')
      return checkbox?.checked && !checkbox.disabled
    })
    await page.keyboard.press('Escape')
    await complete('after-listing-event')
    expect(await visibleInvitation()).toBe(false)
    expect(publishRequests).toEqual(['DELETE'])
  }, 30_000)

  it('preserves a draft description and refreshes the untouched shelf after a remote edit', async () => {
    await init({ publishedAt: 12, description: 'Original description', category: 'website' })
    await page.locator('::-p-aria(Share)').click()
    const description = '[data-slot="modal"] textarea'
    await page.waitForFunction(
      (selector) => document.querySelector<HTMLTextAreaElement>(selector)?.value === 'Original description',
      {},
      description,
    )
    await page.locator(description).fill('My unfinished description')
    await send({
      type: 'canvas:listing',
      listing: { publishedAt: 12, description: 'Remote description', category: 'dashboard' },
    })
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[data-slot="toggle-chip"][data-state="on"]')].some(
        (el) => el.textContent === 'Dashboards',
      ),
    )
    expect(await page.$eval(description, (el) => (el as HTMLTextAreaElement).value)).toBe('My unfinished description')
    expect(publishRequests).toEqual([])
  }, 30_000)
})
