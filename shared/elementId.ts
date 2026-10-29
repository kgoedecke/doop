/**
 * The one way anything outside a frame refers to an element inside it: a
 * `data-doop-id` attribute stamped onto the element the first time something
 * needs to point at it (a comment, an element link). It lives in the frame's
 * HTML, so it travels with the element through moves, re-orders and copies,
 * where a positional CSS path (`main > div:nth-of-type(2)`) would break.
 * Agents are told to keep every `data-doop-*` attribute when they rewrite
 * markup; an element that lost its id is simply stamped again next time.
 */

export const ELEMENT_ID_ATTR = 'data-doop-id'

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const ID_LENGTH = 6

/** `[a-z0-9]{6}`: short enough to read in a URL, 2 billion combinations. */
export function isElementId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9]{6}$/.test(value)
}

export function newElementId(): string {
  const bytes = new Uint8Array(ID_LENGTH)
  crypto.getRandomValues(bytes)
  let id = ''
  for (const byte of bytes) id += ID_ALPHABET[byte % ID_ALPHABET.length]
  return id
}

/** The CSS selector that finds a stamped element in a live document. */
export function elementIdSelector(id: string): string {
  return `[${ELEMENT_ID_ATTR}="${id}"]`
}

/** The id an element-id selector names, or null for any other selector. */
export function elementIdOf(selector: string): string | null {
  const match = new RegExp(`^\\[${ELEMENT_ID_ATTR}="([a-z0-9]{6})"\\]$`).exec(selector)
  return match?.[1] ?? null
}
