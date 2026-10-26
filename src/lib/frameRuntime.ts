import { FRAME_REPLAY_RUNTIME } from './frameReplayRuntime'
import { FRAME_DROP_RUNTIME } from './frameDropRuntime'
import { FRAME_PROTO_RUNTIME } from './frameProtoRuntime'

/**
 * Bootstrap document loaded once per frame iframe. The parent posts HTML in
 * via postMessage and the runtime morphs the live DOM to match — only changed
 * elements are touched, so updates render in place with no white reload flash.
 * Works inside sandbox="allow-scripts" (no same-origin access needed).
 */
export const FRAME_BOOTSTRAP = `<!doctype html>
<html><head></head><body><script data-v-boot>
(function () {
  ${FRAME_REPLAY_RUNTIME}
  ${FRAME_DROP_RUNTIME}
  ${FRAME_PROTO_RUNTIME}
  /* horizontal overscroll inside a frame must not chain to the parent page,
     where the browser turns it into a history back/forward swipe. Adopted
     sheet, not a <style> tag — the morph would wipe a tag from <head>. */
  try {
    var vSheet = new CSSStyleSheet()
    vSheet.replaceSync('html,body{overscroll-behavior-x:none}[data-v-path-hidden]{visibility:hidden!important}')
    document.adoptedStyleSheets = document.adoptedStyleSheets.concat(vSheet)
  } catch (e) {}
  function syncAttrs(from, to) {
    for (var i = from.attributes.length - 1; i >= 0; i--) {
      var name = from.attributes[i].name
      if (name === 'data-v-ran') continue
      if (!to.hasAttribute(name)) from.removeAttribute(name)
    }
    for (var j = 0; j < to.attributes.length; j++) {
      var a = to.attributes[j]
      if (from.getAttribute(a.name) !== a.value) from.setAttribute(a.name, a.value)
    }
  }

  function isOpaque(el) {
    // subtrees we swap wholesale instead of walking
    var n = el.nodeName
    return n === 'STYLE' || n === 'TEXTAREA' || n === 'IFRAME' || el.namespaceURI !== 'http://www.w3.org/1999/xhtml'
  }

  function morphChildren(from, to) {
    var tc = to.childNodes
    for (var i = 0; i < tc.length; i++) {
      var t = tc[i]
      var f = from.childNodes[i]
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
        syncAttrs(f, t)
        if (f.nodeName === 'SCRIPT') {
          if (f.textContent !== t.textContent) {
            f.textContent = t.textContent
            f.removeAttribute('data-v-ran') // changed script: re-execute
          }
        } else if (isOpaque(f)) {
          if (f.innerHTML !== t.innerHTML) f.innerHTML = t.innerHTML
        } else {
          morphChildren(f, t)
        }
      }
    }
    while (from.childNodes.length > tc.length) from.removeChild(from.lastChild)
  }

  /* cloned/imported script nodes never execute — swap in fresh ones */
  function activateScripts() {
    var scripts = document.querySelectorAll('script:not([data-v-ran]):not([data-v-boot])')
    for (var i = 0; i < scripts.length; i++) {
      var old = scripts[i]
      if (old === replayScript) continue
      var s = document.createElement('script')
      for (var j = 0; j < old.attributes.length; j++) s.setAttribute(old.attributes[j].name, old.attributes[j].value)
      s.textContent = old.textContent
      s.setAttribute('data-v-ran', '1')
      old.parentNode.replaceChild(s, old)
    }
  }

  function render(html) {
    var doc
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
    } catch (e) {
      if (doc) document.documentElement.innerHTML = doc.documentElement.innerHTML
    }
    // Remote HTML becomes the cancellation baseline; keep our preview visible.
    if (styleEdit) {
      var target = styleTarget(styleEdit.selector)
      if (target) {
        styleEdit.original = target.style.cssText
        styleEdit.touched = {}
        previewStyle(target, styleEdit.styles)
      }
    }
  }

  /* ---- inline text editing ----
     The parent flips edit mode on. Instead of designMode (which makes the
     whole document a caret trap), we hit-test: hovering a text-bearing
     element outlines it, clicking makes JUST that element editable with the
     caret placed at the click point. Edits debounce-serialize back to the
     parent, which saves them through the normal frame-update path. */
  var editing = false
  var activeEl = null
  var editTimer = null

  var EDIT_CSS =
    '[data-v-hover]{outline:1.5px dashed rgba(39,67,238,0.75)!important;outline-offset:2px;cursor:text}' +
    '[data-v-active]{outline:2px solid rgba(39,67,238,0.9)!important;outline-offset:2px;cursor:text}' +
    '[data-v-active]:focus{outline:2px solid rgba(39,67,238,0.9)!important}'

  function hasOwnText(el) {
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 && n.nodeValue.replace(/[\\s\\u00a0]+/g, '')) return true
    }
    return false
  }

  /* a locked element, or anything inside a locked box, is off limits to the
     stage: not hovered, not picked, not edited (src/lib/layers.ts LOCK_ATTR) */
  var LOCKED = '[data-doop-locked]'
  function isLocked(el) {
    return !!(el && el.closest && el.closest(LOCKED))
  }

  /* nearest ancestor (incl. self) that directly contains visible text */
  function candidate(start) {
    var el = start && start.nodeType === 3 ? start.parentElement : start
    if (isLocked(el)) return null
    while (el && el !== document.body && el !== document.documentElement) {
      if (hasOwnText(el)) return el
      el = el.parentElement
    }
    return null
  }

  function clearHover() {
    var h = document.querySelector('[data-v-hover]')
    if (h) h.removeAttribute('data-v-hover')
  }

  function deactivate() {
    if (!activeEl) return
    activeEl.removeAttribute('contenteditable')
    activeEl.removeAttribute('data-v-active')
    activeEl = null
    postActive()
  }

  /* tell the parent which element is selected for editing, so it can anchor
     the element toolbar (comment etc.) to it */
  function activeInfo() {
    return activeEl ? hitInfo(activeEl) : null
  }

  function postActive() {
    parent.postMessage({ type: 'doop:active', hit: activeInfo() }, '*')
  }

  function placeCaret(x, y) {
    var r = null
    if (document.caretRangeFromPoint) {
      r = document.caretRangeFromPoint(x, y)
    } else if (document.caretPositionFromPoint) {
      var p = document.caretPositionFromPoint(x, y)
      if (p) { r = document.createRange(); r.setStart(p.offsetNode, p.offset); r.collapse(true) }
    }
    if (r) {
      var s = getSelection()
      s.removeAllRanges()
      s.addRange(r)
    }
  }

  function activate(el, x, y, keepSelection) {
    if (activeEl !== el) {
      deactivate()
      activeEl = el
      el.removeAttribute('data-v-hover')
      el.setAttribute('data-v-active', '1')
      try { el.contentEditable = 'plaintext-only' } catch (e) { el.contentEditable = 'true' }
      el.focus({ preventScroll: true })
      postActive()
    }
    /* double/triple clicks carry a native word/paragraph selection —
       placing a caret here would collapse it the instant it appears */
    if (!keepSelection) placeCaret(x, y)
  }

  function serialize() {
    var root = document.documentElement.cloneNode(true)
    // Remove only our pending loader's clone, preserving design-owned attributes.
    if (replayScript && replayScript.parentNode === document.documentElement) {
      var replayIndex = Array.prototype.indexOf.call(document.documentElement.childNodes, replayScript)
      root.childNodes[replayIndex].remove()
    }
    var boot = root.querySelector('script[data-v-boot]')
    if (boot && boot.parentNode) boot.parentNode.removeChild(boot)
    var es = root.querySelector('style[data-v-edit]')
    if (es && es.parentNode) es.parentNode.removeChild(es)
    var ran = root.querySelectorAll('[data-v-ran]')
    for (var i = 0; i < ran.length; i++) ran[i].removeAttribute('data-v-ran')
    var marked = root.querySelectorAll('[data-v-active],[data-v-hover]')
    for (var j = 0; j < marked.length; j++) {
      marked[j].removeAttribute('contenteditable')
      marked[j].removeAttribute('data-v-active')
      marked[j].removeAttribute('data-v-hover')
    }
    root.querySelectorAll('[data-v-path-hidden]').forEach(function (el) { el.removeAttribute('data-v-path-hidden') })
    root.querySelectorAll('[data-v-proto-flash]').forEach(function (el) { el.removeAttribute('data-v-proto-flash') })
    root.style.removeProperty('zoom') // crisp-render zoom is ours, not the design's
    if (!root.getAttribute('style')) root.removeAttribute('style')
    return '<!doctype html>\\n' + root.outerHTML
  }

  function postEdited(discrete) {
    parent.postMessage({ type: 'doop:edited', html: serialize(), discrete: discrete === true }, '*')
    /* typing can move/grow the element — keep the parent's toolbar anchored */
    if (editing && activeEl) postActive()
  }

  function setEdit(on) {
    if (on === editing) return
    editing = on
    if (on) {
      var st = document.createElement('style')
      st.setAttribute('data-v-edit', '')
      st.textContent = EDIT_CSS
      document.head.appendChild(st)
    } else {
      if (editTimer) { clearTimeout(editTimer); editTimer = null }
      deactivate()
      clearHover()
      var st2 = document.querySelector('style[data-v-edit]')
      if (st2 && st2.parentNode) st2.parentNode.removeChild(st2)
      postEdited() // flush the final state before renders resume
    }
  }

  /* capture-phase: no link navigation or button handlers while editing */
  document.addEventListener('click', function (ev) {
    if (!editing) return
    ev.preventDefault()
    ev.stopPropagation()
    var el = candidate(ev.target)
    if (el) activate(el, ev.clientX, ev.clientY, ev.detail > 1)
    else deactivate()
  }, true)

  document.addEventListener('mousemove', function (ev) {
    if (!editing) return
    var el = candidate(ev.target)
    var prev = document.querySelector('[data-v-hover]')
    if (prev && prev !== el) prev.removeAttribute('data-v-hover')
    if (el && el !== activeEl) el.setAttribute('data-v-hover', '1')
  }, true)

  document.addEventListener('input', function () {
    if (!editing) return
    if (editTimer) clearTimeout(editTimer)
    editTimer = setTimeout(postEdited, 400)
  })

  document.addEventListener('contextmenu', function (ev) {
    if (!editing) return
    ev.preventDefault()
    ev.stopPropagation()
    setEdit(false)
    parent.postMessage({ type: 'doop:edit-esc' }, '*')
    parent.postMessage({ type: 'doop:context-menu', x: ev.clientX, y: ev.clientY }, '*')
  }, true)

  /* Escape pressed with focus inside the frame: the parent never sees the
     key event itself, so relay it (present mode closes on it) */
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape') return
    if (protoOn && ev.defaultPrevented) return // the design's own script took it
    if (editing) {
      setEdit(false)
      parent.postMessage({ type: 'doop:edit-esc' }, '*')
    } else {
      parent.postMessage({ type: 'doop:esc' }, '*')
    }
  })

  /* ---- element probe + locate (comments) ----
     The parent can't see into this sandboxed document, so it asks: probe
     resolves the element at a point (for the click toolbar), locate finds a
     stored selector again (to place comment pins). Coordinates cross the
     boundary in design px, which are this document's own CSS px: the
     canvas zoom stays outside (the iframe element undoes the world's CSS
     zoom), so in here the viewport, vh/vw and every rect stay at design size. */

  function cssPath(el) {
    var parts = []
    while (el && el.nodeType === 1 && el !== document.documentElement) {
      if (el.id) { parts.unshift('#' + CSS.escape(el.id)); break }
      var tag = el.tagName.toLowerCase()
      var nth = 1
      for (var s = el.previousElementSibling; s; s = s.previousElementSibling) {
        if (s.tagName === el.tagName) nth++
      }
      parts.unshift(tag + ':nth-of-type(' + nth + ')')
      el = el.parentElement
    }
    return parts.join(' > ')
  }

  function designRect(el) {
    var r = el.getBoundingClientRect()
    return { x: r.left, y: r.top, width: r.width, height: r.height }
  }

  /* Elements whose box takes a width/height: everything but inline text
     boxes. Replaced inline elements (an img) still size, so they count. */
  var REPLACED = ['img', 'video', 'canvas', 'svg', 'iframe', 'input', 'select', 'textarea', 'button', 'embed', 'object']
  function sizable(el) {
    var cs = getComputedStyle(el)
    if (cs.display === 'contents' || cs.display === 'none') return false
    /* Screen deltas can only resize boxes whose axes still point right/down.
       Individual transforms and every ancestor contribute to those axes. */
    for (var node = el; node; node = node.parentElement) {
      var transform = getComputedStyle(node)
      if (transform.rotate !== 'none' && parseFloat(transform.rotate.split(/\\s+/).pop()) !== 0) return false
      if (transform.perspective !== 'none' || transform.transform.indexOf('matrix3d') === 0) return false
      if (transform.scale !== 'none') {
        var scales = transform.scale.split(/\\s+/).map(parseFloat)
        if (scales.length > 2 || scales.some(function (value) { return value <= 0 })) return false
      }
      var m = /^matrix\\(([^)]+)\\)$/.exec(transform.transform)
      if (m) {
        var parts = m[1].split(',').map(parseFloat)
        if (parts[0] <= 0 || parts[3] <= 0 || Math.abs(parts[1]) > 1e-6 || Math.abs(parts[2]) > 1e-6) return false
      }
    }
    return cs.display !== 'inline' || REPLACED.indexOf(el.tagName.toLowerCase()) !== -1
  }

  /* how far the rendered box is from the layout box: the element's own and
     its ancestors' scale, which a drag's pointer delta has to be divided by */
  function renderScale(el, rect) {
    var w = el.offsetWidth
    var h = el.offsetHeight
    return { x: w > 0 && rect.width > 0 ? rect.width / w : 1, y: h > 0 && rect.height > 0 ? rect.height / h : 1 }
  }

  function hitInfo(el) {
    var snippet = el.outerHTML || ''
    if (snippet.length > 400) snippet = snippet.slice(0, 397) + '...'
    return {
      selector: cssPath(el),
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
      snippet: snippet,
      rect: designRect(el),
      /* the stage's resize grips: shown only where a drag can change the box */
      sizable: sizable(el),
      locked: isLocked(el),
    }
  }

  /* Ask the browser which element is actually on top, including stacking
     contexts, clipping, and transformed hit regions. Keep layout dimensions
     separate from the rendered rectangle so a move does not apply scale twice. */
  function drawingHit(x, y, standalone, selected) {
    var top = elementAt(x, y)
    var el = standalone ? document.body.firstElementChild : top && top.closest('[data-doop-drawing]')
    if (!el || !el.matches('[data-doop-drawing]') || isLocked(el)) return null
    var picked = styleTarget(selected)
    if (!standalone && picked && picked !== el && picked.contains(el) && elementGeometry(picked).enabled) return null
    var rect = designRect(el)
    var css = getComputedStyle(el)
    var width = parseFloat(css.width)
    var height = parseFloat(css.height)
    if (!isFinite(width) || !isFinite(height)) return null
    var styles = {}
    var properties = ['transform', 'transform-origin', 'translate', 'rotate', 'scale', 'box-sizing']
    properties.forEach(function (key) { styles[key] = css.getPropertyValue(key) })
    var originalStyle = el.getAttribute('style')
    var untransformed
    try {
      // This measurement is synchronous; the temporary styles never paint.
      ;['transform', 'translate', 'rotate', 'scale', 'transition'].forEach(function (key) {
        el.style.setProperty(key, 'none', 'important')
      })
      untransformed = designRect(el)
    } finally {
      if (originalStyle === null) el.removeAttribute('style')
      else el.setAttribute('style', originalStyle)
    }
    return {
      selector: cssPath(el), rect: rect,
      geometry: { width: width, height: height, offsetX: rect.x - untransformed.x,
        offsetY: rect.y - untransformed.y, styles: styles },
    }
  }

  var pathEditingSelector = null
  function syncPathVisibility() {
    document.querySelectorAll('[data-v-path-hidden]').forEach(function (el) { el.removeAttribute('data-v-path-hidden') })
    if (pathEditingSelector) {
      var pathSvg = document.querySelector(pathEditingSelector)
      if (pathSvg) pathSvg.setAttribute('data-v-path-hidden', '')
    }
  }
  function pathInfo(d) {
    var hit = d.selector ? document.querySelector(d.selector) : d.standalone ? document.body.firstElementChild : elementAt(d.x, d.y)
    var svg = hit && hit.closest('svg[data-doop-drawing="path"]')
    var path = svg && svg.querySelector('path')
    // Native pen paths have one direct path child. Other SVG artwork keeps its normal editor.
    if (!svg || svg.parentElement !== document.body || !path || path.parentElement !== svg || svg.querySelectorAll('path').length !== 1 || isLocked(svg)) return null
    var matrix = path.getScreenCTM()
    if (!matrix || Math.abs(matrix.a * matrix.d - matrix.b * matrix.c) < 1e-9) return null
    var probe = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    probe.setAttribute('viewBox', '0 0 1 1')
    probe.style.cssText = 'position:fixed!important;left:0!important;top:0!important;width:1px!important;height:1px!important;margin:0!important;padding:0!important;border:0!important;transform:none!important;translate:none!important;rotate:none!important;scale:none!important;visibility:hidden!important'
    var layout
    try {
      document.body.appendChild(probe)
      layout = probe.getScreenCTM().inverse().multiply(matrix)
    } finally { probe.remove() }
    var css = getComputedStyle(path)
    return {
      selector: cssPath(svg), data: path.getAttribute('d'),
      matrix: [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f],
      layoutMatrix: [layout.a, layout.b, layout.c, layout.d, layout.e, layout.f],
      paint: { fill: css.fill, stroke: css.stroke, strokeWidth: css.strokeWidth },
    }
  }

  /* the topmost unlocked element under a design-space point: a click on a
     locked element falls through to whatever sits beneath it, as in Figma */
  function elementAt(x, y) {
    var stack = document.elementsFromPoint(x, y)
    for (var i = 0; i < stack.length; i++) {
      var el = stack[i]
      if (el === document.documentElement || el === document.body) return null
      if (!isLocked(el)) return el
    }
    return null
  }

  function probe(x, y) {
    var el = elementAt(x, y)
    if (el) el = el.closest('[data-doop-drawing]') || el
    return el ? hitInfo(el) : null
  }

  /* Right-click can reach a lock so the menu can unlock it. SVGs are one
     layer in the rail, and their paths share that same context menu. */
  function contextHit(x, y) {
    var el = document.elementFromPoint(x, y)
    if (!el || el === document.body || el === document.documentElement) return null
    el = el.closest('[data-doop-locked]') || el.closest('[data-doop-drawing]') || el.closest('svg') || el
    return hitInfo(el)
  }

  function moveHit(x, y, selected) {
    var el = elementAt(x, y)
    var picked = styleTarget(selected)
    // A selected group moves as a whole even when the press hits a child.
    if (el && picked && picked.contains(el) && !isLocked(picked)) el = picked
    while (el && el !== document.body && el !== document.documentElement) {
      if (elementGeometry(el).enabled) return hitInfo(el)
      // Inline text and SVG paths move with their containing box/SVG.
      el = el.parentElement
    }
    return null
  }

  /* the Layers panel selects by selector rather than by point */
  function describe(selector) {
    var el = null
    try { el = selector ? document.querySelector(selector) : null } catch (e) { /* bad selector */ }
    if (!el || el === document.documentElement || el === document.body) return null
    return hitInfo(el)
  }

  /* hover inspection: like probe but fired on every (throttled) pointer move,
     so it skips the outerHTML/selector work and returns just tag + rect */
  function hoverProbe(x, y) {
    var el = elementAt(x, y)
    return el ? { tag: el.tagName.toLowerCase(), rect: designRect(el) } : null
  }

  /* full source of one element, with runtime markers stripped */
  function elementCode(selector) {
    var el = null
    try { el = selector ? document.querySelector(selector) : null } catch (e) { /* bad selector */ }
    if (!el) return null
    var c = el.cloneNode(true)
    var nodes = [c].concat(Array.prototype.slice.call(c.querySelectorAll('*')))
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].removeAttribute('data-v-ran')
      nodes[i].removeAttribute('data-v-hover')
      nodes[i].removeAttribute('data-v-active')
      nodes[i].removeAttribute('contenteditable')
    }
    var html = c.outerHTML
    if (html.length > 20000) html = html.slice(0, 20000) + '\\n<!-- truncated -->'
    return html
  }

  /* ---- element properties (the Design panel) ----
     The panel cannot read computed styles across the sandbox, so it asks for
     a summary of one element and writes changes back as inline styles; the
     edited document then goes to the parent through the usual save path. */
  function notifyFrameUpdated() {
    parent.postMessage({ type: 'doop:frame-updated' }, '*')
  }
  document.fonts.addEventListener('loadingdone', notifyFrameUpdated)
  /* A linked sheet can declare unused faces without loading any font files.
     Capture its non-bubbling load event, including links added by later renders. */
  document.addEventListener('load', function (ev) {
    var el = ev.target
    if (el && (el.tagName === 'IMG' || (el.tagName === 'LINK' && el.relList.contains('stylesheet')))) notifyFrameUpdated()
  }, true)

  function px(v) {
    var n = parseFloat(v)
    return isNaN(n) ? null : Math.round(n * 100) / 100
  }

  function parentBounds(el) {
    var p = el.parentElement
    // The body's containing canvas is the viewport, even when all children are absolute.
    return p === document.body || !p || p === document.documentElement
      ? { x: 0, y: 0, width: innerWidth, height: innerHeight }
      : designRect(p)
  }

  function elementGeometry(el) {
    var cs = getComputedStyle(el)
    var rect = designRect(el)
    var bounds = parentBounds(el)
    var matrix = new DOMMatrix(cs.transform === 'none' ? undefined : cs.transform)
    var rotation = cs.rotate === 'none' ? 0 : parseFloat(cs.rotate)
    var scale = cs.scale === 'none' ? [1, 1] : cs.scale.split(' ').map(Number)
    var enabled = !isLocked(el) && matrix.is2D && (cs.rotate === 'none' || /^-?[\\d.]+deg$/.test(cs.rotate))
      && scale.length <= 2 && (cs.display !== 'inline' || /^(IMG|VIDEO|IFRAME|CANVAS|OBJECT|EMBED)$/.test(el.tagName) || el instanceof SVGSVGElement)
      && cs.display !== 'contents' && cs.display !== 'none'
      && (el instanceof HTMLElement || el instanceof SVGSVGElement)
    // A perspective ancestor makes translation non-linear; don't offer 2D geometry there.
    for (var p = el.parentElement; enabled && p; p = p.parentElement) {
      var ps = getComputedStyle(p)
      if (ps.perspective !== 'none' || !new DOMMatrix(ps.transform === 'none' ? undefined : ps.transform).is2D
        || (ps.rotate !== 'none' && !/^-?[\\d.]+deg$/.test(ps.rotate))) enabled = false
    }
    return {
      x: px(String(rect.x - bounds.x)), y: px(String(rect.y - bounds.y)),
      rotation: px(String(rotation + Math.atan2(matrix.b, matrix.a) * 180 / Math.PI)),
      scaleX: scale[0], scaleY: scale[1] === undefined ? scale[0] : scale[1],
      enabled: enabled, canAlign: enabled && el !== document.body && !!el.parentElement,
    }
  }

  function editGeometry(selector, edit) {
    var el = null
    try { el = selector ? document.querySelector(selector) : null } catch (e) {}
    if (!el || el === document.documentElement || isLocked(el) || !edit) return false
    var geometry = elementGeometry(el)
    if (!geometry.enabled) return false
    var cs = getComputedStyle(el)
    if (edit.kind === 'rotate' && isFinite(edit.value)) {
      var current = cs.rotate === 'none' ? 0 : parseFloat(cs.rotate)
      return applyStyle(selector, { rotate: (current + edit.value - geometry.rotation) + 'deg' })
    }
    if (edit.kind === 'flip' && (edit.axis === 'x' || edit.axis === 'y')) {
      return applyStyle(selector, { scale: (geometry.scaleX * (edit.axis === 'x' ? -1 : 1)) + ' '
        + (geometry.scaleY * (edit.axis === 'y' ? -1 : 1)) })
    }
    var rect = designRect(el)
    var dx = 0, dy = 0
    if (edit.kind === 'move' && isFinite(edit.x) && isFinite(edit.y)) {
      dx = edit.x - rect.x
      dy = edit.y - rect.y
    } else {
      var axis = edit.axis
      if (axis !== 'x' && axis !== 'y') return false
      var bounds = parentBounds(el)
      var target
      if (edit.kind === 'position' && isFinite(edit.value)) target = bounds[axis] + edit.value
      else if (edit.kind === 'align' && geometry.canAlign) {
        var size = axis === 'x' ? 'width' : 'height'
        var fraction = { start: 0, center: 0.5, end: 1 }[edit.edge]
        if (fraction === undefined) return false
        target = bounds[axis] + (bounds[size] - rect[size]) * fraction
      } else return false
      dx = axis === 'x' ? target - rect.x : 0
      dy = axis === 'y' ? target - rect.y : 0
    }
    // Probe the local translation basis. This handles scaled/rotated ancestors and
    // percentage translations without flattening the element's existing transform.
    // All temporary styles are restored synchronously, before painting or saving.
    var original = el.getAttribute('style')
    var finalTranslate = null
    var zero, right, down
    var translate = cs.translate.match(/calc\\([^)]*\\)|[^\\s]+/g) || []
    var z = translate.length === 3 ? ' ' + translate[2] : ''
    try {
      el.style.setProperty('transition', 'none', 'important')
      el.style.setProperty('translate', '0px 0px' + z, 'important')
      zero = designRect(el)
      el.style.setProperty('translate', '100px 0px' + z, 'important')
      right = designRect(el)
      el.style.setProperty('translate', '0px 100px' + z, 'important')
      down = designRect(el)
      var a = (right.x - zero.x) / 100, b = (right.y - zero.y) / 100
      var c = (down.x - zero.x) / 100, d = (down.y - zero.y) / 100
      var determinant = a * d - b * c
      if (Math.abs(determinant) >= 0.000001) {
        var x = rect.x + dx - zero.x, y = rect.y + dy - zero.y
        finalTranslate = ((d * x - c * y) / determinant) + 'px '
          + ((a * y - b * x) / determinant) + 'px' + z
      }
    } finally {
      if (original === null) el.removeAttribute('style')
      else el.setAttribute('style', original)
      // Apply through the gesture path so dragging X/Y can save as one edit
      // or restore the original translation on Escape.
      if (finalTranslate !== null) applyStyle(selector, { translate: finalTranslate })
      var settledStyle = el.getAttribute('style')
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

  function dimensionValue(el, axis, cs) {
    // Unlike getComputedStyle's used px size, Typed OM retains stylesheet percentages/auto.
    try { if (el.computedStyleMap) return String(el.computedStyleMap().get(axis)) } catch (e) {}
    return el.style.getPropertyValue(axis) || cs[axis]
  }

  function imageFill(el, cs) {
    if (el.tagName === 'IMG') return { kind: 'img', src: el.currentSrc || el.src || '', size: cs.objectFit, repeat: 'no-repeat' }
    // A single CSS image fill; leave gradients and layered backgrounds intact.
    var match = cs.backgroundImage.match(/^url\\("([^"]*)"\\)$/)
    return match ? { kind: 'background', src: match[1], size: cs.backgroundSize, repeat: cs.backgroundRepeat } : null
  }

  function preserveImageSize(el, cs) {
    // Keep the old intrinsic inputs, not the flex/grid layout's used size.
    // This also works without Typed OM and leaves authored widths, heights,
    // flex factors and responsive constraints in charge of the actual box.
    // Already size-contained images (including earlier replacements) do not
    // derive their layout from the file, so keep their existing overrides.
    var contain = cs.contain
    if (!el.naturalWidth || !el.naturalHeight || contain === 'strict' || contain.split(' ').indexOf('size') !== -1) return
    var ratio = cs.aspectRatio
    if (ratio.indexOf('auto') !== -1) {
      ratio = el.naturalWidth + ' / ' + el.naturalHeight
      // A natural ratio applies to the content box; a CSS ratio follows
      // box-sizing. Preserve the current outer ratio for padded border boxes.
      if (cs.boxSizing === 'border-box' && px(cs.width) > 0 && px(cs.height) > 0) ratio = px(cs.width) + ' / ' + px(cs.height)
    }
    el.style.setProperty('aspect-ratio', ratio, 'important')
    el.style.setProperty('contain-intrinsic-size', el.naturalWidth + 'px ' + el.naturalHeight + 'px', 'important')
    el.style.setProperty('contain', contain === 'none' ? 'size' : contain === 'content' ? 'size layout style paint' : contain + ' size', 'important')
  }

  function replaceImage(selector, expected, url) {
    var el = styleTarget(selector)
    if (!el || isLocked(el) || !expected || typeof url !== 'string' || !url) return false
    var cs = getComputedStyle(el)
    var image = imageFill(el, cs)
    if (!image || image.kind !== expected.kind || image.src !== expected.src) return false
    if (styleEdit) endStyleEdit(styleEdit.selector, false)
    if (styleTimer) { clearTimeout(styleTimer); styleTimer = null; postEdited() }
    if (image.kind === 'img') {
      preserveImageSize(el, cs)
      el.removeAttribute('srcset')
      el.removeAttribute('sizes')
      if (el.parentElement && el.parentElement.tagName === 'PICTURE') {
        el.parentElement.querySelectorAll('source').forEach(function (source) { source.remove() })
      }
      el.src = url
    } else {
      el.style.setProperty('background-image', 'url(' + JSON.stringify(url) + ')', 'important')
    }
    postEdited(true)
    return true
  }

  function inspect(selector) {
    var el = null
    try { el = selector ? document.querySelector(selector) : null } catch (e) { /* bad selector */ }
    if (!el || el === document.documentElement) return null
    var cs = getComputedStyle(el)
    var parentEl = el.parentElement
    var pcs = parentEl ? getComputedStyle(parentEl) : null
    var layoutParent = parentEl
    var layoutStyle = pcs
    while (layoutParent && layoutStyle.display === 'contents') {
      layoutParent = layoutParent.parentElement
      layoutStyle = layoutParent ? getComputedStyle(layoutParent) : null
    }
    var siblings = parentEl ? parentEl.children : [el]
    var index = 0
    for (var i = 0; i < siblings.length; i++) if (siblings[i] === el) index = i + 1
    var inline = {}
    for (var j = 0; j < el.style.length; j++) {
      var name = el.style[j]
      inline[name] = el.style.getPropertyValue(name)
    }
    var classes = (el.getAttribute('class') || '').trim().split(/[ ]+/).filter(Boolean)
    var text = ''
    for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3) text += n.nodeValue
    var fontFamilies = []
    document.fonts.forEach(function (font) {
      if (fontFamilies.indexOf(font.family) === -1) fontFamilies.push(font.family)
    })
    var sides = ['Top', 'Right', 'Bottom', 'Left']
    var drawn = 'Top'
    for (var b = 0; b < sides.length; b++) {
      if (px(cs['border' + sides[b] + 'Width']) > 0 && cs['border' + sides[b] + 'Style'] !== 'none') { drawn = sides[b]; break }
    }
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      classes: classes,
      parent: parentEl && parentEl !== document.documentElement
        ? { tag: parentEl.tagName.toLowerCase(), id: parentEl.id || '', className: (parentEl.getAttribute('class') || '').trim().split(/[ ]+/)[0] || '', display: pcs.display, flexDirection: pcs.flexDirection, writingMode: pcs.writingMode }
        : null,
      layoutParent: layoutStyle
        ? { display: layoutStyle.display, flexDirection: layoutStyle.flexDirection, writingMode: layoutStyle.writingMode }
        : null,
      index: index,
      count: siblings.length,
      inline: inline,
      hasText: text.replace(/\\s+/g, '') !== '',
      rect: designRect(el),
      geometry: elementGeometry(el),
      scale: renderScale(el, designRect(el)),
      position: cs.position,
      display: cs.display,
      flexDirection: cs.flexDirection,
      flexWrap: cs.flexWrap,
      justifyContent: cs.justifyContent,
      alignItems: cs.alignItems,
      writingMode: cs.writingMode,
      width: px(cs.width),
      height: px(cs.height),
      widthValue: dimensionValue(el, 'width', cs),
      heightValue: dimensionValue(el, 'height', cs),
      flexGrow: px(cs.flexGrow),
      boxSizing: cs.boxSizing,
      boxExtras: {
        width: parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth),
        height: parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth),
      },
      aspectRatio: cs.aspectRatio,
      naturalAspectRatio: el.naturalWidth && el.naturalHeight ? el.naturalWidth / el.naturalHeight
        : el.videoWidth && el.videoHeight ? el.videoWidth / el.videoHeight : null,
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
        Math.round(px(cs.borderTopWidth)),
        Math.round(px(cs.borderRightWidth)),
        Math.round(px(cs.borderBottomWidth)),
        Math.round(px(cs.borderLeftWidth)),
      ],
      borderStyle: cs['border' + drawn + 'Style'],
      borderColor: cs['border' + drawn + 'Color'],
      borderRadius: px(cs.borderTopLeftRadius),
      color: cs.color,
      fontSize: px(cs.fontSize),
      fontWeight: cs.fontWeight,
      fontFamily: cs.fontFamily,
      fontFamilies: fontFamilies,
      textAlign: cs.textAlign,
      direction: cs.direction,
    }
  }

  var styleTimer = null
  var styleEdit = null
  function styleTarget(selector) {
    var el = null
    try { el = selector ? document.querySelector(selector) : null } catch (e) { /* bad selector */ }
    return el
  }
  function patchStyle(style, styles, original) {
    for (var k in styles) {
      if (!Object.prototype.hasOwnProperty.call(styles, k)) continue
      if (styles[k] === null || styles[k] === '') style.removeProperty(k)
      else {
        // Returning to a gesture's original value must also restore its priority.
        var priority = original && styles[k] === original.getPropertyValue(k) ? original.getPropertyPriority(k) : ''
        style.setProperty(k, String(styles[k]), priority)
      }
    }
  }
  function previewStyle(el, styles) {
    var before = document.createElement('div').style
    before.cssText = el.style.cssText
    var original = document.createElement('div').style
    original.cssText = styleEdit.original
    patchStyle(el.style, styles, original)
    // CSS enumerates longhands, so padding/border shorthands and !important
    // declarations can be restored without replacing unrelated inline styles.
    var names = {}
    for (var i = 0; i < before.length; i++) names[before[i]] = true
    for (var j = 0; j < el.style.length; j++) names[el.style[j]] = true
    for (var name in names) {
      if (before.getPropertyValue(name) !== el.style.getPropertyValue(name) ||
          before.getPropertyPriority(name) !== el.style.getPropertyPriority(name)) styleEdit.touched[name] = true
    }
  }
  function beginStyleEdit(selector) {
    var el = styleTarget(selector)
    if (!el || isLocked(el)) return false
    if (styleEdit) endStyleEdit(styleEdit.selector, false)
    // Save a previous typed/slider edit before opening this separate action.
    if (styleTimer) {
      clearTimeout(styleTimer)
      styleTimer = null
      postEdited()
    }
    styleEdit = { selector: selector, original: el.style.cssText, styles: {}, touched: {} }
    return true
  }
  function endStyleEdit(selector, cancel) {
    if (!styleEdit || styleEdit.selector !== selector) return false
    var edit = styleEdit
    styleEdit = null
    var el = styleTarget(selector)
    if (!el) return false
    if (cancel) {
      var original = document.createElement('div').style
      original.cssText = edit.original
      for (var name in edit.touched) {
        var value = original.getPropertyValue(name)
        if (value) el.style.setProperty(name, value, original.getPropertyPriority(name))
        else el.style.removeProperty(name)
      }
      if (!el.getAttribute('style')) el.removeAttribute('style')
      if (edit.touched.translate || edit.touched.rotate || edit.touched.scale) {
        // A cancelled geometry drag must report its restored coordinates,
        // rather than the first frame of a transition back to them.
        var restoredStyle = el.getAttribute('style')
        el.style.setProperty('transition', 'none', 'important')
        designRect(el)
        if (restoredStyle === null) el.removeAttribute('style')
        else el.setAttribute('style', restoredStyle)
      }
    } else if (Object.keys(edit.touched).length) postEdited(true)
    return true
  }
  function applyStyle(selector, styles) {
    var el = styleTarget(selector)
    if (!el || isLocked(el)) return false
    if (styleEdit && styleEdit.selector === selector) {
      Object.assign(styleEdit.styles, styles)
      previewStyle(el, styles)
      if (!el.getAttribute('style')) el.removeAttribute('style')
      return true
    }
    patchStyle(el.style, styles)
    if (!el.getAttribute('style')) el.removeAttribute('style')
    /* a slider fires many of these a second — one save once it settles */
    if (styleTimer) clearTimeout(styleTimer)
    styleTimer = setTimeout(function () { styleTimer = null; postEdited() }, 250)
    return true
  }

  window.addEventListener('message', function (ev) {
    /* only the parent drives this document — a script inside the frame must
       not be able to pose as the panel and push edits into the save path */
    if (ev.source !== parent) return
    var d = ev.data
    if (!d) return
    if (d.type === 'doop:inspect') {
      parent.postMessage({ type: 'doop:inspect-result', reqId: d.reqId, info: inspect(d.selector) }, '*')
    }
    if (d.type === 'doop:style' && d.styles && typeof d.styles === 'object') {
      var applied = applyStyle(d.selector, d.styles)
      parent.postMessage({ type: 'doop:style-result', reqId: d.reqId, ok: applied, info: applied ? inspect(d.selector) : null }, '*')
    }
    if (d.type === 'doop:replace-image') {
      var replaced = replaceImage(d.selector, d.image, d.url)
      parent.postMessage({ type: 'doop:replace-image-result', reqId: d.reqId, info: replaced ? inspect(d.selector) : null }, '*')
    }
    if (d.type === 'doop:geometry') {
      var changed = editGeometry(d.selector, d.edit)
      parent.postMessage({ type: 'doop:geometry-result', reqId: d.reqId, ok: changed, info: changed ? inspect(d.selector) : null }, '*')
    }
    if (d.type === 'doop:style-gesture') {
      var changed = d.phase === 'begin' ? beginStyleEdit(d.selector)
        : d.phase === 'commit' || d.phase === 'cancel' ? endStyleEdit(d.selector, d.phase === 'cancel') : false
      parent.postMessage({ type: 'doop:style-gesture-result', reqId: d.reqId, info: changed ? inspect(d.selector) : null }, '*')
    }
    if (d.type === 'doop:html' && typeof d.html === 'string' && !editing) {
      render(d.html)
      notifyFrameUpdated()
      protoHtmlChanged()
      if (d.reqId) parent.postMessage({ type: 'doop:html-result', reqId: d.reqId }, '*')
    }
    if (d.type === 'doop:edit') setEdit(!!d.on)
    // Mirror the Layers eye in the live document, including during text edits.
    if (d.type === 'doop:visibility') {
      var hideEl = null
      try { hideEl = d.selector ? document.querySelector(d.selector) : null } catch (e) { /* bad selector */ }
      if (hideEl && hideEl.hasAttribute('data-doop-hidden') !== !!d.hidden) {
        var hideStyle = hideEl.style
        if (d.hidden) {
          if (hideStyle.display) {
            var priority = hideStyle.getPropertyPriority('display')
            hideEl.setAttribute('data-doop-display', hideStyle.display + (priority ? ' !' + priority : ''))
          }
          hideEl.setAttribute('data-doop-hidden', 'true')
          hideStyle.setProperty('display', 'none', 'important')
          if (activeEl && hideEl.contains(activeEl)) deactivate()
        } else {
          var prior = hideEl.getAttribute('data-doop-display')
          hideEl.removeAttribute('data-doop-hidden')
          hideEl.removeAttribute('data-doop-display')
          if (prior) {
            var parts = prior.split(' !')
            hideStyle.setProperty('display', parts[0], parts[1] || '')
          } else hideStyle.removeProperty('display')
          if (!hideEl.getAttribute('style')) hideEl.removeAttribute('style')
        }
      }
      parent.postMessage({ type: 'doop:visibility-result', reqId: d.reqId, ok: !!hideEl }, '*')
    }
    /* a lock set from the Layers panel lands on the live element too: while
       editing, the parent withholds html, and the next text save serializes
       this document — the attribute has to be here or the save drops it. A
       lock over the element being typed in ends that edit. */
    if (d.type === 'doop:lock') {
      var lockEl = null
      try { lockEl = d.selector ? document.querySelector(d.selector) : null } catch (e) { /* bad selector */ }
      if (lockEl) {
        if (d.locked) {
          lockEl.setAttribute('data-doop-locked', 'true')
          if (activeEl && lockEl.contains(activeEl)) deactivate()
        } else lockEl.removeAttribute('data-doop-locked')
      }
      parent.postMessage({ type: 'doop:lock-result', reqId: d.reqId, ok: !!lockEl }, '*')
    }
    if (d.type === 'doop:probe') {
      parent.postMessage({ type: 'doop:probe-result', reqId: d.reqId, hit: probe(d.x, d.y) }, '*')
    }
    if (d.type === 'doop:context-hit') {
      parent.postMessage({ type: 'doop:context-hit-result', reqId: d.reqId, hit: contextHit(d.x, d.y) }, '*')
    }
    if (d.type === 'doop:drawing-hit') {
      parent.postMessage({ type: 'doop:drawing-hit-result', reqId: d.reqId, hit: drawingHit(d.x, d.y, d.standalone, d.selected) }, '*')
    }
    if (d.type === 'doop:move-hit') {
      parent.postMessage({ type: 'doop:move-hit-result', reqId: d.reqId, hit: moveHit(d.x, d.y, d.selected) }, '*')
    }
    if (d.type === 'doop:move-target') {
      parent.postMessage({ type: 'doop:move-target-result', reqId: d.reqId, result: moveTarget(d.selector, d.x, d.y) }, '*')
    }
    if (d.type === 'doop:path') {
      parent.postMessage({ type: 'doop:path-result', reqId: d.reqId, hit: pathInfo(d) }, '*')
    }
    if (d.type === 'doop:path-editing') {
      pathEditingSelector = d.selector || null
      syncPathVisibility()
      parent.postMessage({ type: 'doop:path-editing-result', reqId: d.reqId }, '*')
    }
    if (d.type === 'doop:hover') {
      parent.postMessage({ type: 'doop:hover-result', reqId: d.reqId, hit: hoverProbe(d.x, d.y) }, '*')
    }
    if (d.type === 'doop:select') {
      parent.postMessage({ type: 'doop:select-result', reqId: d.reqId, hit: describe(d.selector) }, '*')
    }
    if (d.type === 'doop:code') {
      parent.postMessage({ type: 'doop:code-result', reqId: d.reqId, html: elementCode(d.selector) }, '*')
    }
    if (d.type === 'doop:locate') {
      var found = null
      try {
        var target = d.selector ? document.querySelector(d.selector) : null
        if (target) found = designRect(target)
      } catch (e) { /* bad selector -> null */ }
      parent.postMessage({ type: 'doop:located', reqId: d.reqId, selector: d.selector, rect: found, sizable: !!target && sizable(target) }, '*')
    }
  })
  parent.postMessage({ type: 'doop:frame-ready' }, '*')
})()
</script></body></html>`
