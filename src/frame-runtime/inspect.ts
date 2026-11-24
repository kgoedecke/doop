import type { ElementInfo, FrameFill } from '../lib/frameBridge'
import { isLocked, styleTarget } from './dom'
import { colorAlphaOf, px } from './cssValues'
import { designRect, elementGeometry, renderedBox, renderScale } from './geometry'
import { imageFill } from './images'
import { isTextBlock, textStyleSummary } from './text'
import { vectorInfo } from './vector'

/* The Design panel cannot read computed styles across the sandbox, so it
   asks for a summary of one element (inspect) or of the frame's own fill
   (rootFill), and writes changes back as inline styles (styles.ts). */

type BorderSide = 'Top' | 'Right' | 'Bottom' | 'Left'

function dimensionValue(el: Element, axis: 'width' | 'height', cs: CSSStyleDeclaration): string {
  // Unlike getComputedStyle's used px size, Typed OM retains stylesheet percentages/auto.
  try {
    if (el.computedStyleMap) return String(el.computedStyleMap().get(axis))
  } catch {
    /* an engine without Typed OM for this property */
  }
  return (el as HTMLElement).style.getPropertyValue(axis) || cs[axis]
}

/* Chrome 158 computes flex-start and flex-end as flow-start and flow-end; the
   panel, and the CSS it writes, keep the names every engine reads */
function flexAlignment(value: string): string {
  return value.replace(/flow-(start|end)/, 'flex-$1')
}

export function inspect(selector: unknown): ElementInfo | null {
  const el = styleTarget(selector)
  if (!el || el === document.documentElement) return null
  const cs = getComputedStyle(el)
  const parentEl = el.parentElement
  const pcs = parentEl ? getComputedStyle(parentEl) : null
  let layoutParent = parentEl
  let layoutStyle = pcs
  while (layoutParent && layoutStyle!.display === 'contents') {
    layoutParent = layoutParent.parentElement
    layoutStyle = layoutParent ? getComputedStyle(layoutParent) : null
  }
  const siblings = parentEl ? parentEl.children : [el]
  let index = 0
  for (let i = 0; i < siblings.length; i++) if (siblings[i] === el) index = i + 1
  const inline: Record<string, string> = {}
  for (let j = 0; j < el.style.length; j++) {
    const name = el.style[j]!
    inline[name] = el.style.getPropertyValue(name)
  }
  // The list enumerates longhands, so a shorthand holding a var() (a design
  // token on border-radius) is only visible through the shorthand itself.
  for (const shorthand of ['border-radius', 'border-color', 'border-width', 'padding', 'gap']) {
    const shorthandValue = el.style.getPropertyValue(shorthand)
    if (shorthandValue) inline[shorthand] = shorthandValue
  }
  const classes = (el.getAttribute('class') || '').trim().split(/[ ]+/).filter(Boolean)
  let text = ''
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3) text += n.nodeValue
  const fontFamilies: string[] = []
  document.fonts.forEach((font) => {
    if (fontFamilies.indexOf(font.family) === -1) fontFamilies.push(font.family)
  })
  const textSummary = textStyleSummary(el)
  const textValues = textSummary.values || cs
  let drawn: BorderSide = 'Top'
  for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
    if (Number(px(cs[`border${side}Width`])) > 0 && cs[`border${side}Style`] !== 'none') {
      drawn = side
      break
    }
  }
  const media = el as HTMLElement & Partial<HTMLImageElement> & Partial<HTMLVideoElement>
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || '',
    classes,
    parent:
      parentEl && parentEl !== document.documentElement
        ? {
            tag: parentEl.tagName.toLowerCase(),
            id: parentEl.id || '',
            className: (parentEl.getAttribute('class') || '').trim().split(/[ ]+/)[0] || '',
            display: pcs!.display,
            flexDirection: pcs!.flexDirection,
            writingMode: pcs!.writingMode,
          }
        : null,
    layoutParent: layoutStyle
      ? {
          display: layoutStyle.display,
          flexDirection: layoutStyle.flexDirection,
          writingMode: layoutStyle.writingMode,
        }
      : null,
    index,
    count: siblings.length,
    inline,
    hasText: text.replace(/\s+/g, '') !== '' || isTextBlock(el),
    rect: designRect(el),
    geometry: elementGeometry(el),
    scale: renderScale(el, designRect(el)),
    box: renderedBox(el, designRect(el)),
    position: cs.position,
    display: cs.display,
    flexDirection: cs.flexDirection,
    flexWrap: cs.flexWrap,
    justifyContent: flexAlignment(cs.justifyContent),
    alignItems: flexAlignment(cs.alignItems),
    writingMode: cs.writingMode,
    width: px(cs.width),
    height: px(cs.height),
    widthValue: dimensionValue(el, 'width', cs),
    heightValue: dimensionValue(el, 'height', cs),
    flexGrow: px(cs.flexGrow),
    boxSizing: cs.boxSizing,
    boxExtras: {
      width:
        parseFloat(cs.paddingLeft) +
        parseFloat(cs.paddingRight) +
        parseFloat(cs.borderLeftWidth) +
        parseFloat(cs.borderRightWidth),
      height:
        parseFloat(cs.paddingTop) +
        parseFloat(cs.paddingBottom) +
        parseFloat(cs.borderTopWidth) +
        parseFloat(cs.borderBottomWidth),
    },
    aspectRatio: cs.aspectRatio,
    naturalAspectRatio:
      media.naturalWidth && media.naturalHeight
        ? media.naturalWidth / media.naturalHeight
        : media.videoWidth && media.videoHeight
          ? media.videoWidth / media.videoHeight
          : null,
    minWidth: cs.minWidth,
    rowGap: px(cs.rowGap),
    columnGap: px(cs.columnGap),
    padding: [px(cs.paddingTop), px(cs.paddingRight), px(cs.paddingBottom), px(cs.paddingLeft)],
    opacity: px(cs.opacity),
    visibility: cs.visibility,
    clipsContent: /^(hidden|clip)$/.test(cs.overflowX) && /^(hidden|clip)$/.test(cs.overflowY),
    backgroundColor: cs.backgroundColor,
    image: imageFill(el, cs),
    /* rounded: the crisp-render zoom snaps hairlines to device pixels */
    borderWidths: [
      Math.round(Number(px(cs.borderTopWidth))),
      Math.round(Number(px(cs.borderRightWidth))),
      Math.round(Number(px(cs.borderBottomWidth))),
      Math.round(Number(px(cs.borderLeftWidth))),
    ],
    borderStyle: cs[`border${drawn}Style`],
    borderColor: cs[`border${drawn}Color`],
    borderRadius: px(cs.borderTopLeftRadius),
    vector: vectorInfo(el),
    color: textValues.color!,
    fontSize: px(textValues.fontSize!),
    fontWeight: textValues.fontWeight!,
    fontFamily: textValues.fontFamily!,
    textMixed: textSummary.mixed,
    fontFamilies,
    textAlign: cs.textAlign,
    direction: cs.direction,
  }
}

/* The frame's fill, as Figma's frame Fill: the root element that paints
   the frame's background. The body's paint covers the whole frame while
   the root has none (CSS propagates it to the canvas); once the root is
   painted too, the body paints only its own box, so it is the fill only
   while that box covers most of the frame (a centred column is not). */
export function rootFill(): FrameFill {
  const html = document.documentElement
  const body = document.body
  const el = body && !(painted(html) && (!painted(body) || !coversFrame(body))) ? body : html
  const cs = getComputedStyle(el)
  const inline: Record<string, string> = {}
  const color = el.style.getPropertyValue('background-color')
  // A token set through the shorthand (background: var(--surface)) leaves
  // the longhand empty: it reads back pending substitution.
  const shorthand = el.style.getPropertyValue('background').trim()
  if (color) inline['background-color'] = color
  else if (/^var\(\s*--[\w-]+\s*\)$/.test(shorthand)) inline['background-color'] = shorthand
  return {
    selector: el === body ? 'body' : 'html',
    backgroundColor: cs.backgroundColor,
    image: imageFill(el, cs),
    /* a gradient or layered image over the colour, which a colour edit replaces */
    overlay: cs.backgroundImage !== 'none' && !imageFill(el, cs),
    inline,
    shorthand: !!shorthand,
    locked: isLocked(el),
  }
}

function painted(el: Element): boolean {
  const cs = getComputedStyle(el)
  return colorAlphaOf(cs.backgroundColor) > 0 || cs.backgroundImage !== 'none'
}

function coversFrame(el: Element): boolean {
  const r = el.getBoundingClientRect()
  const w = document.documentElement.clientWidth
  const h = document.documentElement.clientHeight
  const seen =
    Math.max(0, Math.min(r.right, w) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, h) - Math.max(r.top, 0))
  return w * h > 0 && seen / (w * h) >= 0.5
}
