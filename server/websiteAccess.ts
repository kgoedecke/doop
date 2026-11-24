import { TimeoutError, type HTTPResponse, type Page } from 'puppeteer-core'

/** A site refused, challenged, or never completed a visit from Doop's
 * automated browser. Different callers need different recovery instructions:
 * connected agents may have their own browser, while resident agents do not. */
export class WebsiteCaptureUnavailableError extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(`${reason}, so Doop could not capture the page. Try another public URL or use screenshots as references.`)
    this.reason = reason

    this.name = 'WebsiteCaptureUnavailableError'
  }
}

export type WebsiteAccessAudience = 'connected-agent' | 'resident' | 'user'

export function websiteAccessErrorMessage(error: unknown, audience: WebsiteAccessAudience): string | undefined {
  if (!(error instanceof WebsiteCaptureUnavailableError)) return undefined
  if (audience === 'user') return error.message
  if (audience === 'resident') {
    return `${error.reason}. Use an existing source frame or attached screenshots if available. Otherwise stop and ask the user to attach screenshots, then retry. Do not guess or invent page content.`
  }
  return `${error.reason}, so no page content was captured. Do not retry with view_website because it uses the same website-capture path. If you have another browser or web-access tool, inspect the URL there and continue only from content you actually observe. If upload_asset is available, capture a screenshot, upload it, and place it in a canvas reference frame. Otherwise ask the user for screenshots or an HTML export. Do not guess or invent page content.`
}

function header(response: HTTPResponse, name: string): string | undefined {
  const wanted = name.toLowerCase()
  return Object.entries(response.headers()).find(([key]) => key.toLowerCase() === wanted)?.[1]
}

/** Challenge headers and the final main-document status are reliable. DOM
 * sniffing is deliberately avoided: normal pages can embed Turnstile or talk
 * about bot checks without blocking access. */
export function assertWebsiteResponseAccessible(response: HTTPResponse | null): void {
  if (!response) return
  if (header(response, 'cf-mitigated')?.toLowerCase() === 'challenge') {
    throw new WebsiteCaptureUnavailableError("A Cloudflare challenge blocked Doop's automated browser")
  }

  const status = response.status()
  if ([401, 403, 407, 423, 429].includes(status)) {
    throw new WebsiteCaptureUnavailableError(`The website blocked Doop's automated browser (HTTP ${status})`)
  }
  if (status >= 400) {
    const statusText = response.statusText().trim()
    throw new WebsiteCaptureUnavailableError(`The website returned HTTP ${status}${statusText ? ` ${statusText}` : ''}`)
  }
}

/** Track the latest main-frame navigation response so a challenge remains
 * visible even when page.goto ultimately times out in a challenge loop. */
export function trackMainDocumentResponse(page: Page): {
  latest: () => HTTPResponse | null
  record: (response: HTTPResponse | null) => void
  stop: () => void
} {
  let latest: HTTPResponse | null = null
  const record = (response: HTTPResponse | null) => {
    if (response) latest = response
  }
  const onResponse = (response: HTTPResponse) => {
    const request = response.request()
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) latest = response
  }
  page.on('response', onResponse)
  return {
    latest: () => latest,
    record,
    stop: () => page.off('response', onResponse),
  }
}

/** Navigate while preserving the final main-document response for access
 * checks. Read-only viewing may keep a partially rendered page after a plain
 * timeout; imports fail instead of persisting an incomplete snapshot. */
export async function navigateWebsitePage(
  page: Page,
  url: string,
  options: NonNullable<Parameters<Page['goto']>[1]>,
  behavior: { settleMs?: number; tolerateTimeout?: boolean } = {},
): Promise<HTTPResponse | null> {
  const tracker = trackMainDocumentResponse(page)
  let navigationError: unknown
  try {
    try {
      tracker.record(await page.goto(url, options))
    } catch (error) {
      navigationError = error
    }
    if (behavior.settleMs) await new Promise((resolve) => setTimeout(resolve, behavior.settleMs))
    assertWebsiteResponseAccessible(tracker.latest())
  } finally {
    tracker.stop()
  }

  if (navigationError) {
    if (navigationError instanceof TimeoutError) {
      if (!behavior.tolerateTimeout) {
        throw new WebsiteCaptureUnavailableError("The page did not finish loading in Doop's automated browser")
      }
    } else {
      throw new WebsiteCaptureUnavailableError("The page could not load in Doop's automated browser")
    }
  }
  return tracker.latest()
}
