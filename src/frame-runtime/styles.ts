import { bleedSheet } from './bleed'
import { logicalNames } from './cssValues'
import { isLocked, styleTarget } from './dom'
import { designRect, elementGeometry } from './geometry'
import { dropPendingTextSave, postEdited } from './edit'
import { protoSheet } from './proto'
import { holdStill, releaseStill, stillSheet, vCursorSheet, vOutlineSheet, vSheet } from './sheets'
import {
  clearTextRuns,
  isTextPatch,
  layerTextPatch,
  postTextState,
  previewTextRange,
  restoreTextRuns,
  selectedTextRange,
  styleTextRange,
  type TextRunChange,
  type TextRunEdit,
} from './text'
import { clearTimeout, setTimeout } from './timers'
import type { StylePatch } from './types'
import { paintShapes, takeVectorPaint, vectorShapes } from './vector'

/* Inline styles the Design panel writes: a typed value or a slider lands at
   once and saves once it settles; a gesture (a drag, a scrub) previews in
   place and lands as one edit when it commits, or is put back on a cancel. */

/** another picked element a geometry gesture carries along */
interface Follower {
  selector: unknown
  el: HTMLElement
  original: string | null
}

/** a vector shape a gesture painted, with its style before */
interface PaintedShape {
  el: SVGElement
  original: string | null
}

/** the gesture in progress: what it previews and what a cancel puts back */
export interface StyleEdit extends TextRunEdit {
  selector: unknown
  original: string
  styles: StylePatch
  touched: Record<string, true>
  followers: Follower[]
  shapes: PaintedShape[]
  paint: StylePatch
  /** the gesture styles part of the edited text: it lands undoably at the end */
  range?: boolean
}

let styleTimer: number | null = null
export let styleEdit: StyleEdit | null = null
let panelSelection: string[] | null = null
const panelEdits = new Map<unknown, StyleEdit>()

function activeStyleEdits(): StyleEdit[] {
  return styleEdit ? [...panelEdits.values(), styleEdit] : []
}

/* a slider fires many of these a second: one save once it settles */
function scheduleStyleSave(): void {
  if (styleTimer) clearTimeout(styleTimer)
  styleTimer = setTimeout(() => {
    styleTimer = null
    postEdited()
  }, 250)
}

/** whether a style save is still waiting to go */
export function styleSavePending(): boolean {
  return styleTimer !== null
}

/** a style save still waiting goes now: before an undo, or another action */
export function flushStyleSave(): void {
  if (!styleTimer) return
  clearTimeout(styleTimer)
  styleTimer = null
  postEdited()
}

/* the longhands a declaration sets: a rule may mark only one side of a
   shorthand !important, and the CSSOM reports priority per longhand */
function longhandsOf(name: string, value: string): string[] {
  const probe = document.createElement('div').style
  probe.setProperty(name, value)
  const names: string[] = []
  for (let i = 0; i < probe.length; i++) names.push(probe[i]!)
  if (!names.length) names.push(name)
  // A rule may name the same box side logically. Which logical side maps to
  // a physical one depends on the writing mode, so every candidate counts:
  // an !important the edit did not need is harmless, a missed one is not.
  for (let n = names.length - 1; n >= 0; n--) {
    for (const logical of logicalNames(names[n]!)) names.push(logical)
  }
  return names
}

function ruleOutranksInline(rules: CSSRuleList, el: Element, names: string[]): boolean {
  for (const rule of rules) {
    const styled = rule as CSSStyleRule
    if (styled.selectorText && styled.style) {
      // "all" is its own entry in the CSSOM, never expanded into longhands
      let marked = styled.style.getPropertyPriority('all') === 'important'
      for (let n = 0; n < names.length && !marked; n++)
        marked = styled.style.getPropertyPriority(names[n]!) === 'important'
      if (!marked) continue
      try {
        if (el.matches(styled.selectorText)) return true
      } catch {
        /* a selector this engine cannot match */
      }
      continue
    }
    const grouping = rule as CSSMediaRule & CSSImportRule
    if (grouping.media && grouping.media.mediaText && !matchMedia(grouping.media.mediaText).matches) continue
    let inner: CSSRuleList | null = null
    try {
      inner = grouping.styleSheet ? grouping.styleSheet.cssRules : grouping.cssRules
    } catch {
      /* cross-origin import */
    }
    if (inner && ruleOutranksInline(inner, el, names)) return true
  }
  return false
}

/* A design's own rule marked !important beats a plain inline declaration,
   so an edit written the usual way would change nothing on screen. True
   when a rule matching el declares any of the edit's longhands that way.
   Sheets a design script adopted count like its <style> tags; our own (the
   adopted ones by identity, the editing tag by its mark) never do, and a
   cross-origin sheet cannot be read and is passed over. */
function isRuntimeSheet(sheet: CSSStyleSheet): boolean {
  const owner = sheet.ownerNode as Element | null
  return (
    sheet === vSheet ||
    sheet === vOutlineSheet ||
    sheet === vCursorSheet ||
    sheet === bleedSheet ||
    sheet === stillSheet ||
    sheet === protoSheet ||
    !!(owner && owner.hasAttribute && owner.hasAttribute('data-v-edit'))
  )
}

function sheetOutranksInline(el: Element, name: string, value: string): boolean {
  const names = longhandsOf(name, value)
  const sheets = (Array.prototype.slice.call(document.styleSheets) as CSSStyleSheet[]).concat(
    document.adoptedStyleSheets || [],
  )
  for (const sheet of sheets) {
    if (sheet.disabled || isRuntimeSheet(sheet)) continue
    if (sheet.media && sheet.media.mediaText && !matchMedia(sheet.media.mediaText).matches) continue
    let rules: CSSRuleList | null = null
    try {
      rules = sheet.cssRules
    } catch {
      /* cross-origin */
    }
    if (rules && ruleOutranksInline(rules, el, names)) return true
  }
  return false
}

/* "context" is the element whose place in the document decides which rules
   apply, when el itself is detached (a run in a copied fragment). */
export function patchStyle(
  el: Element & ElementCSSInlineStyle,
  styles: StylePatch,
  original?: CSSStyleDeclaration | null,
  context?: Element,
): void {
  const style = el.style
  for (const k in styles) {
    if (!Object.prototype.hasOwnProperty.call(styles, k)) continue
    if (styles[k] === null || styles[k] === '') style.removeProperty(k)
    else {
      const value = String(styles[k])
      // Returning to a gesture's original value must also restore its priority.
      let priority = original && styles[k] === original.getPropertyValue(k) ? original.getPropertyPriority(k) : ''
      if (!priority && sheetOutranksInline(context || el, k, value)) priority = 'important'
      style.setProperty(k, value, priority)
    }
  }
}

function previewStyle(edit: StyleEdit, el: HTMLElement, styles: StylePatch): void {
  const before = document.createElement('div').style
  before.cssText = el.style.cssText
  const original = document.createElement('div').style
  original.cssText = edit.original
  patchStyle(el, styles, original)
  // CSS enumerates longhands, so padding/border shorthands and !important
  // declarations can be restored without replacing unrelated inline styles.
  const names: Record<string, true> = {}
  for (let i = 0; i < before.length; i++) names[before[i]!] = true
  for (let j = 0; j < el.style.length; j++) names[el.style[j]!] = true
  for (const name in names) {
    if (
      before.getPropertyValue(name) !== el.style.getPropertyValue(name) ||
      before.getPropertyPriority(name) !== el.style.getPropertyPriority(name)
    )
      edit.touched[name] = true
  }
}

/* flush an element's restored position with transitions off, so the next
   read is where it is and not the first frame of a transition there */
function settleGeometry(el: HTMLElement): void {
  const restoredStyle = el.getAttribute('style')
  el.style.setProperty('transition', 'none', 'important')
  designRect(el)
  if (restoredStyle === null) el.removeAttribute('style')
  else el.setAttribute('style', restoredStyle)
}

/* the other elements of a multi-pick a geometry gesture carries along: each
   movable on its own, none inside the pressed element or another follower,
   none holding the pressed element */
function gestureFollowers(el: HTMLElement, selectors: unknown): Follower[] {
  const movable: Follower[] = []
  ;(Array.isArray(selectors) ? selectors : []).forEach((selector: unknown) => {
    const other = styleTarget(selector)
    if (!other || other === el || other.contains(el) || el.contains(other) || isLocked(other)) return
    if (!elementGeometry(other).enabled) return
    if (movable.some((m) => m.el === other)) return
    movable.push({ selector, el: other, original: other.getAttribute('style') })
  })
  // A picked parent carries its picked descendants, whatever order the pick
  // names them in (as doop:nudge does).
  return movable.filter((m) => !movable.some((other) => other.el !== m.el && other.el.contains(m.el)))
}

function newStyleEdit(selector: unknown, el: HTMLElement | null): StyleEdit {
  return {
    selector,
    original: el?.style.cssText ?? '',
    styles: {},
    touched: {},
    runs: [],
    created: [],
    renamed: [],
    followers: [],
    shapes: [],
    paint: {},
  }
}

/** Remote HTML becomes the cancellation baseline while local previews stay visible. */
export function rebaseStyleEdits(): void {
  if (panelSelection) {
    for (const edit of activeStyleEdits()) {
      const el = styleTarget(edit.selector)
      const patch = { ...edit.styles, ...edit.paint }
      Object.assign(edit, newStyleEdit(edit.selector, el))
      if (el && Object.keys(patch).length) applyStyleNow(edit.selector, patch)
    }
    return
  }
  if (!styleEdit) return
  const target = styleTarget(styleEdit.selector)
  if (!target) return
  styleEdit.original = target.style.cssText
  styleEdit.touched = {}
  previewStyle(styleEdit, target, styleEdit.styles)
  if (Object.keys(styleEdit.paint).length) {
    const shapes = vectorShapes(target)
    styleEdit.shapes = shapes.map((shape) => ({ el: shape, original: shape.getAttribute('style') }))
    paintShapes(shapes, styleEdit.paint)
  }
}

export function beginPanelEdit(selectors: string[]): void {
  const editable = selectors.filter((selector) => {
    const el = styleTarget(selector)
    return el && !isLocked(el)
  })
  if (!editable.length || !beginStyleEdit(editable[editable.length - 1], [])) return
  panelSelection = selectors
  for (const selector of editable.slice(0, -1)) {
    const el = styleTarget(selector)
    if (el) panelEdits.set(selector, newStyleEdit(selector, el))
  }
}

export function panelEditFor(selectors: string[]): StyleEdit | null {
  return panelSelection?.length === selectors.length && selectors.every((s, i) => s === panelSelection?.[i])
    ? styleEdit
    : null
}

export function beginStyleEdit(selector: unknown, followers: unknown): boolean {
  const el = styleTarget(selector)
  if (!el || isLocked(el)) return false
  if (styleEdit) endStyleEdit(styleEdit.selector, false)
  // Save a previous typed/slider edit before opening this separate action:
  // a save landing mid-gesture would carry the preview, which a cancel
  // then has nothing to replace.
  flushStyleSave()
  if (dropPendingTextSave()) postEdited()
  styleEdit = newStyleEdit(selector, el)
  styleEdit.followers = gestureFollowers(el, followers)
  holdStill()
  return true
}

export function endStyleEdit(selector: unknown, cancel: boolean): boolean {
  if (!styleEdit || styleEdit.selector !== selector) return false
  const edits = activeStyleEdits()
  // A picked SVG and its picked child can both paint the same shape.
  if (cancel) edits.reverse()
  panelSelection = null
  panelEdits.clear()
  styleEdit = null
  try {
    let changed = false
    for (const edit of edits) {
      if (finishStyleEdit(edit, styleTarget(edit.selector), cancel)) changed = true
    }
    if (changed) postEdited(true)
    return true
  } finally {
    releaseStill()
  }
}

function finishStyleEdit(edit: StyleEdit, el: HTMLElement | null, cancel: boolean): boolean {
  if (!el) return false
  if (cancel) {
    restoreTextRuns(edit)
    edit.followers.forEach((follower) => {
      if (follower.original === null) follower.el.removeAttribute('style')
      else follower.el.setAttribute('style', follower.original)
      settleGeometry(follower.el)
    })
    edit.shapes.forEach((shape) => {
      if (shape.original === null) shape.el.removeAttribute('style')
      else shape.el.setAttribute('style', shape.original)
    })
    const original = document.createElement('div').style
    original.cssText = edit.original
    for (const name in edit.touched) {
      const value = original.getPropertyValue(name)
      if (value) el.style.setProperty(name, value, original.getPropertyPriority(name))
      else el.style.removeProperty(name)
    }
    if (!el.getAttribute('style')) el.removeAttribute('style')
    // A cancelled geometry drag must report its restored coordinates,
    // rather than the first frame of a transition back to them.
    if (edit.touched.translate || edit.touched.rotate || edit.touched.scale) settleGeometry(el)
    return false
  }
  if (edit.range) {
    // The preview was outside the undo history: put it back and apply the
    // gesture's final styles through the undoable path, as one entry.
    restoreTextRuns(edit)
    if (selectedTextRange(el)) styleTextRange(el, edit.styles)
    postTextState()
    return true
  }
  return !!(
    Object.keys(edit.touched).length ||
    edit.shapes.length ||
    edit.runs.length ||
    edit.created.length ||
    edit.renamed.length
  )
}

/* every style the runtime writes lands at once: a typed value, a slider, a
   rotation or flip (doop:geometry), a nudge, a gesture's preview */
export function applyStyle(selector: unknown, styles: StylePatch, uniformText?: boolean): boolean {
  holdStill()
  try {
    return applyStyleNow(selector, styles, uniformText)
  } finally {
    releaseStill()
  }
}

function applyStyleNow(selector: unknown, styles: StylePatch, uniformText?: boolean): boolean {
  const el = styleTarget(selector)
  if (!el || isLocked(el)) return false
  const textPatch = isTextPatch(styles)
  /* the gesture this edit belongs to, when it is the pressed element's */
  const gesture = styleEdit?.selector === selector ? styleEdit : panelEdits.get(selector)
  if (panelSelection && !gesture && typeof selector === 'string' && panelSelection.includes(selector)) return false
  const following = styleEdit && !gesture && styleEdit.followers.some((f) => f.selector === selector)
  if (following) {
    // A follower's move previews with the gesture and is restored, or saved,
    // with it: never a save of its own mid-drag.
    patchStyle(el, styles)
    if (!el.getAttribute('style')) el.removeAttribute('style')
    return true
  }
  const vector = takeVectorPaint(el, styles)
  if (vector) {
    if (gesture) {
      Object.assign(gesture.paint, vector.paint)
      // The shapes' own styles, put back on a cancel as a follower's are.
      vector.shapes.forEach((shape) => {
        if (!gesture.shapes.some((known) => known.el === shape)) {
          gesture.shapes.push({ el: shape, original: shape.getAttribute('style') })
        }
      })
    }
    paintShapes(vector.shapes, vector.paint)
    styles = vector.rest
    if (!Object.keys(styles).length) {
      if (!gesture) scheduleStyleSave()
      return true
    }
  }
  function noteRuns(change: TextRunChange): void {
    if (!gesture) return
    change.before.forEach((run) => {
      if (!gesture.runs.some((known) => known.el === run.el) && gesture.created.indexOf(run.el) === -1)
        gesture.runs.push(run)
    })
    change.created.forEach((run) => gesture.created.push(run))
    if (change.nodes) gesture.nodes = change.nodes
    if (change.renamed) change.renamed.forEach((run) => gesture.renamed.push(run))
  }
  if (textPatch && !panelSelection && selectedTextRange(el)) {
    // Part of the text is selected: the edit belongs to that run alone. A
    // scrub previews in place and lands once, undoably, when it commits.
    if (gesture) {
      Object.assign(gesture.styles, styles)
      gesture.range = true
      noteRuns(previewTextRange(el, styles))
    } else {
      styleTextRange(el, styles)
      scheduleStyleSave()
    }
    postTextState()
    return true
  }
  if (textPatch) noteRuns(clearTextRuns(el, styles))
  else if (uniformText) noteRuns(clearTextRuns(el, layerTextPatch(styles)))
  if (gesture) {
    Object.assign(gesture.styles, styles)
    previewStyle(gesture, el, styles)
    if (!el.getAttribute('style')) el.removeAttribute('style')
    return true
  }
  patchStyle(el, styles)
  if (!el.getAttribute('style')) el.removeAttribute('style')
  scheduleStyleSave()
  return true
}
