import { isLocked, styleTarget } from './dom'
import { designRect, elementGeometry, parentBounds } from './geometry'
import { applyStyle, styleEdit } from './styles'
import type { Rect } from './types'

/* Geometry edits from the Design panel and the stage: moves, nudges,
   alignment, rotation and flips, written as the inline styles that put the
   element where it was asked to be. */

/** a geometry edit as the editor sends it (GeometryEdit in frameBridge.ts);
 *  every field is checked before it is used */
export interface GeometryCommand {
  kind?: unknown
  axis?: unknown
  edge?: unknown
  value?: number
  x?: number
  y?: number
  dx?: number
  dy?: number
}

const ALIGN_FRACTIONS: Record<string, number> = { start: 0, center: 0.5, end: 1 }

export function editGeometry(selector: unknown, edit: GeometryCommand | null | undefined): boolean {
  const el = styleTarget(selector)
  if (!el || el === document.documentElement || isLocked(el) || !edit) return false
  const geometry = elementGeometry(el)
  if (!geometry.enabled) return false
  const cs = getComputedStyle(el)
  if (edit.kind === 'rotate' && isFinite(edit.value!)) {
    const current = cs.rotate === 'none' ? 0 : parseFloat(cs.rotate)
    return applyStyle(selector, { rotate: current + edit.value! - geometry.rotation! + 'deg' })
  }
  if (edit.kind === 'flip' && (edit.axis === 'x' || edit.axis === 'y')) {
    return applyStyle(selector, {
      scale: geometry.scaleX * (edit.axis === 'x' ? -1 : 1) + ' ' + geometry.scaleY * (edit.axis === 'y' ? -1 : 1),
    })
  }
  const rect = designRect(el)
  let dx = 0
  let dy = 0
  if (edit.kind === 'move' && isFinite(edit.x!) && isFinite(edit.y!)) {
    dx = edit.x! - rect.x
    dy = edit.y! - rect.y
  } else if (edit.kind === 'nudge' && isFinite(edit.dx!) && isFinite(edit.dy!)) {
    dx = edit.dx!
    dy = edit.dy!
  } else {
    const axis = edit.axis
    if (axis !== 'x' && axis !== 'y') return false
    const bounds = parentBounds(el)
    let target: number
    if (edit.kind === 'position' && isFinite(edit.value!)) target = bounds[axis] + edit.value!
    else if (edit.kind === 'align' && geometry.canAlign) {
      const size = axis === 'x' ? 'width' : 'height'
      const fraction = ALIGN_FRACTIONS[edit.edge as string]
      if (fraction === undefined) return false
      target = bounds[axis] + (bounds[size] - rect[size]) * fraction
    } else return false
    dx = axis === 'x' ? target - rect.x : 0
    dy = axis === 'y' ? target - rect.y : 0
  }
  // The rest of a multi-pick travels by the same design-px delta as the
  // element pressed, each through its own translation basis.
  if (styleEdit && styleEdit.selector === selector && (edit.kind === 'move' || edit.kind === 'nudge')) {
    styleEdit.followers.forEach((follower) => {
      editGeometry(follower.selector, { kind: 'nudge', dx, dy })
    })
  }
  if (offsetAnchored(el, cs)) return moveByOffsets(el, selector, rect, dx, dy)
  // Probe the local translation basis. This handles scaled/rotated ancestors and
  // percentage translations without flattening the element's existing transform.
  // All temporary styles are restored synchronously, before painting or saving.
  const original = el.getAttribute('style')
  let finalTranslate: string | null = null
  const translate = cs.translate.match(/calc\([^)]*\)|[^\s]+/g) || []
  const z = translate.length === 3 ? ' ' + translate[2] : ''
  try {
    el.style.setProperty('transition', 'none', 'important')
    el.style.setProperty('translate', '0px 0px' + z, 'important')
    const zero = designRect(el)
    el.style.setProperty('translate', '100px 0px' + z, 'important')
    const right = designRect(el)
    el.style.setProperty('translate', '0px 100px' + z, 'important')
    const down = designRect(el)
    const a = (right.x - zero.x) / 100
    const b = (right.y - zero.y) / 100
    const c = (down.x - zero.x) / 100
    const d = (down.y - zero.y) / 100
    const determinant = a * d - b * c
    if (Math.abs(determinant) >= 0.000001) {
      const x = rect.x + dx - zero.x
      const y = rect.y + dy - zero.y
      finalTranslate = (d * x - c * y) / determinant + 'px ' + (a * y - b * x) / determinant + 'px' + z
    }
  } finally {
    if (original === null) el.removeAttribute('style')
    else el.setAttribute('style', original)
    // Apply through the gesture path so dragging X/Y can save as one edit
    // or restore the original translation on Escape.
    if (finalTranslate !== null) applyStyle(selector, { translate: finalTranslate })
    const settledStyle = el.getAttribute('style')
    // Flush the final position with transitions still disabled. Restoring the
    // authored declarations before this read would animate from the last probe.
    // Also settle the original position when the translation basis is singular.
    el.style.setProperty('transition', 'none', 'important')
    designRect(el)
    if (settledStyle === null) el.removeAttribute('style')
    else el.setAttribute('style', settledStyle)
  }
  return finalTranslate !== null
}

function isAutoOffset(el: HTMLElement, prop: 'right' | 'bottom'): boolean {
  // Typed OM keeps 'auto' where getComputedStyle reports the used px.
  try {
    if (el.computedStyleMap) return String(el.computedStyleMap().get(prop)) === 'auto'
  } catch {
    /* an engine without Typed OM for this property */
  }
  const v = el.style.getPropertyValue(prop)
  return !v || v === 'auto'
}

/* An absolutely placed layer (a drawn shape, a group) is anchored by its
   left and top, as a design tool writes it: a move rewrites those rather
   than piling a translate on top. One stretched between opposite offsets
   would resize instead, so it keeps the translate path. */
function offsetAnchored(el: HTMLElement, cs: CSSStyleDeclaration): boolean {
  return (
    (cs.position === 'absolute' || cs.position === 'fixed') &&
    el !== document.body &&
    isAutoOffset(el, 'right') &&
    isAutoOffset(el, 'bottom')
  )
}

function moveByOffsets(el: HTMLElement, selector: unknown, rect: Rect, dx: number, dy: number): boolean {
  // The same probe as the translate path: left/top through any scaled or
  // turned ancestor, restored synchronously before painting or saving.
  const original = el.getAttribute('style')
  let next: { left: string; top: string } | null = null
  try {
    el.style.setProperty('transition', 'none', 'important')
    const cs = getComputedStyle(el)
    const left = parseFloat(cs.left) || 0
    const top = parseFloat(cs.top) || 0
    el.style.setProperty('left', left + 'px', 'important')
    el.style.setProperty('top', top + 'px', 'important')
    const zero = designRect(el)
    el.style.setProperty('left', left + 100 + 'px', 'important')
    const right = designRect(el)
    el.style.setProperty('left', left + 'px', 'important')
    el.style.setProperty('top', top + 100 + 'px', 'important')
    const down = designRect(el)
    const a = (right.x - zero.x) / 100
    const b = (right.y - zero.y) / 100
    const c = (down.x - zero.x) / 100
    const d = (down.y - zero.y) / 100
    const determinant = a * d - b * c
    if (Math.abs(determinant) >= 0.000001) {
      const x = rect.x + dx - zero.x
      const y = rect.y + dy - zero.y
      next = {
        left: Math.round((left + (d * x - c * y) / determinant) * 100) / 100 + 'px',
        top: Math.round((top + (a * y - b * x) / determinant) * 100) / 100 + 'px',
      }
    }
  } finally {
    if (original === null) el.removeAttribute('style')
    else el.setAttribute('style', original)
    if (next !== null) applyStyle(selector, next)
    const settledStyle = el.getAttribute('style')
    el.style.setProperty('transition', 'none', 'important')
    designRect(el)
    if (settledStyle === null) el.removeAttribute('style')
    else el.setAttribute('style', settledStyle)
  }
  return next !== null
}
