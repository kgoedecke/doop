/* The paper a drawn frame starts on. The Frame tool makes an empty document
   white, and that white has to give way the moment a design brings a
   background of its own: written inline on the body it won instead, so a dark
   design put into a drawn frame sat on white, and the white showed as a light
   line along the frame's edge wherever the design's edge pixel was blended
   (a dark design on a dark canvas). As a `:where()` rule it has no
   specificity, so any `body { background }` in the design beats it. */

export const FRAME_PAPER_ATTR = 'data-doop-paper'
export const FRAME_PAPER_CSS = ':where(body){background:#ffffff}'
export const FRAME_PAPER_STYLE = `<style ${FRAME_PAPER_ATTR}>${FRAME_PAPER_CSS}</style>`

const BODY_TAG = /<body\b[^>]*>/i
const STYLE_ATTR = /\bstyle="([^"]*)"/i
/* the white as the Frame tool wrote it before, in the forms a style
   attribute serializes it to */
const INLINE_WHITE = /(^|;)\s*background(?:-color)?:\s*(?:rgb\(255,\s*255,\s*255\)|#fff(?:fff)?)\s*(?:;|$)/i
const STYLE_ELEMENT = /<style\b([^>]*)>([\s\S]*?)<\/style>/gi
const CSS_COMMENT = /\/\*[\s\S]*?\*\//g
/* a rule whose subject is the body (`body`, `html, body`, `body.dark`), not
   one that only starts there (`body > main`), giving it a background */
const BODY_BACKGROUND =
  /(?:^|[{}\s,])body(?:[.:#[][^\s{},>+~]*)?\s*(?:,[^{}]*)?\{[^{}]*\bbackground(?:-color|-image)?\s*:/i

/** Whether one of the document's own stylesheets gives the body a background. */
export function stylesBodyBackground(html: string): boolean {
  for (const [, attrs = '', css = ''] of html.matchAll(STYLE_ELEMENT)) {
    if (attrs.includes(FRAME_PAPER_ATTR)) continue
    if (BODY_BACKGROUND.test(css.replace(CSS_COMMENT, ''))) return true
  }
  return false
}

/** A frame document without the inline white an earlier Frame tool wrote on
 *  its body, where the design's own stylesheet gives the body a background
 *  that the inline white was overriding. Every other document comes back as
 *  it is, and only the body's style attribute is ever touched. */
export function withoutPaperOverride(html: string): string {
  const body = BODY_TAG.exec(html)
  if (!body) return html
  const style = STYLE_ATTR.exec(body[0])
  const declarations = style?.[1]
  if (!style || declarations === undefined || !INLINE_WHITE.test(declarations)) return html
  if (!stylesBodyBackground(html)) return html
  const kept = declarations.replace(INLINE_WHITE, (_match, lead: string) => lead).trim()
  const tag = body[0].replace(style[0], `style="${kept}"`)
  return html.slice(0, body.index) + tag + html.slice(body.index + body[0].length)
}
