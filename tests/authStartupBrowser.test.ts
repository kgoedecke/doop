import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { HTTPRequest } from 'puppeteer-core'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { findBrowserPath } from '../server/screenshot'
import { pagePerTest, serveBuilt } from './browser'
import { freePort, startServer, type Server } from './harness'

describe.skipIf(!findBrowserPath())('production sign-in startup', { timeout: 30_000 }, () => {
  const pages = pagePerTest()
  let dataDir: string
  let server: Server

  beforeAll(async () => {
    const rig = inject('browserRig')
    if (!rig) throw new Error('No built client for the browser test')
    dataDir = mkdtempSync(path.join(tmpdir(), 'doop-auth-startup-'))
    symlinkSync(rig.builtDir, path.join(dataDir, 'dist'), 'junction')
    server = await startServer(
      {
        PORT: String(await freePort()),
        NODE_ENV: 'production',
        BETTER_AUTH_SECRET: 'test-secret-at-least-32-chars-long-1234',
        DEFAULT_LOCALE: 'pt-BR',
      },
      dataDir,
    )
  })

  afterAll(async () => {
    server?.stop({ keepData: true })
    await server?.stopped
    if (dataDir) rmSync(dataDir, { recursive: true, force: true })
  })

  it.each(['font stylesheet', 'locale config'] as const)('accepts input while %s is withheld', async (blocked) => {
    const page = await pages.open()
    let fontStylesheet: HTTPRequest | undefined
    const stylesheet = { status: 200, contentType: 'text/css', body: ':root { --test-font-ready: yes }' }
    await page.setRequestInterception(true)
    page.on('request', async (request) => {
      const url = new URL(request.url())
      if (blocked === 'font stylesheet' && request.isNavigationRequest() && url.pathname === '/auth') {
        const response = await fetch(url)
        await request.respond({
          status: response.status,
          contentType: 'text/html',
          headers: { 'Content-Security-Policy': "script-src-attr 'none'" },
          body: await response.text(),
        })
      } else if (url.hostname === 'fonts.googleapis.com') {
        if (blocked === 'font stylesheet') fontStylesheet = request
        else await request.respond(stylesheet)
      } else if (url.pathname !== '/api/locale-config' || blocked !== 'locale config') {
        await request.continue()
      }
    })

    await page.goto(`${server.base}/auth`, { waitUntil: 'domcontentloaded', timeout: 10_000 })
    const email = 'input[autocomplete="email"]'
    await page.locator(email).fill('visitor@example.test')
    expect(await page.$eval(email, (input) => input.value)).toBe('visitor@example.test')
    expect(await page.$eval('html', (html) => html.lang)).toBe('pt-BR')
    expect(await page.$eval('button[type="submit"]', (button) => button.textContent)).toBe('Entrar')

    if (blocked === 'font stylesheet') {
      if (!fontStylesheet) throw new Error('The browser did not request the font stylesheet')
      await fontStylesheet.respond(stylesheet)
    }
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--test-font-ready'))
  })

  it.each([
    {
      flow: 'provider callback',
      urlPath: '/auth?error=account_not_linked',
      english: 'That email already has a doop account',
      portuguese: 'Esse e-mail já tem uma conta no doop',
    },
    {
      flow: 'email sign-in',
      urlPath: '/auth',
      english: 'This email hasn’t been verified yet.',
      portuguese: 'Este e-mail ainda não foi verificado.',
    },
  ])('updates the $flow error when static HTML learns the language without clearing the input', async (scenario) => {
    const web = await serveBuilt({ '/api': { target: server.base } })
    try {
      const page = await pages.open()
      let localeRequest: HTTPRequest | undefined
      await page.setRequestInterception(true)
      page.on('request', async (request) => {
        const url = new URL(request.url())
        if (url.pathname === '/api/locale-config') localeRequest = request
        else if (url.pathname === '/api/auth/sign-in/email' && request.method() === 'POST') {
          await request.respond({
            status: 403,
            contentType: 'application/json',
            body: JSON.stringify({ code: 'EMAIL_NOT_VERIFIED' }),
          })
        } else if (url.hostname === 'fonts.googleapis.com') {
          await request.respond({ status: 200, contentType: 'text/css', body: '' })
        } else await request.continue()
      })

      await page.goto(web.origin + scenario.urlPath, { waitUntil: 'domcontentloaded' })
      const email = 'input[autocomplete="email"]'
      const callout = '[data-slot="callout"]'
      await page.locator(email).fill('visitor@example.test')
      if (scenario.flow === 'email sign-in') {
        await page.locator('input[autocomplete="current-password"]').fill('visitor-password')
        await page.locator('button[type="submit"]').click()
      }
      await page.waitForSelector(callout)
      expect(await page.$eval(callout, (el) => el.textContent)).toContain(scenario.english)

      if (!localeRequest) throw new Error('Static HTML did not request the instance language')
      await localeRequest.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ defaultLocale: 'pt-BR' }),
      })
      await page.waitForFunction(
        (selector, message) => document.querySelector(selector)?.textContent?.includes(message),
        { timeout: 5_000 },
        callout,
        scenario.portuguese,
      )
      expect(await page.$eval('html', (html) => html.lang)).toBe('pt-BR')
      expect(await page.$eval(email, (input) => input.value)).toBe('visitor@example.test')
    } finally {
      await web.close()
    }
  })
})
