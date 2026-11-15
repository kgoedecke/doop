/* The paper a drawn frame starts on. The Frame tool makes an empty document
   white, and that white has to give way the moment a design brings a
   background of its own: written inline on the body it won instead, so a dark
   design put into a drawn frame sat on white, and the white showed as a light
   line along the frame's edge wherever the design's edge pixel was blended
   (a dark design on a dark canvas). It is now a rule nothing in a design can
   lose to: `:where()` has no specificity, and its cascade layer is declared
   before any the design brings, so a design's `body { background }` wins
   whether it sits in a layer (Tailwind's) or outside one. */

export const FRAME_PAPER_ATTR = 'data-doop-paper'
export const FRAME_PAPER_CSS = '@layer doop-paper{:where(body){background:#ffffff}}'
export const FRAME_PAPER_STYLE = `<style ${FRAME_PAPER_ATTR}>${FRAME_PAPER_CSS}</style>`

/* The document the Frame tool wrote before, exactly as a browser serializes
   it: the shell on `html`, and the same shell plus the white on `body`. Only
   this pair is a drawn frame's old default; an inline white a design chose
   for itself never comes with it. */
const LEGACY_HTML = '<html style="width: 100%; height: 100%; margin: 0px;">'
const LEGACY_BODY = '<body style="width: 100%; height: 100%; margin: 0px; background: rgb(255, 255, 255);"'
const HEALED_BODY = '<body style="width: 100%; height: 100%; margin: 0px;"'
const HEAD = '<head>'

/** A frame drawn before the paper was a rule, with its inline white turned
 *  into that rule: the frame stays white until something in it styles the
 *  body, and from then on that wins. Every other document comes back as it
 *  is. Nothing is judged about the design's own CSS, so a rule that does not
 *  apply (a class not set, a print query) cannot take the white away. */
export function withPaperRule(html: string): string {
  const body = html.indexOf(LEGACY_BODY)
  const head = html.indexOf(HEAD)
  if (body < 0 || head < 0 || head > body || !html.includes(LEGACY_HTML)) return html
  const rule = html.includes(FRAME_PAPER_ATTR) ? '' : FRAME_PAPER_STYLE
  const afterHead = head + HEAD.length
  return (
    html.slice(0, afterHead) + rule + html.slice(afterHead, body) + HEALED_BODY + html.slice(body + LEGACY_BODY.length)
  )
}
