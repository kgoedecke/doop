import { bleed, viewX } from './bleed'
import { sendToEditor, runtimePort } from './channel'
import { isLocked, LOCKED } from './dom'
import { hitInfo, type HitInfo } from './hit'
import { serialize } from './serialize'
import { applyCursor } from './sheets'
import { forgetTextRange, normalizeTextParagraph, paragraphStyleDiff, postTextState, prepareText } from './text'
import { clearTimeout, setTimeout } from './timers'

/* Inline text editing. The parent flips edit mode on. Instead of designMode
   (which makes the whole document a caret trap), we hit-test: hovering a
   text-bearing element outlines it, clicking makes JUST that element
   editable with the caret placed at the click point. Edits
   debounce-serialize back to the parent, which saves them through the
   normal frame-update path. */

export let editing = false
/** the element being typed in */
export let activeEl: HTMLElement | null = null
/** a typed edit's save, waiting for the typing to pause */
export let editTimer: number | null = null

/* a typed edit's save still waiting: dropped, for a save that covers it */
export function dropPendingTextSave(): boolean {
  if (!editTimer) return false
  clearTimeout(editTimer)
  editTimer = null
  return true
}

/* the edited element's outline is the parent's (its selection hairline,
   drawn over the frame from the hit rect): in here only the caret cursor,
   and no focus ring of the browser's own */
/* a link inside the text being edited takes the text cursor too: a click
   there places the caret, it never follows the link */
const EDIT_CSS =
  '[data-v-hover]{cursor:text}' +
  '[data-v-active]{cursor:text}' +
  '[data-v-hover] a[href],[data-v-hover] a[href] *,[data-v-active] a[href],[data-v-active] a[href] *{cursor:text}' +
  '[data-v-active]:focus{outline:none!important}'

export function hasOwnText(el: Element): boolean {
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 3 && n.nodeValue!.replace(/[\s ]+/g, '')) return true
  }
  return false
}

/* nearest ancestor (incl. self) that directly contains visible text */
export function candidate(start: EventTarget | Node | null): HTMLElement | null {
  const node = start as Node | null
  let el = (node && node.nodeType === 3 ? node.parentElement : node) as HTMLElement | null
  if (isLocked(el)) return null
  if (activeEl && activeEl.contains(el)) return activeEl
  const root = el && el.closest<HTMLElement>('[data-doop-text],[data-doop-drawing="text"]')
  if (root && !root.querySelector(LOCKED)) return root
  while (el && el !== document.body && el !== document.documentElement) {
    if (hasOwnText(el)) {
      // Inline formatting belongs to its surrounding text block on re-entry.
      while (
        el.parentElement &&
        el.parentElement !== document.body &&
        getComputedStyle(el).display === 'inline' &&
        !el.parentElement.querySelector(LOCKED)
      )
        el = el.parentElement
      if (el.tagName === 'LI') {
        const list = el.closest<HTMLElement>('ul,ol')
        return list && !list.querySelector(LOCKED) ? list : el
      }
      return el
    }
    el = el.parentElement
  }
  return null
}

function clearHover(): void {
  const h = document.querySelector('[data-v-hover]')
  if (h) h.removeAttribute('data-v-hover')
}

export function deactivate(): void {
  if (!activeEl) return
  const normalized = normalizeTextParagraph(activeEl, paragraphStyleDiff(activeEl))
  if (normalized !== activeEl) {
    activeEl = normalized
    postActive() // keep the selected layer's selector in sync with its new tag
  }
  activeEl.removeAttribute('contenteditable')
  activeEl.removeAttribute('data-v-active')
  activeEl = null
  forgetTextRange()
  /* the edit's highlight goes with it: a click outside the frame (or
     Escape) ends the edit, and the text must not stay selected */
  const sel = getSelection()
  if (sel) sel.removeAllRanges()
  postActive()
}

/* tell the parent which element is selected for editing, so it can anchor
   the text formatting bar to it */
function activeInfo(): HitInfo | null {
  return activeEl ? hitInfo(activeEl) : null
}

function postActive(): void {
  parent.postMessage({ type: 'doop:active', hit: activeInfo() }, '*')
  postTextState()
}

function placeCaret(x: number, y: number): void {
  let r: Range | null = null
  if (document.caretRangeFromPoint) {
    r = document.caretRangeFromPoint(viewX(x), viewX(y))
  } else if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(viewX(x), viewX(y))
    if (p) {
      r = document.createRange()
      r.setStart(p.offsetNode, p.offset)
      r.collapse(true)
    }
  }
  if (r) {
    const s = getSelection()!
    s.removeAllRanges()
    s.addRange(r)
  }
}

export function activate(el: HTMLElement, x: number, y: number, keepSelection: boolean): void {
  if (activeEl !== el) {
    deactivate()
    activeEl = el
    el.removeAttribute('data-v-hover')
    el.setAttribute('data-v-active', '1')
    prepareText(el)
    el.contentEditable = 'true'
    el.focus({ preventScroll: true })
    postActive()
  }
  /* double/triple clicks carry a native word/paragraph selection, and a
     drag ends in a click carrying the range it swept — placing a caret
     here would collapse either the instant it appears */
  if (!keepSelection && !hasRangeIn(el)) placeCaret(x, y)
}

/* a double-click edits the whole text at once: every character selected,
   the way Figma opens a text layer */
export function selectAllIn(el: Element): void {
  const r = document.createRange()
  r.selectNodeContents(el)
  const s = getSelection()!
  s.removeAllRanges()
  s.addRange(r)
}

function hasRangeIn(el: Element): boolean {
  const s = getSelection()
  return !!s && !s.isCollapsed && el.contains(s.anchorNode) && el.contains(s.focusNode)
}

/** how many edited documents this runtime has sent: the editor names the one
 *  a document it sends back was built from (see doop:html in commands.ts) */
export let editsSent = 0

/** the document goes to the editor's save path; discrete marks one undo step */
export function postEdited(discrete?: boolean): void {
  if (runtimePort) {
    editsSent++
    sendToEditor({ event: 'edited', html: serialize(), discrete: discrete === true, edit: editsSent })
  }
  /* typing can move/grow the element — keep the parent's toolbar anchored */
  if (editing && activeEl) postActive()
}

export function setEdit(on: boolean): void {
  if (on === editing) return
  editing = on
  applyCursor()
  if (on) {
    const st = document.createElement('style')
    st.setAttribute('data-v-edit', '')
    st.textContent = EDIT_CSS
    document.head.appendChild(st)
  } else {
    dropPendingTextSave()
    deactivate()
    clearHover()
    const st2 = document.querySelector('style[data-v-edit]')
    if (st2 && st2.parentNode) st2.parentNode.removeChild(st2)
    postEdited() // flush the final state before renders resume
  }
}

/** edit mode ended from inside the frame: the editor hears it as Escape */
export function endEditFromFrame(): void {
  setEdit(false)
  parent.postMessage({ type: 'doop:edit-esc' }, '*')
}

/* where the press of the coming click landed: a drag that selects text and
   lets go past the text box clicks on their common ancestor, which is not
   a click on nothing */
let pressedEditable = false

export function installEdit(): void {
  document.addEventListener(
    'mousedown',
    (ev) => {
      if (editing) pressedEditable = !!candidate(ev.target)
    },
    true,
  )

  /* capture-phase: no link navigation or button handlers while editing */
  document.addEventListener(
    'click',
    (ev) => {
      if (!editing) return
      ev.preventDefault()
      ev.stopPropagation()
      const el = candidate(ev.target)
      if (el) activate(el, ev.clientX - bleed, ev.clientY - bleed, ev.detail > 1)
      else if (pressedEditable)
        return // the end of a text drag: keep the selection
      else {
        /* a click on nothing editable ends the edit, as a click outside a text
           box does in Figma. Only deactivating looked the same (no caret, no
           toolbar) but left the frame taking the pointer and the keyboard, so
           the canvas's keys, hover and cursors stayed off until Escape */
        endEditFromFrame()
      }
    },
    true,
  )

  document.addEventListener(
    'mousemove',
    (ev) => {
      if (!editing) return
      const el = candidate(ev.target)
      const prev = document.querySelector('[data-v-hover]')
      if (prev && prev !== el) prev.removeAttribute('data-v-hover')
      if (el && el !== activeEl) el.setAttribute('data-v-hover', '1')
    },
    true,
  )

  document.addEventListener('input', () => {
    if (!editing || !activeEl) return
    activeEl.setAttribute('data-doop-text', '')
    postTextState()
    if (editTimer) clearTimeout(editTimer)
    editTimer = setTimeout(postEdited, 400)
  })

  document.addEventListener(
    'contextmenu',
    (ev) => {
      if (!editing) return
      ev.preventDefault()
      ev.stopPropagation()
      endEditFromFrame()
      parent.postMessage({ type: 'doop:context-menu', x: ev.clientX - bleed, y: ev.clientY - bleed }, '*')
    },
    true,
  )
}
