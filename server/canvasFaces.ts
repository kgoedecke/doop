import { withTokenBlock } from '../shared/designTokens.ts'
import { withFontFaces } from '../shared/fonts.ts'
import { withWebFontLinks } from '../shared/webFonts.ts'
import { fontsForCanvas } from './fonts.ts'
import { warmHostedIcons, withHostedIcons } from './iconProxy.ts'
import { store } from './store.ts'

/** A document with what the canvas supplies to every frame: the values of the
 *  design tokens it names (shared/designTokens.ts), the @font-face rules for the
 *  library fonts it uses (shared/fonts.ts) and the stylesheet link for the hosted
 *  fonts it names (shared/webFonts.ts), so naming a token or a family is all it takes.
 *  Its Iconify hotlinks point at Doop's copies, which start downloading now. */
export function withCanvasFaces(canvasId: string, html: string): string {
  const canvas = store.getCanvas(canvasId)
  if (!canvas) return html
  const library = fontsForCanvas(canvas)
  /* tokens first: a family named only through a font token is then in the
     document for the font scan to find */
  const withTokens = withTokenBlock(html, canvas.tokens ?? [], canvas.tokenThemes ?? [])
  const finished = withHostedIcons(withWebFontLinks(withFontFaces(withTokens, library), library))
  warmHostedIcons(finished)
  return finished
}

/** A complete `<head>` or `<body>` tag: before one has arrived, the place a block
 *  would go in a document can still be a half-written tag (`<!doctype html><ht`). */
const SETTLED_TOP = /<(?:head|body)\b[^>]*>/i
const LEADING_COMMENTS = /^\s*(?:<!--[\s\S]*?-->\s*)*/
const HTML_OPEN = /^<html(?:[\s>/]|$)/i

/** Whether a stream so far is, or may still turn out to be, a whole document: it opens
 *  (after any comments) with a doctype, an `<html>` tag, a comment not yet closed, or a
 *  first tag too short to tell from `<html`. Anything else is a fragment, which
 *  create_frame accepts and agents stream, and which never gets a head or body tag. */
export function mayBeDocument(html: string): boolean {
  const top = html.replace(LEADING_COMMENTS, '')
  if (!top || top.startsWith('<!') || HTML_OPEN.test(top)) return true
  return top.length < '<html'.length && '<html'.startsWith(top.toLowerCase())
}

/** Whether blocks can be placed in a document still streaming in: a fragment takes them
 *  at its start from its first chunk; a document once its head or body tag is complete. */
export function streamTopSettled(html: string): boolean {
  return SETTLED_TOP.test(html) || !mayBeDocument(html)
}

/** The same for a document still streaming in, once its top is settled, so a
 *  screenshot of the first section already shows the canvas's tokens and fonts.
 *  Each pass replaces the blocks the last one wrote, so chunks never stack them. */
export function withCanvasFacesMidStream(canvasId: string, html: string): string {
  return streamTopSettled(html) ? withCanvasFaces(canvasId, html) : html
}
