/* global DOMParser */
// Runs in an isolated WKWebView world against an inert DOMParser document.
// Frame scripts are never loaded or executed. ID remapping mirrors src/lib/layers.ts.
globalThis.doopEditSelection = function (html, selector, action, markup) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const matches = selector ? doc.querySelectorAll(selector) : [doc.body]
  if (matches.length > 1)
    throw new Error('This selector matches more than one element. Select the whole frame instead.')
  const element = matches[0]
  if (!element) throw new Error('This element has changed. Select it again.')
  if (action === 'copy') return element.outerHTML
  if (element.closest('[data-doop-locked]')) throw new Error('Unlock this element before editing it.')
  if (!doc.body.contains(element)) throw new Error('Select an element inside the frame.')
  if (element === doc.body && action !== 'paste')
    throw new Error('Select an element inside the frame, or select the whole frame from Frames.')

  if (action === 'delete') {
    element.remove()
  } else {
    const parent = element === doc.body ? doc.body : element.parentElement
    const source = parent.cloneNode(false)
    source.innerHTML = action === 'duplicate' ? element.outerHTML : markup
    if (
      source.children.length !== 1 ||
      [...source.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim())
    ) {
      throw new Error('Copy one element before pasting it into a frame.')
    }
    const copy = source.firstElementChild
    const renamed = new Map()
    const taken = new Set()
    for (const node of [copy, ...copy.querySelectorAll('[id]')].filter((node) => node.id)) {
      let next = `${node.id}-copy`
      for (let n = 2; doc.getElementById(next) || taken.has(next); n++) next = `${node.id}-copy-${n}`
      renamed.set(node.id, next)
      taken.add(next)
      node.id = next
    }
    const rename = (id) => renamed.get(id) ?? id
    const references = new Set([
      'for',
      'form',
      'list',
      'headers',
      'aria-labelledby',
      'aria-describedby',
      'aria-controls',
      'aria-owns',
      'aria-activedescendant',
      'aria-details',
      'aria-errormessage',
      'aria-flowto',
    ])
    const urls = (value) =>
      value.replace(/url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g, (_, quote, id) => `url(${quote}#${rename(id)}${quote})`)
    for (const node of [copy, ...copy.querySelectorAll('*')]) {
      for (const { name, value } of [...node.attributes]) {
        let next = value
        if ((name === 'href' || name === 'xlink:href') && value.startsWith('#')) next = `#${rename(value.slice(1))}`
        else if (references.has(name)) next = value.replace(/\S+/g, rename)
        node.setAttribute(name, urls(next))
      }
      if (node.localName === 'style') node.textContent = urls(node.textContent)
    }
    if (element === doc.body) element.append(copy)
    else element.after(copy)
    // Table and SVG fragments must survive the same parse the renderer will do.
    const next = '<!doctype html>\n' + doc.documentElement.outerHTML
    const parsed = new DOMParser().parseFromString(next, 'text/html')
    const path = []
    for (let node = copy; node && node !== doc.body; node = node.parentElement) {
      const siblings = [...node.parentElement.children].filter((sibling) => sibling.tagName === node.tagName)
      path.unshift(`${node.localName}:nth-of-type(${siblings.indexOf(node) + 1})`)
    }
    if (parsed.querySelector('body > ' + path.join(' > '))?.outerHTML !== copy.outerHTML) {
      throw new Error('This element cannot be pasted here.')
    }
    return next
  }
  return '<!doctype html>\n' + doc.documentElement.outerHTML
}
