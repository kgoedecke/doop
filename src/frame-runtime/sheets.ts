import { editing } from './edit'

/* The runtime's own stylesheets. Each is adopted rather than a <style> tag:
   the morph would wipe a tag from <head>, and no save or export carries an
   adopted sheet (serialize.ts leaves them out by identity). */

/* horizontal overscroll inside a frame must not chain to the parent page,
   where the browser turns it into a history back/forward swipe. A frame
   is an artboard, so it never wears a scrollbar either (its content still
   scrolls): important, and html:root so a design's own :root or body.x
   rule cannot outrank it. */
export let vSheet: CSSStyleSheet | null = null
/* ⌘Y outline mode: every box drawn as a hairline, fills and shadows off. */
export let vOutlineSheet: CSSStyleSheet | null = null
/* An edit is not an interaction: while one is applied (a new version of the
   html morphed in, a drag or scrub previewing) the design's transitions are
   held still, so an element jumps to its new box at once instead of trailing
   the pointer or being measured mid-way by the outline. Holds nest (a remote
   update can land mid-drag). Releasing flushes style first, so lifting the
   rule starts no transition of its own.
   In a layer: a layered !important outranks an unlayered one whatever its
   specificity, so a design's own `#id { transition: … !important }` is held
   too. Only an inline `style="transition: … !important"` is out of reach. */
export let stillSheet: CSSStyleSheet | null = null
let stillHolds = 0
/* The canvas's cursor, worn by the whole document. On the canvas the frame
   sits under a shield that takes the pointer, but the browser can still
   show the cursor the document asks for (a link's hand, a design's
   cursor:pointer) instead of the canvas's. So the editor sends the cursor it
   wants here (doop:cursor) and the document wears it; while text is edited
   the document's own cursors apply. The prototype player never sends one,
   so a played design keeps its cursors. */
export let vCursorSheet: CSSStyleSheet | null = null
let canvasCursor: string | null = null
let cursorRule = ''

export function installSheets(): void {
  try {
    vSheet = new CSSStyleSheet()
    vSheet.replaceSync(
      'html,body{overscroll-behavior-x:none}html:root,html:root>body{scrollbar-width:none!important}html:root::-webkit-scrollbar,html:root>body::-webkit-scrollbar{display:none!important}[data-v-path-hidden]{visibility:hidden!important}svg[data-doop-drawing="path"]{overflow:visible}',
    )
    document.adoptedStyleSheets = document.adoptedStyleSheets.concat(vSheet)
  } catch {
    /* an engine without constructable sheets goes without */
  }
  try {
    vOutlineSheet = new CSSStyleSheet()
    vOutlineSheet.replaceSync(
      'html,body{background:transparent!important}body *{outline:1px solid rgba(1,119,211,.6)!important;outline-offset:-1px!important;background:transparent!important;box-shadow:none!important;text-shadow:none!important}body img,body video,body canvas,body svg{opacity:.25!important}',
    )
  } catch {
    /* no outline mode */
  }
  try {
    stillSheet = new CSSStyleSheet()
    stillSheet.replaceSync('@layer doop-still{*,*::before,*::after{transition:none!important}}')
  } catch {
    /* transitions run during edits */
  }
  try {
    vCursorSheet = new CSSStyleSheet()
  } catch {
    /* the document keeps its own cursors */
  }
}

export function holdStill(): void {
  if (!stillSheet || stillHolds++ > 0) return
  document.adoptedStyleSheets = document.adoptedStyleSheets.concat(stillSheet)
}

export function releaseStill(): void {
  if (!stillSheet || stillHolds === 0 || --stillHolds > 0) return
  void getComputedStyle(document.documentElement).transitionProperty
  void document.documentElement.offsetWidth
  document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== stillSheet)
}

/** the cursor the editor asks for (a cursor value, never rules), or null */
export function setCanvasCursor(cursor: unknown): void {
  /* a brace is refused: it would add rules of its own */
  canvasCursor = typeof cursor === 'string' && cursor && !/[{}<]/.test(cursor) ? cursor : null
  applyCursor()
}

export function applyCursor(): void {
  if (!vCursorSheet) return
  const on = !!canvasCursor && !editing
  /* a rule on every element restyles the whole document, so only when the
     cursor or whether it applies actually changes */
  if (on && cursorRule !== canvasCursor) {
    vCursorSheet.replaceSync('*,*::before,*::after{cursor:' + canvasCursor + '!important}')
    cursorRule = canvasCursor!
  }
  const adopted = document.adoptedStyleSheets
  if (on === adopted.indexOf(vCursorSheet) >= 0) return
  const rest = adopted.filter((s) => s !== vCursorSheet)
  document.adoptedStyleSheets = on ? rest.concat(vCursorSheet) : rest
}

export function setOutlines(on: boolean): void {
  if (!vOutlineSheet) return
  const rest = document.adoptedStyleSheets.filter((s) => s !== vOutlineSheet)
  document.adoptedStyleSheets = on ? rest.concat(vOutlineSheet) : rest
}
