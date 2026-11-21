import type { Frame as PageFrame } from 'puppeteer-core'

/**
 * Font readiness for server renders. The load event is not a font signal: a
 * face declared in a linked stylesheet (a frame's Google Fonts `<link
 * data-doop-webfonts>`, any imported stylesheet) is requested only when
 * layout first needs it, and Chrome fires `load` without waiting for that
 * request, so a capture taken then shows the fallback (every face Doop
 * writes is `font-display: swap`). `document.fonts.ready` alone does not
 * close the gap either: it resolves at once while no face has been
 * requested yet. So the page is laid out first, which starts the loads its
 * text needs, and only then waited on, again until a layout asks for nothing
 * new.
 */

/** The longest a render waits for its fonts before capturing what it has. */
export const FONT_SETTLE_MS = 5000

/** Rounds of layout-then-wait: a face that lands can reflow text into a
 *  weight or style not yet requested. */
const MAX_FONT_ROUNDS = 3

export type FontSettlement = 'loaded' | 'timed out'

/** Wait, at most `timeoutMs`, for the stylesheets and the fonts the
 *  document's text uses. Never loads a face nothing uses (Google Fonts
 *  declares one per unicode range), and never rejects: a page whose fonts
 *  cannot load still renders, with its fallbacks. */
export async function settleFonts(target: PageFrame, timeoutMs: number = FONT_SETTLE_MS): Promise<FontSettlement> {
  /* the callback carries no named functions: tsx's __name helper does not
     exist in the page */
  const settled = target.evaluate(
    async (deadlineMs: number, rounds: number): Promise<FontSettlement> => {
      const deadline = new Promise<'timed out'>((resolve) => setTimeout(() => resolve('timed out'), deadlineMs))
      const pendingSheets = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"]'))
        .filter((link) => !link.sheet && !link.disabled)
        .map(
          (link) =>
            new Promise<void>((resolve) => {
              link.addEventListener('load', () => resolve(), { once: true })
              link.addEventListener('error', () => resolve(), { once: true })
            }),
        )
      if ((await Promise.race([Promise.all(pendingSheets).then(() => 'loaded' as const), deadline])) === 'timed out') {
        return 'timed out'
      }
      for (let round = 0; round < rounds; round++) {
        /* a forced layout requests every face the text needs right now */
        void document.documentElement.getBoundingClientRect()
        if (document.fonts.status === 'loaded') return 'loaded'
        const ready = document.fonts.ready.then(() => 'loaded' as const)
        if ((await Promise.race([ready, deadline])) === 'timed out') return 'timed out'
      }
      return 'loaded'
    },
    timeoutMs,
    MAX_FONT_ROUNDS,
  )
  /* the page's own timer bounds the wait; this one covers a page too busy
     to run it */
  let timer: ReturnType<typeof setTimeout> | undefined
  const backstop = new Promise<FontSettlement>((resolve) => {
    timer = setTimeout(() => resolve('timed out'), timeoutMs + 1000)
  })
  try {
    return await Promise.race([settled.catch((): FontSettlement => 'timed out'), backstop])
  } finally {
    clearTimeout(timer)
  }
}
