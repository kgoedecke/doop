import { designRect } from './geometry'
import { requestAnimationFrame } from './timers'

/* A standalone element (a shape on the canvas, no frame around it) is the
   whole document, and an iframe paints nothing past its edge, so a stroke
   wider than the path's box was cut off. As in Figma the box stays the
   path's geometry and the stroke spills past it: the editor makes the
   iframe that many px larger on every side (asked for with
   doop:bleed-want, set with doop:bleed) and the body sits inset by it.
   Everything this runtime says or hears stays in the frame's own design
   px; only the browser's viewport APIs see the margin, through these. */

export let bleed = 0
export let bleedSheet: CSSStyleSheet | null = null

/** a design-px coordinate (either axis) as the viewport sees it */
export function viewX(x: number): number {
  return x + bleed
}

export function frameWidth(): number {
  return innerWidth - 2 * bleed
}

export function frameHeight(): number {
  return innerHeight - 2 * bleed
}

export function setBleed(px: number): void {
  bleed = px > 0 ? px : 0
  if (!bleedSheet) return
  bleedSheet.replaceSync(
    bleed
      ? 'html:root{overflow:hidden!important}html:root>body[data-doop-canvas-element]{position:fixed!important;' +
          'inset:' +
          bleed +
          'px!important;width:auto!important;height:auto!important;margin:0!important}'
      : '',
  )
  const rest = document.adoptedStyleSheets.filter((s) => s !== bleedSheet)
  document.adoptedStyleSheets = bleed ? rest.concat(bleedSheet) : rest
}

/* the margin a standalone shape's strokes need past its box: half the
   stroke as drawn, a miter join (up to its own miter limit, which an
   imported SVG may set past the default 4) or a square cap reaching
   further, in steps so a stroke-width scrub resizes the iframe rarely */
const BLEED_STEP = 16
const BLEED_MAX = 1024

function neededBleed(): number {
  const body = document.body
  if (!body || !body.hasAttribute('data-doop-canvas-element')) return 0
  const width = frameWidth()
  const height = frameHeight()
  let need = 0
  for (const shape of body.querySelectorAll<SVGGraphicsElement>('path,rect,circle,ellipse,line,polyline,polygon')) {
    if (shape.closest('defs,clipPath,mask,symbol,pattern,marker,[data-doop-defs]')) continue
    const cs = getComputedStyle(shape)
    if (cs.stroke === 'none' || cs.display === 'none') continue
    /* a circle of the stroke's width, through the shape's transform: how
       far it reaches along x and along y (a stretched path's stroke
       stretches with it) */
    const m = shape.getScreenCTM && shape.getScreenCTM()
    const join = /miter|arcs/.test(cs.strokeLinejoin) ? Math.max(1, parseFloat(cs.strokeMiterlimit) || 4) : 1
    const cap = cs.strokeLinecap === 'square' ? Math.SQRT2 : 1
    const half = ((parseFloat(cs.strokeWidth) || 0) / 2) * Math.max(join, cap)
    if (!half) continue
    const hx = half * (m ? Math.hypot(m.a, m.c) : 1)
    const hy = half * (m ? Math.hypot(m.b, m.d) : 1)
    const r = designRect(shape)
    need = Math.max(need, hx - r.x, hy - r.y, r.x + r.width + hx - width, r.y + r.height + hy - height)
  }
  return Math.min(BLEED_MAX, Math.ceil(Math.max(0, need) / BLEED_STEP) * BLEED_STEP)
}

let bleedWanted = 0
let bleedCheck = 0

function checkBleed(): void {
  if (bleedCheck) return
  bleedCheck = requestAnimationFrame(() => {
    bleedCheck = 0
    const want = neededBleed()
    if (want === bleedWanted) return
    bleedWanted = want
    parent.postMessage({ type: 'doop:bleed-want', px: want }, '*')
  })
}

export function installBleed(): void {
  try {
    bleedSheet = new CSSStyleSheet()
  } catch {
    /* strokes stay clipped at the box */
  }
  /* the document's changes and the window's size are what move a stroke's reach */
  try {
    new MutationObserver(checkBleed).observe(document.documentElement, {
      attributes: true,
      childList: true,
      subtree: true,
    })
  } catch {
    /* no observer: the resize listener still asks */
  }
  window.addEventListener('resize', checkBleed)
}
