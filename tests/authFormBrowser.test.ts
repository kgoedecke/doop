import { beforeEach, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { fixtureUrl, pagePerTest } from './browser'

declare global {
  interface Window {
    setSignUpResponse: (status: number, body: unknown) => void
    /** every unhandled rejection the page produced, the shape PostHog reports */
    rejections: string[]
    /** every SSO start the page made (the body of POST /api/auth/sign-in/oauth2) */
    oauthStarts: { providerId: string }[]
  }
}

/* Each test loads the whole app in its own body, which on a busy CI runner
   takes longer than the 5 s default test timeout. */
describe.skipIf(!findBrowserPath())('sign-up form error handling', { timeout: 30_000 }, () => {
  const pages = pagePerTest()
  let page: Page
  let pageErrors: string[] = []

  beforeEach(async () => {
    pageErrors = []
    page = await pages.open()
    await page.setViewport({ width: 900, height: 900 })
    page.setDefaultTimeout(5_000)
    page.on('pageerror', (error) => pageErrors.push(String(error)))
  })

  /** Load the form, choose what the sign-up POST answers, and submit it. */
  async function signUp(status: number, body: unknown) {
    await page.goto(fixtureUrl('authForm.html'))
    await page.waitForFunction(() => typeof window.setSignUpResponse === 'function')
    await page.evaluate((response) => window.setSignUpResponse(response.status, response.body), { status, body })
    await clickButton('No account yet? Sign up')
    await type('input[autocomplete="name"]', 'New Person')
    await type('input[autocomplete="email"]', 'newcomer@example.test')
    await type('input[autocomplete="new-password"]', 'password12345')
    await clickButton('Sign up')
    /* settled: the form has something to say, or submitting threw */
    await page.waitForFunction(() => !!document.querySelector('[data-slot="callout"]') || window.rejections.length > 0)
  }

  async function clickButton(label: string) {
    await page.waitForFunction(
      (label) => [...document.querySelectorAll('button')].some((b) => b.textContent?.includes(label)),
      {},
      label,
    )
    await page.evaluate((label) => {
      const button = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(label))
      button?.click()
    }, label)
  }

  async function type(selector: string, text: string) {
    await page.locator(selector).click()
    await page.keyboard.type(text)
  }

  /** The text of the error the form shows, once it shows one. */
  async function errorText(): Promise<string> {
    await page.waitForSelector('[data-slot="callout"]')
    return (await page.$eval('[data-slot="callout"]', (el) => el.textContent)) ?? ''
  }

  /** Nothing in the submit threw: no page error, no unhandled rejection. */
  async function noCrash() {
    expect(await page.evaluate(() => window.rejections)).toEqual([])
    expect(pageErrors).toEqual([])
  }

  it('says the app could not be reached when the platform answers instead of it', async () => {
    /* Railway's edge, verbatim: it answers in its own shape whenever it cannot
       reach the container (every deploy restart), and its `code` is a NUMBER.
       Matching that with String.prototype.startsWith threw inside the submit
       handler, which left the form with no message at all. */
    await signUp(502, {
      status: 'error',
      code: 502,
      message: 'Application failed to respond',
      request_id: 'Ks3Nn1gLSsmRxT8ZTqA3dQ',
    })
    await noCrash()
    expect(await errorText()).toContain('doop could not be reached')
    /* the form is usable again, not stuck mid-submit */
    expect(await page.$eval('button[type="submit"]', (el) => el.textContent)).toBe('Sign up')
  })

  it('offers sign-in when the account already exists', async () => {
    await signUp(422, {
      code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL',
      message: 'User already exists. Use another email.',
    })
    await noCrash()
    expect(await errorText()).toContain('An account with this email already exists.')
    expect(await errorText()).toContain('Sign in instead')
  })

  it('shows what the API said for every other failure', async () => {
    await signUp(400, { code: 'PASSWORD_TOO_SHORT', message: 'Password too short' })
    await noCrash()
    expect(await errorText()).toContain('Password too short')
  })
})

/* The instance's sign-in policy (Admin → Sign-in) on the real form. */
describe.skipIf(!findBrowserPath())('sign-in policy', { timeout: 30_000 }, () => {
  const pages = pagePerTest()
  let page: Page

  beforeEach(async () => {
    page = await pages.open()
    await page.setViewport({ width: 900, height: 900 })
    page.setDefaultTimeout(5_000)
  })

  const SSO = { enabled: true, displayName: 'Zitadel' }

  /** Open the form under a policy, with any extra query the page should see. */
  async function open(login: Record<string, unknown>, extra = '') {
    await page.goto(`${fixtureUrl('authForm.html')}?login=${encodeURIComponent(JSON.stringify(login))}${extra}`)
    await page.waitForSelector('[data-slot="auth-card-text"]')
  }

  function buttonLabels() {
    return page.evaluate(() => [...document.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? ''))
  }

  it('offers sign-up by default', async () => {
    await open({})
    expect(await buttonLabels()).toContain('No account yet? Sign up')
  })

  it('hides sign-up when email/password sign-up is off', async () => {
    await open({ emailPasswordSignup: false })
    const labels = await buttonLabels()
    expect(labels).toContain('Sign in')
    expect(labels).not.toContain('No account yet? Sign up')
  })

  it('goes straight to the provider when the policy says so', async () => {
    await open({ ...SSO, ssoAutoRedirect: true })
    await page.waitForFunction(() => location.hash === '#idp')
    expect(await page.evaluate(() => window.oauthStarts.map((s) => s.providerId))).toEqual(['oidc'])
    /* what the visitor saw meanwhile: the redirect card, with the way out */
    expect(await buttonLabels()).toContain('Sign in another way')
  })

  it('keeps the rest of the query when the visitor asks for the card', async () => {
    await open({ ...SSO, ssoAutoRedirect: true }, '&redirect_to=%2Fc%2Fabc')
    await page.waitForFunction(() => location.hash === '#idp')
    await page.evaluate(() => {
      ;[...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Sign in another way'))?.click()
    })
    /* a full navigation: wait for the card the new page draws, not the URL */
    await page.waitForFunction(
      () => [...document.querySelectorAll('button')].some((b) => b.textContent?.includes('Sign in with Zitadel')),
      { timeout: 15_000 },
    )
    expect(await page.evaluate(() => new URLSearchParams(location.search).get('manual'))).toBe('1')
    expect(await page.evaluate(() => new URLSearchParams(location.search).get('redirect_to'))).toBe('/c/abc')
  })

  it('shows the card instead when asked for it, or after the provider failed', async () => {
    await open({ ...SSO, ssoAutoRedirect: true }, '&manual=1')
    expect(await buttonLabels()).toContain('Sign in with Zitadel')
    expect(await page.evaluate(() => window.oauthStarts.length)).toBe(0)

    await open({ ...SSO, ssoAutoRedirect: true }, '&error=account_not_linked')
    await page.waitForSelector('[data-slot="callout"]')
    expect(await buttonLabels()).toContain('Sign in with Zitadel')
    expect(await page.evaluate(() => window.oauthStarts.length)).toBe(0)
  })
})
