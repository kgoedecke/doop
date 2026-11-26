import { syncPathVisibility } from './paths'
import { replayScript } from './replay'
import { holdStill, releaseStill } from './sheets'
import { rebaseStyleEdits } from './styles'

/* The parent posts HTML in and the runtime morphs the live DOM to match:
   only changed elements are touched, so updates render in place with no
   white reload flash. */

function syncAttrs(from: Element, to: Element): void {
  for (let i = from.attributes.length - 1; i >= 0; i--) {
    const name = from.attributes[i]!.name
    if (name === 'data-v-ran') continue
    if (!to.hasAttribute(name)) from.removeAttribute(name)
  }
  for (const a of to.attributes) {
    if (from.getAttribute(a.name) !== a.value) from.setAttribute(a.name, a.value)
  }
}

function isOpaque(el: Element): boolean {
  // subtrees we swap wholesale instead of walking
  const n = el.nodeName
  return n === 'STYLE' || n === 'TEXTAREA' || n === 'IFRAME' || el.namespaceURI !== 'http://www.w3.org/1999/xhtml'
}

function morphChildren(from: Node, to: Node): void {
  const tc = to.childNodes
  for (let i = 0; i < tc.length; i++) {
    const t = tc[i]!
    const f = from.childNodes[i]
    if (!f) {
      from.appendChild(document.importNode(t, true))
      continue
    }
    if (f.nodeType !== t.nodeType || (f.nodeType === 1 && f.nodeName !== t.nodeName)) {
      from.replaceChild(document.importNode(t, true), f)
      continue
    }
    if (t.nodeType === 3 || t.nodeType === 8) {
      if (f.nodeValue !== t.nodeValue) f.nodeValue = t.nodeValue
      continue
    }
    if (t.nodeType === 1) {
      const fe = f as Element
      const te = t as Element
      syncAttrs(fe, te)
      if (fe.nodeName === 'SCRIPT') {
        if (fe.textContent !== te.textContent) {
          fe.textContent = te.textContent
          fe.removeAttribute('data-v-ran') // changed script: re-execute
        }
      } else if (isOpaque(fe)) {
        if (fe.innerHTML !== te.innerHTML) fe.innerHTML = te.innerHTML
      } else {
        morphChildren(fe, te)
      }
    }
  }
  while (from.childNodes.length > tc.length) from.removeChild(from.lastChild!)
}

/* cloned/imported script nodes never execute — swap in fresh ones */
function activateScripts(): void {
  for (const old of document.querySelectorAll('script:not([data-v-ran]):not([data-v-boot])')) {
    if (old === replayScript) continue
    const s = document.createElement('script')
    for (const attr of old.attributes) s.setAttribute(attr.name, attr.value)
    s.textContent = old.textContent
    s.setAttribute('data-v-ran', '1')
    old.parentNode!.replaceChild(s, old)
  }
}

export function render(html: string): void {
  holdStill()
  try {
    morph(html)
  } finally {
    releaseStill()
  }
}

function morph(html: string): void {
  let doc: Document | undefined
  try {
    doc = new DOMParser().parseFromString(html, 'text/html')
    syncAttrs(document.documentElement, doc.documentElement)
    /* the body's own attributes carry whole design systems (<body class="glaze">
       with every rule scoped under .glaze) — morphing only its children left
       those designs unstyled on the canvas */
    syncAttrs(document.body, doc.body)
    morphChildren(document.head, doc.head)
    morphChildren(document.body, doc.body)
    activateScripts()
    syncPathVisibility()
  } catch {
    if (doc) document.documentElement.innerHTML = doc.documentElement.innerHTML
  }
  rebaseStyleEdits()
}
