import type { Page } from 'puppeteer-core'

/**
 * Drop the CSS a captured page does not use.
 *
 * Sites ship one bundle for the whole product; a single page uses a small
 * fraction of it. Inlining all of it makes imported frames heavy to store,
 * broadcast and render, and near-unreadable for an agent that receives the
 * frame HTML on every get_frame call. Matching selectors against the
 * captured DOM keeps only what styles this page.
 *
 * The browser is the CSS parser: the sheet is injected into the page and
 * walked through CSSOM, so there is no parser dependency and no drift between
 * what we keep and what Chromium understands.
 */

/** Pruning is a size optimisation, never a correctness requirement, so it
 *  gets a fixed slice of time. Past the deadline every remaining rule is
 *  kept as-is: the page and its CSS are attacker-controlled, and a pathological
 *  selector set must not be able to hold the import open. */
export const PRUNE_DEADLINE_MS = 5_000

/** The in-page deadline is checked between rules, so one pathological
 *  selector can still run past it. The server stops waiting here and ships
 *  the unpruned sheet; the stalled renderer goes down with the isolated page
 *  when the import finishes. */
export const PRUNE_WAIT_MS = PRUNE_DEADLINE_MS + 3_000

export interface PrunedPage {
  css: string
  /** The document serialised in the same pass the CSS was pruned against, so
   *  the rules kept and the markup shipped agree whatever page scripts did
   *  since the earlier snapshot. */
  html: string
}

/** Runs INSIDE the captured page via page.evaluate, so it must be
 *  self-contained: no closure over module scope, no imports. */
export function pruneCssInDocument(rawCss: string, deadlineMs: number): PrunedPage {
  const deadline = performance.now() + deadlineMs

  /* Pseudo-classes and pseudo-elements describe state, not structure. Strip
     them so `a:hover::before` keeps its rule when any `a` exists. Functional
     pseudos (:not, :is, :nth-child…) are stripped too, which only widens the
     match — the conservative direction. */
  const stripPseudos = (selector: string) => selector.replace(/::?[a-zA-Z-]+(?:\([^()]*(?:\([^()]*\)[^()]*)*\))?/g, '')

  const used = (selectorText: string): boolean => {
    const selector = stripPseudos(selectorText).trim()
    if (!selector) return true
    try {
      return document.querySelector(selector) !== null
    } catch {
      /* Chromium parsed it, but stripping made it unparseable: keep it. */
      return true
    }
  }

  const isGrouping = (rule: CSSRule): rule is CSSGroupingRule =>
    'cssRules' in rule && !(rule instanceof CSSStyleRule) && !(rule instanceof CSSKeyframesRule)

  const keep = (rule: CSSRule): string | null => {
    if (performance.now() >= deadline) return rule.cssText
    if (rule instanceof CSSStyleRule) return used(rule.selectorText) ? rule.cssText : null
    if (isGrouping(rule)) {
      /* @media, @supports, @layer, @container, @scope… keep the wrapper only
         when something inside it survived. Media conditions are not
         evaluated: a frame can be resized after import. */
      const inner = Array.from(rule.cssRules)
        .map(keep)
        .filter((text): text is string => text !== null)
      if (inner.length === 0) return null
      const header = rule.cssText.slice(0, rule.cssText.indexOf('{'))
      return `${header}{\n${inner.join('\n')}\n}`
    }
    /* @font-face, @keyframes, @property, @page, @counter-style… have no
       selector to test. They are small and dropping one breaks a kept rule. */
    return rule.cssText
  }

  const style = document.createElement('style')
  style.textContent = rawCss
  ;(document.head ?? document.documentElement).appendChild(style)
  try {
    const sheet = style.sheet
    const css = sheet
      ? Array.from(sheet.cssRules)
          .map(keep)
          .filter((text): text is string => text !== null)
          .join('\n')
      : rawCss
    style.remove()
    return { css, html: document.documentElement.outerHTML }
  } finally {
    style.remove()
  }
}

/** Prune `css` against the DOM currently loaded in `page` and serialise that
 *  DOM. Returns null if the page cannot run the pruner, so the caller can fall
 *  back to the unpruned sheet: an oversized import is still an import. */
export async function pruneUnusedCss(page: Page, css: string): Promise<PrunedPage | null> {
  try {
    /* tsx/esbuild annotates nested functions with __name; page.evaluate
       serialises the function source, so the helper must exist in the page.
       Same shim as inspectFrame in screenshot.ts. */
    await page.evaluate('globalThis.__name = (target) => target')
    const pruned = await Promise.race([
      page.evaluate(pruneCssInDocument, css, PRUNE_DEADLINE_MS),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), PRUNE_WAIT_MS).unref?.()),
    ])
    return typeof pruned?.css === 'string' && typeof pruned.html === 'string' ? pruned : null
  } catch {
    return null
  }
}
