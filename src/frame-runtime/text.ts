import {
  LAYER_TEXT_PROPERTIES,
  TEXT_FORMAT_COMMANDS,
  TEXT_STYLE_PROPERTIES,
  type TextFormatCommand,
} from '../lib/richText'
import { isLocked, LOCKED, styleTarget } from './dom'
import { cssPath } from './geometry'
import { activeEl, dropPendingTextSave, editing, hasOwnText, postEdited } from './edit'
import { patchStyle } from './styles'
import type { StylePatch } from './types'

/* Rich text inside the text being edited: the formatting bar's commands,
   the Design panel's styles on a selected run, list shortcuts and paste.
   Shares the edited element and the save path with edit.ts. */

/** an inline run's style as it was before an edit touched it */
export interface RunStyle {
  el: HTMLElement
  cssText: string
}

/** a formatting tag a layer-wide value turned into a span */
export interface RenamedRun {
  el: Element
  span: HTMLElement
}

/** what a text edit changed, for a cancelled gesture to put back */
export interface TextRunChange {
  before: RunStyle[]
  created: HTMLElement[]
  nodes?: Text[]
  renamed?: RenamedRun[]
}

/** the runs a gesture has touched so far (styles.ts keeps them) */
export interface TextRunEdit {
  runs: RunStyle[]
  created: HTMLElement[]
  nodes?: Text[]
  renamed: RenamedRun[]
}

export interface TextStyleSummary {
  values: Partial<Record<TextStyleKey, string>> | null
  mixed: Partial<Record<TextStyleKey, boolean>>
}

type TextStyleKey = 'fontFamily' | 'fontSize' | 'fontWeight' | 'color'

const textProps: readonly string[] = TEXT_STYLE_PROPERTIES
const layerTextProps: readonly string[] = LAYER_TEXT_PROPERTIES
let textRange: Range | null = null
let lastTextSelection = ''

function isTextCommand(command: unknown): command is TextFormatCommand {
  return (TEXT_FORMAT_COMMANDS as readonly unknown[]).indexOf(command) !== -1
}

function validTextRange(range: Range | null): range is Range {
  return !!(
    activeEl &&
    !isLocked(activeEl) &&
    range &&
    activeEl.contains(range.startContainer) &&
    activeEl.contains(range.endContainer) &&
    !Array.prototype.some.call(activeEl.querySelectorAll(LOCKED), (el: Element) => range.intersectsNode(el))
  )
}

/** the edit ended: no run is selected any more */
export function forgetTextRange(): void {
  textRange = null
}

export function postTextState(): void {
  if (!editing || !activeEl) return
  const selection = getSelection()
  const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null
  if (!validTextRange(range)) return
  textRange = range.cloneRange()
  const state: Partial<Record<TextFormatCommand, boolean>> = {}
  TEXT_FORMAT_COMMANDS.forEach((command) => {
    state[command] = document.queryCommandState(command)
  })
  parent.postMessage({ type: 'doop:text-state', state }, '*')
  // The Design panel shows the selected run's styles: tell it when the run changes.
  const key = range.collapsed
    ? ''
    : cssPath(range.startContainer.parentElement || activeEl) +
      ':' +
      range.startOffset +
      '-' +
      cssPath(range.endContainer.parentElement || activeEl) +
      ':' +
      range.endOffset
  if (key !== lastTextSelection) {
    lastTextSelection = key
    parent.postMessage({ type: 'doop:text-selection' }, '*')
  }
}

/* The run the Design panel edits: the selected text while editing, else none. */
export function selectedTextRange(el: Element): Range | null {
  if (!editing || activeEl !== el || !textRange || textRange.collapsed || !validTextRange(textRange)) return null
  // Everything selected (a double-click's select-all) is the layer itself.
  return textRange.toString().trim() === el.textContent!.trim() ? null : textRange
}

function textNodesIn(el: Node, range: Range | null): Text[] {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    if (!node.nodeValue!.replace(/[\s ]+/g, '')) continue
    if (range && !range.intersectsNode(node)) continue
    if (range && !range.collapsed) {
      // A node touching the range only at its boundary is not selected.
      if (node === range.endContainer && range.endOffset === 0) continue
      if (node === range.startContainer && range.startOffset === node.nodeValue!.length) continue
    }
    nodes.push(node)
  }
  return nodes
}

/* Whether every element under el is an inline run (or, under a list, an
   item of it): such an element is one text layer, as a drawing text, an
   edited paragraph or a bulleted list is. */
export function isTextBlock(el: Element): boolean {
  if (hasOwnText(el) || el.hasAttribute('data-doop-text') || el.getAttribute('data-doop-drawing') === 'text')
    return true
  const children = el.querySelectorAll('*')
  if (!children.length || !textNodesIn(el, null).length) return false
  const list = /^(UL|OL)$/.test(el.tagName)
  return Array.prototype.every.call(children, (child: Element) => {
    return child.tagName === 'BR' || (list && child.tagName === 'LI') || getComputedStyle(child).display === 'inline'
  })
}

/* The text styles of el's runs, as the Design panel shows them: the
   selected run's while editing, else the first run's, with a flag for each
   property whose runs disagree (Figma's "Mixed"). */
export function textStyleSummary(el: Element): TextStyleSummary {
  const nodes = textNodesIn(el, selectedTextRange(el))
  const keys: TextStyleKey[] = ['fontFamily', 'fontSize', 'fontWeight', 'color']
  const mixed: TextStyleSummary['mixed'] = {}
  let values: TextStyleSummary['values'] = null
  nodes.forEach((node) => {
    const cs = getComputedStyle(node.parentElement!)
    if (!values) {
      const first: Partial<Record<TextStyleKey, string>> = {}
      keys.forEach((key) => {
        first[key] = cs[key]
      })
      values = first
      return
    }
    const seen = values
    keys.forEach((key) => {
      if (cs[key] !== seen[key]) mixed[key] = true
    })
  })
  return { values, mixed }
}

export function isTextPatch(styles: StylePatch): boolean {
  return Object.keys(styles).every((key) => textProps.indexOf(key) !== -1)
}

const INLINE_RUN = /^(SPAN|B|STRONG|I|EM|U|S|STRIKE|DEL|INS|A|MARK|SMALL|SUB|SUP|CODE|FONT|ABBR|Q|CITE|TIME|LABEL)$/

/* Widen the selection over a run it covers whole, so the run itself is
   restyled rather than wrapped in another. */
function coverRuns(range: Range, el: Element): void {
  for (;;) {
    const node = range.startContainer
    const run = node.nodeType === 3 ? node.parentElement : null
    if (!run || run === el || range.startOffset !== 0 || run.firstChild !== node || !INLINE_RUN.test(run.tagName)) break
    range.setStartBefore(run)
  }
  for (;;) {
    const last = range.endContainer
    const holder = last.nodeType === 3 ? last.parentElement : null
    if (
      !holder ||
      holder === el ||
      range.endOffset !== last.nodeValue!.length ||
      holder.lastChild !== last ||
      !INLINE_RUN.test(holder.tagName)
    )
      break
    range.setEndAfter(holder)
  }
}

/* Style only the selected text, through the editing command that puts the
   change in the browser's undo history beside the typing around it: the
   selection's markup is copied, each selected text node styled on its own
   inline run (a span made here when it has none), and the copy inserted
   over the selection. A run only partly selected loses its element id in
   the copy, since the rest of it keeps the original. The selection then
   covers the styled text, so a second edit lands on the same runs. */
export function styleTextRange(el: HTMLElement, styles: StylePatch): void {
  const range = textRange!.cloneRange()
  coverRuns(range, el)
  // A space right outside the selection rides along as its own text node:
  // left behind, insertHTML would make it no-break to keep it from collapsing.
  const endNode = range.endContainer
  const padEnd = endNode.nodeType === 3 && endNode.nodeValue![range.endOffset] === ' '
  if (padEnd) range.setEnd(endNode, range.endOffset + 1)
  const startNode = range.startContainer
  const padStart =
    startNode.nodeType === 3 && range.startOffset > 0 && startNode.nodeValue![range.startOffset - 1] === ' '
  if (padStart) range.setStart(startNode, range.startOffset - 1)
  const partial: (string | null)[] = []
  Array.prototype.forEach.call(el.querySelectorAll('[data-doop-id]'), (node: Element) => {
    if (!range.intersectsNode(node)) return
    const whole = document.createRange()
    whole.selectNode(node)
    if (
      range.compareBoundaryPoints(Range.START_TO_START, whole) > 0 ||
      range.compareBoundaryPoints(Range.END_TO_END, whole) < 0
    ) {
      partial.push(node.getAttribute('data-doop-id'))
    }
  })
  let host: Node = range.commonAncestorContainer
  if (host.nodeType !== 1) host = host.parentElement!
  const fragment = range.cloneContents()
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  while (walker.nextNode())
    if (walker.currentNode.nodeValue!.replace(/[\s ]+/g, '')) nodes.push(walker.currentNode as Text)
  if (!nodes.length) return
  // The spaces taken along stand apart from the runs, unstyled.
  if (padStart && nodes[0]!.nodeValue![0] === ' ') nodes[0] = nodes[0]!.splitText(1)
  const last = nodes[nodes.length - 1]!
  if (padEnd && last.nodeValue![last.nodeValue!.length - 1] === ' ') last.splitText(last.nodeValue!.length - 1)
  nodes.forEach((node) => {
    let run = node.parentNode as HTMLElement
    if ((run as Node) === fragment || run.childNodes.length !== 1 || !INLINE_RUN.test(run.tagName)) {
      run = document.createElement('span')
      node.parentNode!.insertBefore(run, node)
      run.appendChild(node)
    }
    // The copy is detached, so no ancestor selector matches it: a bare copy
    // of the run's chain, put where the selection sits for the length of
    // the check, stands in for it when rules are matched.
    const standIn = run.cloneNode(false) as Element
    let chain: Node = standIn
    for (let up = run.parentNode; up && up !== fragment; up = up.parentNode) {
      const shell = up.cloneNode(false)
      shell.appendChild(chain)
      chain = shell
    }
    host.appendChild(chain)
    try {
      patchStyle(run, styles, null, standIn)
    } finally {
      host.removeChild(chain)
    }
    if (!run.getAttribute('style')) run.removeAttribute('style')
    run.setAttribute('data-doop-run', '')
  })
  fragment.querySelectorAll('[data-doop-id]').forEach((node) => {
    if (partial.indexOf(node.getAttribute('data-doop-id')) !== -1) node.removeAttribute('data-doop-id')
  })
  const holder = document.createElement('div')
  holder.appendChild(fragment)
  const text = el.textContent!
  el.focus({ preventScroll: true })
  const selection = getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  document.execCommand('insertHTML', false, holder.innerHTML)
  restoreSpaces(el, text)
  textSnapshots.set(el, el.textContent!)
  const runs = el.querySelectorAll('[data-doop-run]')
  runs.forEach((run) => {
    run.removeAttribute('data-doop-run')
  })
  dropPendingTextSave()
  if (runs.length) {
    const selected = document.createRange()
    selected.setStartBefore(runs[0]!)
    selected.setEndAfter(runs[runs.length - 1]!)
    selection.removeAllRanges()
    selection.addRange(selected)
    textRange = selected.cloneRange()
  }
  el.setAttribute('data-doop-text', '')
}

/* insertHTML keeps a space at the insertion's edge from collapsing by making
   it no-break, which would also stop the line wrapping there: the plain
   spaces the text had before come back. A redo replays the command's own
   copy, so the text after each edit is kept to repair that too. */
const textSnapshots = new WeakMap<Element, string>()

function restoreSpaces(el: Element, before: string): void {
  const after = el.textContent!
  if (after.length !== before.length || after.indexOf(' ') === -1) return
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let offset = 0
  while (walker.nextNode()) {
    const node = walker.currentNode
    const value = node.nodeValue!
    let fixed = ''
    for (let i = 0; i < value.length; i++) {
      fixed += value[i] === ' ' && before[offset + i] === ' ' ? ' ' : value[i]
    }
    if (fixed !== value) node.nodeValue = fixed
    offset += value.length
  }
}

/* A scrub's live preview: the selected text nodes styled in place (the
   boundary nodes split so the selected part stands alone), outside the undo
   history. The gesture's end puts this back and, on commit, applies the
   final styles once through styleTextRange. Returns what to put back. */
export function previewTextRange(el: Element, styles: StylePatch): TextRunChange {
  const range = textRange!
  const start = range.startContainer
  const end = range.endContainer
  if (end.nodeType === 3 && range.endOffset < end.nodeValue!.length) {
    ;(end as Text).splitText(range.endOffset)
    range.setEnd(end, end.nodeValue!.length)
  }
  if (start.nodeType === 3 && range.startOffset > 0) {
    const tail = (start as Text).splitText(range.startOffset)
    range.setStart(tail, 0)
    if (end === start) range.setEnd(tail, tail.nodeValue!.length)
  }
  const nodes = textNodesIn(el, range)
  const before: RunStyle[] = []
  const created: HTMLElement[] = []
  nodes.forEach((node) => {
    let run = node.parentElement!
    if (run === el || run.childNodes.length !== 1 || getComputedStyle(run).display !== 'inline') {
      run = document.createElement('span')
      node.parentNode!.insertBefore(run, node)
      run.appendChild(node)
      created.push(run)
    } else before.push({ el: run, cssText: run.style.cssText })
    patchStyle(run, styles)
    if (!run.getAttribute('style')) run.removeAttribute('style')
  })
  if (nodes.length) {
    const selected = document.createRange()
    const lastNode = nodes[nodes.length - 1]!
    selected.setStart(nodes[0]!, 0)
    selected.setEnd(lastNode, lastNode.nodeValue!.length)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(selected)
    textRange = selected.cloneRange()
  }
  return { before, created, nodes }
}

function unwrapRun(run: Element): void {
  while (run.firstChild) run.parentNode!.insertBefore(run.firstChild, run)
  run.remove()
}

/* The element whose computed type the layer's text shows: its first text
   run's holder (a <b> made by ⌘B, say), else the layer itself. */
export function firstTextRun(el: Element): Element {
  const node = textNodesIn(el, null)[0]
  return node && node.parentElement ? node.parentElement : el
}

/* The lines a run's text is drawn with: text-decoration is not inherited
   but painted across descendants, so an underline on the layer shows on its
   <b> run though the run's own computed value is none. Every line set from
   the run up to the layer counts. */
export function runDecoration(run: Element, layer: Element): string {
  const lines: string[] = []
  for (let el: Element | null = run; el; el = el === layer ? null : el.parentElement) {
    getComputedStyle(el)
      .textDecorationLine.split(/\s+/)
      .forEach((line) => {
        if (line && line !== 'none' && lines.indexOf(line) === -1) lines.push(line)
      })
  }
  return lines.length ? lines.join(' ') : 'none'
}

/* The type properties of a patch, for clearing a layer's runs under it. */
export function layerTextPatch(styles: StylePatch): StylePatch {
  const text: StylePatch = {}
  for (const key in styles) if (layerTextProps.indexOf(key) !== -1) text[key] = styles[key]
  return text
}

/* The formatting tags a layer-wide value replaces: a weight set over <b>
   runs takes their boldness with it, a style their italics, a decoration
   their underline or strike. */
const FORMAT_TAGS: Record<string, RegExp> = {
  'font-weight': /^(B|STRONG)$/,
  'font-style': /^(I|EM)$/,
  'text-decoration-line': /^(U|S|STRIKE)$/,
}

/* A value set on the whole layer makes it uniform: the inline runs under it
   drop their own copy of the property, and the formatting tags it replaces
   (FORMAT_TAGS) become spans with the same attributes, as Figma applies a
   layer-wide value over its mixed runs. Returns what a cancelled gesture
   must undo. */
export function clearTextRuns(el: Element, styles: StylePatch): TextRunChange {
  const before: RunStyle[] = []
  const renamed: RenamedRun[] = []
  Array.prototype.forEach.call(el.querySelectorAll('*'), (run: HTMLElement) => {
    if (isLocked(run) || getComputedStyle(run).display !== 'inline') return
    const cssText = run.style.cssText
    for (const key in styles) if (Object.prototype.hasOwnProperty.call(styles, key)) run.style.removeProperty(key)
    if (run.style.cssText !== cssText) {
      before.push({ el: run, cssText })
      if (!run.getAttribute('style')) run.removeAttribute('style')
    }
    const replaced = Object.keys(FORMAT_TAGS).some((key) => {
      return Object.prototype.hasOwnProperty.call(styles, key) && FORMAT_TAGS[key]!.test(run.tagName)
    })
    if (!replaced) return
    const span = document.createElement('span')
    Array.prototype.forEach.call(run.attributes, (attr: Attr) => {
      span.setAttribute(attr.name, attr.value)
    })
    while (run.firstChild) span.appendChild(run.firstChild)
    run.replaceWith(span)
    renamed.push({ el: run, span })
  })
  return { before, created: [], renamed }
}

/* Put back what clearTextRuns and styleTextRange did during a cancelled gesture. */
export function restoreTextRuns(edit: TextRunEdit): void {
  edit.runs.forEach((run) => {
    run.el.style.cssText = run.cssText
    if (!run.el.getAttribute('style')) run.el.removeAttribute('style')
  })
  edit.created.forEach(unwrapRun)
  // Moving the text nodes out of their spans collapsed the live selection
  // around them; the nodes themselves survived, so it is rebuilt from them.
  if (edit.nodes && edit.nodes.length && editing && activeEl) {
    const nodes = edit.nodes
    const lastNode = nodes[nodes.length - 1]!
    const range = document.createRange()
    range.setStart(nodes[0]!, 0)
    range.setEnd(lastNode, lastNode.nodeValue!.length)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    textRange = range.cloneRange()
  }
  edit.renamed.forEach((change) => {
    while (change.span.firstChild) change.el.appendChild(change.span.firstChild)
    change.span.replaceWith(change.el)
  })
}

export function formatText(command: unknown): void {
  if (!editing || !isTextCommand(command) || !validTextRange(textRange)) return
  activeEl!.focus({ preventScroll: true })
  const selection = getSelection()!
  selection.removeAllRanges()
  selection.addRange(textRange)
  // Native commands preserve the browser's undo stack, including typed text.
  document.execCommand(command, false, undefined)
  /* read again: the command's input event runs listeners that may end the edit */
  activeEl!.setAttribute('data-doop-text', '')
  styleLists(activeEl!, command, selection)
  dropPendingTextSave()
  postEdited(true)
  postTextState()
}

// Design resets often hide list markers. Keep the formatting in saved HTML.
function styleLists(el: Element, command: string, selection: Selection): void {
  if (command !== 'insertUnorderedList' && command !== 'insertOrderedList') return
  el.querySelectorAll<HTMLElement>('ul,ol').forEach((list) => {
    if (!selection.rangeCount || !selection.getRangeAt(0).intersectsNode(list)) return
    list.style.listStyleType = list.tagName === 'OL' ? 'decimal' : 'disc'
    list.style.paddingInlineStart = '1.5em'
    list.style.marginBlock = '0'
  })
}

/* Format whole layers from the canvas (⌘B with a text element selected, as
   Figma does): each is made editable for the one command over all its text,
   so a mixed layer becomes uniform and a uniform one toggles off. Answers
   the layers' selectors, since a paragraph turned list changes tag. */
export function formatLayers(selectors: unknown[], command: unknown): unknown[] | null {
  if (editing || !isTextCommand(command)) return null
  let changed = false
  let retagged = false
  // Positional selectors shift once a layer changes tag: resolve them all first.
  const layers = selectors.map((selector) => ({ selector, el: styleTarget(selector) as HTMLElement | null }))
  layers.forEach((layer) => {
    const el = layer.el
    if (!el || isLocked(el) || !isTextBlock(el) || el.querySelector(LOCKED)) return
    const editable = el.getAttribute('contenteditable')
    prepareText(el)
    el.setAttribute('contenteditable', 'true')
    // Editing commands act on the focused editable only; the parent takes
    // the keyboard back once the reply lands.
    el.focus({ preventScroll: true })
    const selection = getSelection()!
    const range = document.createRange()
    range.selectNodeContents(el)
    selection.removeAllRanges()
    selection.addRange(range)
    document.execCommand(command, false, undefined)
    styleLists(el, command, selection)
    selection.removeAllRanges()
    el.blur()
    if (editable === null) el.removeAttribute('contenteditable')
    else el.setAttribute('contenteditable', editable)
    el.setAttribute('data-doop-text', '')
    changed = true
    const normalized = normalizeTextParagraph(el, paragraphStyleDiff(el))
    if (normalized !== el) retagged = true
    layer.el = normalized
  })
  if (changed) postEdited(true)
  // A retagged layer shifts its positional neighbours too: every selector is re-read then.
  return layers.map((layer) => (retagged && layer.el ? cssPath(layer.el) : layer.selector))
}

/* Markdown shortcuts, as Notion and Google Docs have them: "- ", "* " or
   "1. " typed at the start of a line outside a list makes that line one.
   The marker is deleted and the list made through native commands, so ⌘Z
   brings the typed marker back. */
const LIST_MARKERS: Record<string, TextFormatCommand> = {
  '-': 'insertUnorderedList',
  '*': 'insertUnorderedList',
  '1.': 'insertOrderedList',
}

const LINE_REPLACED = /^(img|svg|video|canvas|input|textarea|select|button|iframe|object|embed|math)$/

/* The range from the start of the caret's line to the caret, across runs
   (a marker typed half bold is still a marker), or null when more than a
   marker's few characters, or anything not text, is drawn before it on the
   line. The line starts at the text root, a <br> or a block's edge; an
   inline-block or a replaced element shares the line. */
function lineBefore(node: Text, offset: number): Range | null {
  const range = document.createRange()
  range.setStart(node, 0)
  range.setEnd(node, offset)
  let text = node.nodeValue!.slice(0, offset)
  function isBlock(el: Element): boolean {
    const display = getComputedStyle(el).display
    return display.indexOf('inline') !== 0 && display !== 'contents' && display !== 'none'
  }
  // Scans a node before the caret from its end: 'line' at a line start, 'more' to go on, 'drawn' otherwise.
  function scan(n: Node): 'line' | 'more' | 'drawn' {
    if (n.nodeType === 3) {
      text = n.nodeValue + text
      range.setStart(n, 0)
      return text.trim().length > 3 ? 'drawn' : 'more'
    }
    if (n.nodeType !== 1) return 'more'
    const el = n as Element
    if (el.localName === 'br' || isBlock(el)) return 'line'
    const display = getComputedStyle(el).display
    if (display === 'none') return 'more'
    if ((display !== 'inline' && display !== 'contents') || LINE_REPLACED.test(el.localName)) return 'drawn'
    for (let child = el.lastChild; child; child = child.previousSibling) {
      const found = scan(child)
      if (found !== 'more') return found
    }
    return 'more'
  }
  for (let cur: Node = node; cur !== activeEl; cur = cur.parentNode!) {
    for (let prev = cur.previousSibling; prev; prev = prev.previousSibling) {
      const found = scan(prev)
      if (found === 'line') return range
      if (found === 'drawn') return null
    }
    if (cur.parentNode !== activeEl && isBlock(cur.parentNode as Element)) return range
  }
  return range
}

export function prepareText(el: Element): void {
  // Pre-wrapped newlines are separate visual lines, but native list commands
  // only understand DOM line breaks. Convert before editing/undo begins.
  if (!/^pre/.test(getComputedStyle(el).whiteSpace)) return
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  const nodes: Node[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode)
  nodes.forEach((node) => {
    if (node.nodeValue!.indexOf('\n') === -1 || !/^pre/.test(getComputedStyle(node.parentElement!).whiteSpace)) return
    const fragment = document.createDocumentFragment()
    node.nodeValue!.split('\n').forEach((line, index) => {
      if (index) fragment.appendChild(document.createElement('br'))
      fragment.appendChild(document.createTextNode(line))
    })
    node.parentNode!.replaceChild(fragment, node)
  })
}

/* What a <div> in the paragraph's place would render differently: the
   paragraph's computed longhands that a probe div with the same attributes,
   put beside it for the measurement, does not share (its default margins,
   whatever p rules gave it). Box sizes follow from content and are skipped. */
export function paragraphStyleDiff(paragraph: Element): Record<string, string> {
  const probe = document.createElement('div')
  Array.prototype.forEach.call(paragraph.attributes, (attr: Attr) => {
    probe.setAttribute(attr.name, attr.value)
  })
  paragraph.parentNode!.insertBefore(probe, paragraph.nextSibling)
  const was = getComputedStyle(paragraph)
  const would = getComputedStyle(probe)
  const diff: Record<string, string> = {}
  for (let i = 0; i < was.length; i++) {
    const name = was[i]!
    if (/^(--|-webkit-|width$|height$|inline-size$|block-size$|.*-origin$)/.test(name)) continue
    const value = was.getPropertyValue(name)
    if (value && would.getPropertyValue(name) !== value) diff[name] = value
  }
  probe.remove()
  return diff
}

/* Browsers allow block children in an editable <p>, but HTML parsing ejects
   them on reload: a paragraph holding a list becomes a <div> that renders
   the same, carrying the styles the paragraph owed to its tag inline. */
export function normalizeTextParagraph<T extends Element>(
  paragraph: T,
  diff: Record<string, string>,
): T | HTMLDivElement {
  if (paragraph.tagName !== 'P' || !paragraph.querySelector('ul,ol,div,p')) return paragraph
  const block = document.createElement('div')
  Array.prototype.forEach.call(paragraph.attributes, (attr: Attr) => {
    block.setAttribute(attr.name, attr.value)
  })
  for (const name in diff) if (!block.style.getPropertyValue(name)) block.style.setProperty(name, diff[name]!)
  while (paragraph.firstChild) block.appendChild(paragraph.firstChild)
  paragraph.replaceWith(block)
  return block
}

export function serializeText(root: Element): void {
  // Normalize the saved clone while native undo is active; deactivate
  // reconciles the live host when the editing session ends.
  const live = document.querySelectorAll('p[data-doop-text]')
  root.querySelectorAll('p[data-doop-text]').forEach((paragraph, index) => {
    if (paragraph.querySelector('ul,ol,div,p')) normalizeTextParagraph(paragraph, paragraphStyleDiff(live[index]!))
  })
}

export function installText(): void {
  document.addEventListener('input', (ev) => {
    if ((ev as InputEvent).inputType === 'historyRedo' && activeEl && textSnapshots.has(activeEl))
      restoreSpaces(activeEl, textSnapshots.get(activeEl)!)
  })

  document.addEventListener('input', (ev) => {
    const input = ev as InputEvent
    if (input.inputType !== 'insertText' || input.data !== ' ' || !editing || !activeEl || isLocked(activeEl)) return
    const selection = getSelection()!
    if (!selection.rangeCount || !selection.isCollapsed) return
    const node = selection.anchorNode
    if (!node || node.nodeType !== 3 || !activeEl.contains(node)) return
    // A text root inside a list item (<li><p>…</p></li>) is in a list too.
    if (node.parentElement!.closest('li')) return
    const marker = lineBefore(node as Text, selection.anchorOffset)
    const match = marker && /^\s*(-|\*|1\.)[  ]$/.exec(marker.toString())
    if (!match || !validTextRange(marker)) return
    // formatText saves the list at once: the typing save would only repeat it.
    ev.stopImmediatePropagation()
    selection.removeAllRanges()
    selection.addRange(marker)
    document.execCommand('delete', false, undefined)
    textRange = selection.getRangeAt(0).cloneRange()
    formatText(LIST_MARKERS[match[1]!])
  })

  document.addEventListener('selectionchange', postTextState)
  document.addEventListener('keydown', (ev) => {
    if (!editing || !activeEl || !(ev.metaKey || ev.ctrlKey) || ev.altKey) return
    const key = (ev.key || '').toLowerCase()
    const shortcuts: Record<string, TextFormatCommand> = { b: 'bold', i: 'italic', u: 'underline' }
    const command = !ev.shiftKey
      ? shortcuts[key]
      : ev.code === 'Digit7'
        ? 'insertOrderedList'
        : ev.code === 'Digit8'
          ? 'insertUnorderedList'
          : null
    if (!command) return
    ev.preventDefault()
    postTextState()
    formatText(command)
  })

  // Preserve the old plain-text paste contract: clipboard HTML must not import
  // arbitrary styles, images or executable attributes into the design.
  document.addEventListener('paste', (ev) => {
    if (!editing || !activeEl || !activeEl.contains(ev.target as Node | null)) return
    ev.preventDefault()
    if (ev.clipboardData) document.execCommand('insertText', false, ev.clipboardData.getData('text/plain'))
  })
}
