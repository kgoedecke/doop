import { bleedSheet } from './bleed'
import { replayScript } from './replay'
import { stillSheet, vCursorSheet, vOutlineSheet, vSheet } from './sheets'
import { serializeText } from './text'

/* The document as the design wrote it: the runtime's own marks, tags and
   sheets taken out of a copy, for the editor's save path and for an image
   export of what the person sees. */

/* strip the runtime's own marks from a clone of the document */
function cleanClone(root: HTMLElement): HTMLElement {
  serializeText(root)
  // Remove only our pending loader's clone, preserving design-owned attributes.
  if (replayScript && replayScript.parentNode === document.documentElement) {
    const replayIndex = Array.prototype.indexOf.call(document.documentElement.childNodes, replayScript)
    ;(root.childNodes[replayIndex] as ChildNode).remove()
  }
  const boot = root.querySelector('script[data-v-boot]')
  if (boot && boot.parentNode) boot.parentNode.removeChild(boot)
  const es = root.querySelector('style[data-v-edit]')
  if (es && es.parentNode) es.parentNode.removeChild(es)
  for (const ran of root.querySelectorAll('[data-v-ran]')) ran.removeAttribute('data-v-ran')
  for (const marked of root.querySelectorAll('[data-v-active],[data-v-hover]')) {
    marked.removeAttribute('contenteditable')
    marked.removeAttribute('data-v-active')
    marked.removeAttribute('data-v-hover')
  }
  root.querySelectorAll('[data-v-path-hidden]').forEach((el) => {
    el.removeAttribute('data-v-path-hidden')
  })
  root.querySelectorAll('[data-v-proto-flash]').forEach((el) => {
    el.removeAttribute('data-v-proto-flash')
  })
  root.style.removeProperty('zoom') // crisp-render zoom is ours, not the design's
  if (!root.getAttribute('style')) root.removeAttribute('style')
  return root
}

export function serialize(): string {
  return '<!doctype html>\n' + cleanClone(document.documentElement.cloneNode(true) as HTMLElement).outerHTML
}

function rulesText(sheet: CSSStyleSheet): string | null {
  try {
    const out: string[] = []
    for (const rule of sheet.cssRules) out.push(rule.cssText)
    return out.join('\n')
  } catch {
    return null // a cross-origin sheet keeps its rules to itself
  }
}

/* the runtime's own adopted sheets, which an export leaves out */
function isOwnSheet(sheet: CSSStyleSheet): boolean {
  return (
    sheet === vSheet ||
    sheet === vOutlineSheet ||
    sheet === vCursorSheet ||
    sheet === bleedSheet ||
    sheet === stillSheet
  )
}

/* The document for an image export: what the engine shows that a copy of
   the HTML loses is captured onto the clone first — the pixels of every
   <canvas>, the source the browser picked for each <img>, and the rules
   of every stylesheet as the CSSOM holds them (insertRule, adopted
   sheets), and an image at an object URL as its bytes, which only this
   document can read. Resolves null when a canvas will not give up its
   pixels (tainted) or a blob cannot be read, so the parent lets the
   server render instead. Live and clone are walked by the same
   selectors, so they pair by index. */
export function exportSnapshot(): Promise<string | null> {
  const live = document.documentElement
  const root = live.cloneNode(true) as HTMLElement
  const reads: Promise<void>[] = []
  const imgs = live.querySelectorAll('img')
  const imgClones = root.querySelectorAll('img')
  for (let i = 0; i < imgs.length; i++) {
    const clone = imgClones[i]!
    const src = imgs[i]!.currentSrc
    if (src) clone.setAttribute('src', src)
    clone.removeAttribute('srcset')
    clone.removeAttribute('sizes')
    /* an object URL names bytes only this document can reach */
    if (src && src.indexOf('blob:') === 0) reads.push(readBlobUrl(src, clone))
  }
  root.querySelectorAll('picture > source').forEach((source) => {
    source.remove()
  })
  const canvases = live.querySelectorAll('canvas')
  const canvasClones = root.querySelectorAll('canvas')
  for (let c = 0; c < canvases.length; c++) {
    const painted = document.createElement('img')
    try {
      painted.setAttribute('src', canvases[c]!.toDataURL())
    } catch {
      return Promise.resolve(null)
    }
    for (const attr of canvasClones[c]!.attributes) painted.setAttribute(attr.name, attr.value)
    canvasClones[c]!.replaceWith(painted)
  }
  const styles = live.querySelectorAll('style')
  const styleClones = root.querySelectorAll('style')
  const links = live.querySelectorAll('link')
  const linkClones = root.querySelectorAll('link')
  for (const sheet of document.styleSheets) {
    const owner = sheet.ownerNode
    const text = owner ? rulesText(sheet) : null
    if (text === null) continue
    if (owner!.nodeName === 'STYLE') {
      const styleClone = styleClones[Array.prototype.indexOf.call(styles, owner)]
      if (styleClone) styleClone.textContent = text
    } else if (owner!.nodeName === 'LINK') {
      const linkClone = linkClones[Array.prototype.indexOf.call(links, owner)]
      if (!linkClone) continue
      const inlined = document.createElement('style')
      const media = (owner as HTMLLinkElement).media
      if (media) inlined.setAttribute('media', media)
      inlined.textContent = text
      linkClone.replaceWith(inlined)
    }
  }
  for (const sheet of document.adoptedStyleSheets || []) {
    if (isOwnSheet(sheet)) continue // the runtime's own
    const adoptedText = rulesText(sheet)
    if (adoptedText === null) continue
    const adoptedStyle = document.createElement('style')
    adoptedStyle.textContent = adoptedText
    ;(root.querySelector('head') || root).appendChild(adoptedStyle)
  }
  /* cleaned now, while live and clone still match (a replay retry could
     add its loader to the live document during the reads); the reads only
     set src on image clones the cleaning leaves alone */
  cleanClone(root)
  return Promise.all(reads).then(
    () => '<!doctype html>\n' + root.outerHTML,
    () => null,
  )
}

function readBlobUrl(src: string, clone: Element): Promise<void> {
  return fetch(src)
    .then((res) => res.blob())
    .then(
      (blob) =>
        new Promise<void>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => {
            clone.setAttribute('src', reader.result as string)
            resolve()
          }
          reader.onerror = () => {
            reject(reader.error ?? new Error('the image could not be read'))
          }
          reader.readAsDataURL(blob)
        }),
    )
}
