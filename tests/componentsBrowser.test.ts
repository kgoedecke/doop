import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { createServer, type ViteDevServer } from 'vite'
import { findBrowserPath } from '../server/screenshot'
import { fixtureServerConfig, openBrowser, type TestBrowser } from './browser'
import { freePort, startServer, type Server } from './harness'

/* The whole loop in the real editor, over the real server: make a component
   from the Layers menu, place it from the panel, change an instance from the
   Design panel, watch a main's change arrive in the live iframe, undo, detach. */

const SHOTS = process.env.COMPONENT_SHOTS

describe.skipIf(!findBrowserPath())('components in the editor', { timeout: 60_000 }, () => {
  let vite: ViteDevServer
  let server: Server
  let browser: TestBrowser
  let page: Page
  let canvasId: string
  let frameId: string

  const canvas = () =>
    page.evaluate(
      async (id) =>
        (await (await fetch(`/api/canvases/${id}`)).json()) as {
          components?: { id: string; name: string; rev: number }[]
          frames: { id: string; html: string }[]
        },
      canvasId,
    )
  const frameHtml = async () => (await canvas()).frames.find((frame) => frame.id === frameId)!.html

  async function clickByText(text: string, scope = 'body') {
    await page.waitForFunction(
      (t, s) =>
        [...document.querySelector(s)!.querySelectorAll('button,[role="menuitem"],[role="radio"]')].some((el) =>
          el.textContent?.trim().startsWith(t),
        ),
      {},
      text,
      scope,
    )
    await page.evaluate(
      (t, s) => {
        const el = [
          ...document.querySelector(s)!.querySelectorAll<HTMLElement>('button,[role="menuitem"],[role="radio"]'),
        ].find((candidate) => candidate.textContent?.trim().startsWith(t))!
        el.click()
      },
      text,
      scope,
    )
  }

  /* the Layers panel's faces are Radix tabs, which switch on a real pointer press */
  async function switchTab(label: string) {
    const tabs = await page.$$('[data-slot="panel-icon-tab"]')
    for (const tab of tabs) {
      const text = await tab.evaluate((el) => el.textContent?.trim() ?? '')
      if (text === label) {
        await tab.click()
        return
      }
    }
    throw new Error(`no ${label} tab`)
  }

  async function shortcut(key: string, shift = false) {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.down('Meta')
    if (shift) await page.keyboard.down('Shift')
    await page.keyboard.press(key as never)
    if (shift) await page.keyboard.up('Shift')
    await page.keyboard.up('Meta')
  }

  async function until(check: () => Promise<boolean>, label: string) {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if (await check()) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`timed out waiting for ${label}`)
  }

  beforeAll(async () => {
    const port = await freePort()
    vite = await createServer(
      fixtureServerConfig({
        proxy: {
          '/api': { target: `http://localhost:${port}` },
          '/ws': { target: `ws://localhost:${port}`, ws: true },
          '/i': { target: `http://localhost:${port}` },
        },
      }),
    )
    await vite.listen()
    const origin = vite.resolvedUrls!.local[0]!.replace(/\/$/, '')
    server = await startServer({ PORT: String(port), BETTER_AUTH_URL: origin })
    browser = await openBrowser()
    page = await browser.newPage()
    page.setDefaultTimeout(10_000)
    await page.setViewport({ width: 1400, height: 900 })
    await page.goto(origin)
    const seeded = await page.evaluate(async () => {
      const signup = await fetch('/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Designer', email: 'components@test.dev', password: 'password12345' }),
      })
      if (!signup.ok) throw new Error(await signup.text())
      /* a fresh account is asked the onboarding questions over its first page,
         and that modal's overlay would take the clicks meant for the canvas */
      await fetch('/api/me/onboarding', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: null, intent: null }),
      })
      const made = await (
        await fetch('/api/canvases', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Components' }),
        })
      ).json()
      const frame = await (
        await fetch(`/api/canvases/${made.id}/frames`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Screen',
            x: 100,
            y: 100,
            width: 420,
            height: 320,
            html: `<!doctype html><html><head><style>.pill{display:inline-block;padding:8px 14px;border-radius:99px;background:#111;color:#fff;font:14px sans-serif}.pill[data-tone="ghost"]{background:#eee;color:#111}</style></head><body style="margin:20px"><button class="pill"><span class="pill-label">Buy now</span></button></body></html>`,
          }),
        })
      ).json()
      return { canvasId: made.id as string, frameId: frame.id as string }
    })
    canvasId = seeded.canvasId
    frameId = seeded.frameId
    await page.goto(`${origin}/c/${canvasId}`)
    await page.waitForSelector('[data-slot="frame-section-heading"]')
  }, 60_000)

  afterAll(async () => {
    await page?.close()
    await browser?.close()
    await vite?.close()
    server?.stop()
  })

  it('makes a component from the layers menu', async () => {
    /* select the frame and open its row, then right-click the button's */
    await page.waitForSelector(`[data-row-key="${frameId}"]`, { timeout: 10_000 }).catch(() => undefined)
    await page.evaluate((id) => {
      const row = document.querySelector<HTMLElement>(`[data-row-key="${id}"]`)
      row?.click()
    }, frameId)
    const rowSelector = `[data-row-key^="${frameId}|"]`
    await page.waitForSelector(rowSelector)
    const row = await page.$(rowSelector)
    await row!.click({ button: 'right' })
    await clickByText('Create component')
    await until(async () => ((await canvas()).components?.length ?? 0) === 1, 'the component')
    const made = (await canvas()).components![0]!
    expect(made.name).toBe('Pill')
    expect(await frameHtml()).toContain(`data-doop-component="${made.id}"`)

    /* undo takes back this step, not whatever came before it, and redo links the main again */
    await shortcut('z')
    await until(async () => !(await frameHtml()).includes('data-doop-component='), 'undo of the create')
    await shortcut('z', true)
    await until(async () => (await frameHtml()).includes(`data-doop-component="${made.id}"`), 'redo of the create')
  })

  it('lists it in the panel with a preview, and places it into the selected frame', async () => {
    await switchTab('Components')
    await page.waitForSelector('[data-component-card="Pill"] iframe')
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/panel.png` })
    /* a click on the card places nothing; its menu does */
    await page.click('[data-component-card="Pill"] iframe')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(await frameHtml()).not.toContain(' data-doop-instance=')
    await page.click('[data-component-card="Pill"] [data-component-menu]')
    await clickByText('Insert instance')
    await until(async () => (await frameHtml()).includes(' data-doop-instance='), 'the instance')
    expect(await frameHtml()).toContain('Buy now')
  })

  it('edits an instance from the design panel, and undo takes it back', async () => {
    await switchTab('Layers')
    const instance = await page.evaluateHandle((id) => {
      const rows = [...document.querySelectorAll<HTMLElement>(`[data-row-key^="${id}|"]`)]
      return rows.find((row) => row.querySelector('.text-brand.opacity-70')) ?? null
    }, frameId)
    await (instance.asElement() as unknown as { click(): Promise<void> }).click()
    await page.waitForSelector('[data-slot="component-section"]')
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/instance.png` })
    const field = await page.waitForSelector('[data-slot="component-section"] input')
    await field!.click({ count: 3 })
    await field!.type('Sign up')
    await page.keyboard.press('Enter')
    await until(async () => (await frameHtml()).includes('Sign up'), 'the prop to save')
    expect(await frameHtml()).toMatch(/data-doop-props="[^"]*Sign up/)

    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await shortcut('z')
    await until(async () => !(await frameHtml()).includes('Sign up'), 'undo')
  })

  it('takes no instance edits while the frame is locked', async () => {
    const setLocked = (locked: boolean) =>
      page.evaluate(
        async (id, value) => {
          const res = await fetch(`/api/frames/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ locked: value }),
          })
          if (!res.ok) throw new Error(await res.text())
        },
        frameId,
        locked,
      )
    const disabled = () =>
      page.evaluate(() => document.querySelector<HTMLInputElement>('[data-slot="component-section"] input')?.disabled)
    await setLocked(true)
    await until(async () => (await disabled()) === true, 'the fields to lock')
    await setLocked(false)
    await until(async () => (await disabled()) === false, 'the fields to unlock')
  })

  it('carries a main’s change into the instance live, and detach cuts only that link', async () => {
    const { components } = await canvas()
    await page.evaluate(
      async (id, component) => {
        const res = await fetch(`/api/canvases/${id}/components/${component}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ find: 'class="pill"', replace: 'class="pill live-update"' }),
        })
        if (!res.ok) throw new Error(await res.text())
      },
      canvasId,
      components![0]!.id,
    )
    await until(async () => {
      const frames = page.frames()
      for (const frame of frames) {
        const count = await frame
          .evaluate(() => document.querySelectorAll('[data-doop-instance].live-update').length)
          .catch(() => 0)
        if (count > 0) return true
      }
      return false
    }, 'the live iframe to update')

    /* detach lives in the element's context menu, here from its Layers row */
    const instanceRow = await page.evaluateHandle((id) => {
      const rows = [...document.querySelectorAll<HTMLElement>(`[data-row-key^="${id}|"]`)]
      return rows.find((row) => row.querySelector('.text-brand.opacity-70')) ?? null
    }, frameId)
    await (instanceRow.asElement() as unknown as { click(o: { button: string }): Promise<void> }).click({
      button: 'right',
    })
    await clickByText('Detach instance')
    await until(async () => !(await frameHtml()).includes(' data-doop-instance='), 'the detach')
    const html = await frameHtml()
    expect(html).toContain(' data-doop-component=')
    expect(html.match(/live-update/g)!.length).toBeGreaterThanOrEqual(2)

    /* cut loose, it still wears the component's styles: a ghost-free dark pill on the page */
    await until(async () => {
      for (const frame of page.frames()) {
        const background = await frame
          .evaluate(() => {
            const el = document.querySelector('[data-doop-detached-from]')
            return el ? getComputedStyle(el).backgroundColor : null
          })
          .catch(() => null)
        if (background === 'rgb(17, 17, 17)') return true
      }
      return false
    }, 'the detached instance to keep its look')
  })

  it('renames a component from the panel menu, and Escape keeps the old name', async () => {
    const name = async () => (await canvas()).components![0]!.name
    const field = '[data-component-card] input[aria-label="Component name"]'
    await switchTab('Components')
    await page.waitForSelector('[data-component-card="Pill"]')

    /* Escape leaves the name alone */
    await page.click('[data-component-card="Pill"] [data-component-menu]')
    await clickByText('Rename')
    await page.waitForSelector(field)
    await page.keyboard.type('Nope')
    await page.keyboard.press('Escape')
    await page.waitForSelector(field, { hidden: true })
    expect(await name()).toBe('Pill')

    /* the field opens with the name selected, so typing replaces it */
    await page.click('[data-component-card="Pill"] [data-component-menu]')
    await clickByText('Rename')
    await page.waitForSelector(field)
    expect(await page.$eval(field, (el) => document.activeElement === el)).toBe(true)
    await page.keyboard.type('Badge')
    await page.keyboard.press('Enter')
    await until(async () => (await name()) === 'Badge', 'the rename to save')
    await page.waitForSelector('[data-component-card="Badge"]')

    /* the main's Layers row renames it too */
    await switchTab('Layers')
    const mainRow = await page.evaluate((id) => {
      const rows = [...document.querySelectorAll<HTMLElement>(`[data-row-key^="${id}|"]`)]
      return rows.find((row) => row.querySelector('.text-brand:not(.opacity-70)'))?.dataset.rowKey ?? ''
    }, frameId)
    await page.click(`[data-row-key="${mainRow}"] > span:nth-of-type(3)`, { count: 2 })
    const rowField = 'input[aria-label="Item name"]'
    await page.waitForSelector(rowField)
    await page.keyboard.type('Tag')
    await page.keyboard.press('Enter')
    await until(async () => (await name()) === 'Tag', 'the rename from the layers row')
  })

  it('renames a standalone main’s component and its frame from the Layers row', async () => {
    const made = await page.evaluate(async (id) => {
      const post = async (url: string, body: unknown) => {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) throw new Error(await res.text())
        return res.json()
      }
      const frame = await post(`/api/canvases/${id}/frames`, {
        name: 'Shape',
        x: 700,
        y: 100,
        width: 80,
        height: 80,
        html: '<!doctype html><html><head></head><body data-doop-canvas-element="true"><div data-doop-id="dotdot" data-doop-drawing="rect" style="width:80px;height:80px;background:#0177d3"></div></body></html>',
      })
      const { component } = await post(`/api/canvases/${id}/components`, {
        name: 'Dot',
        frameId: frame.id,
        element: 'dotdot',
      })
      return { frameId: frame.id as string, componentId: component.id as string }
    }, canvasId)
    const state = async () => {
      const data = await canvas()
      return {
        component: data.components!.find((def) => def.id === made.componentId)!.name,
        frame: (data.frames as { id: string; name?: string }[]).find((frame) => frame.id === made.frameId)!.name,
      }
    }
    const row = await page.waitForFunction(
      (id) =>
        [...document.querySelectorAll<HTMLElement>(`[data-row-key^="${id}"]`)].find((el) =>
          el.querySelector('.text-brand:not(.opacity-70)'),
        )?.dataset.rowKey,
      {},
      made.frameId,
    )
    const rowKey = (await row.jsonValue()) as string
    await page.click(`[data-row-key="${rowKey}"] > span:nth-of-type(3)`, { count: 2 })
    await page.waitForSelector('input[aria-label="Item name"]')
    await page.keyboard.type('Marker')
    await page.keyboard.press('Enter')
    await until(async () => {
      const now = await state()
      return now.component === 'Marker' && now.frame === 'Marker'
    }, 'the component and its frame to take the new name')

    const renameRow = async (value: string) => {
      await page.click(`[data-row-key="${rowKey}"] > span:nth-of-type(3)`, { count: 2 })
      await page.waitForSelector('input[aria-label="Item name"]')
      await page.keyboard.down('Meta')
      await page.keyboard.press('a')
      await page.keyboard.up('Meta')
      await page.keyboard.type(value)
      await page.keyboard.press('Enter')
    }
    const renameFrameOnServer = (name: string) =>
      page.evaluate(
        async (id, next) => {
          const res = await fetch(`/api/frames/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: next }),
          })
          if (!res.ok) throw new Error(await res.text())
        },
        made.frameId,
        name,
      )

    /* the frame takes the name the server saved, not what was typed */
    await renameFrameOnServer('Shape')
    await until(async () => (await state()).frame === 'Shape', 'the frame to be renamed apart')
    await renameRow('Pin <b>')
    await until(async () => {
      const now = await state()
      return now.component === 'Pin b' && now.frame === 'Pin b'
    }, 'both to take the cleaned name')

    /* typing the component's own name still brings a frame that drifted back to it */
    await renameFrameOnServer('Shape')
    await until(async () => (await state()).frame === 'Shape', 'the frame to be renamed apart again')
    await renameRow('Pin b')
    await until(async () => (await state()).frame === 'Pin b', 'the frame to follow the unchanged name')
  })
})
