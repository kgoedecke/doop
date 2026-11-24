/* Small lookups every part of the runtime shares. */

/* a locked element, or anything inside a locked box, is off limits to the
   stage: not hovered, not picked, not edited (src/lib/layers.ts LOCK_ATTR) */
export const LOCKED = '[data-doop-locked]'

export function isLocked(el: Element | null | undefined): boolean {
  return !!(el && el.closest && el.closest(LOCKED))
}

/** the element a selector from the editor names; null for none or a bad selector */
export function styleTarget(selector: unknown): HTMLElement | null {
  let el: HTMLElement | null = null
  try {
    el = selector ? document.querySelector<HTMLElement>(selector as string) : null
  } catch {
    /* bad selector */
  }
  return el
}
