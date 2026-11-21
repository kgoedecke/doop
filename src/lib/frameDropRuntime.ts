/** Runs inside the sandboxed frame, where browser layout and hit testing are
 * available. The parent draws the result and commits through the layer editor. */
export const FRAME_DROP_RUNTIME = `
  function dropContainer(el, source) {
    if (!el || el.namespaceURI !== 'http://www.w3.org/1999/xhtml' || isLocked(el)) return false
    if (el === source || source.contains(el)) return false
    // a group made on the canvas holds layers; other drawings are leaves
    var drawing = el.getAttribute('data-doop-drawing')
    if (drawing !== null && drawing !== 'group') return false
    if (el.tagName === 'UL' || el.tagName === 'OL') return source.tagName === 'LI'
    if (el.tagName === 'DL') return source.tagName === 'DT' || source.tagName === 'DD'
    return ['BODY', 'DIV', 'SECTION', 'MAIN', 'ARTICLE', 'ASIDE', 'HEADER', 'FOOTER',
      'NAV', 'FORM', 'FIELDSET', 'LI', 'DT', 'DD', 'TD', 'TH', 'FIGURE', 'FIGCAPTION'].indexOf(el.tagName) !== -1
      && getComputedStyle(el).display !== 'contents'
  }

  function dropAxes(parent) {
    var cs = getComputedStyle(parent)
    var vertical = cs.writingMode.indexOf('vertical') === 0
    var flex = cs.display.indexOf('flex') !== -1
    var grid = cs.display.indexOf('grid') !== -1
    var row = flex ? cs.flexDirection.indexOf('row') === 0 : grid && cs.gridAutoFlow.indexOf('column') !== 0
    var horizontal = row ? !vertical : vertical
    var reverse = row ? cs.direction === 'rtl' : cs.writingMode === 'vertical-rl'
    if (flex && cs.flexDirection.indexOf('reverse') !== -1) reverse = !reverse
    return { horizontal: horizontal, reverse: reverse, wrapped: grid || (flex && cs.flexWrap !== 'nowrap') }
  }

  // A rotated/skewed layout needs polygon guides. Keep its existing free move
  // behavior rather than displaying an axis-aligned insertion bar in the wrong place.
  function straightLayout(el) {
    for (var node = el; node && node !== document.documentElement; node = node.parentElement) {
      var cs = getComputedStyle(node)
      var m = new DOMMatrix(cs.transform === 'none' ? undefined : cs.transform)
      if (!m.is2D || Math.abs(m.b) > 0.000001 || Math.abs(m.c) > 0.000001 || m.a <= 0 || m.d <= 0) return false
      if (cs.rotate !== 'none' && parseFloat(cs.rotate) !== 0) return false
    }
    return true
  }

  function inFlow(el) {
    if (['SCRIPT', 'STYLE', 'LINK', 'META', 'TEMPLATE'].indexOf(el.tagName) !== -1) return false
    var cs = getComputedStyle(el)
    return cs.display !== 'none' && cs.position !== 'absolute' && cs.position !== 'fixed'
  }

  /* A box that places its layers by hand, as a design tool's plain frame
     does: no flex or grid, nothing in flow but the moving layer, and it is
     the frame's body, a canvas group, or already holds a layer placed
     absolute (a drawn frame, a pinned group). A layer dropped there is
     placed absolute where it was let go, not put in a flow it does not
     have. An empty card on a page still takes a drop in flow. */
  function freeform(el, source) {
    var display = getComputedStyle(el).display
    if (display.indexOf('flex') !== -1 || display.indexOf('grid') !== -1) return false
    var others = Array.prototype.filter.call(el.children, function (child) {
      return child !== source && !child.contains(source)
        && ['SCRIPT', 'STYLE', 'LINK', 'META', 'TEMPLATE'].indexOf(child.tagName) === -1
    })
    if (others.some(inFlow)) return false
    return el === document.body || el.getAttribute('data-doop-drawing') === 'group' || others.length > 0
  }

  /* the corner an absolute child of the parent is placed from, in design px,
     and the scale it is drawn at */
  function placementOrigin(parent) {
    for (var cb = parent; cb && cb !== document.documentElement; cb = cb.parentElement) {
      var cs = getComputedStyle(cb)
      if (cs.position !== 'static' || cs.transform !== 'none' || /paint|layout|strict|content/.test(cs.contain)) {
        var r = designRect(cb), scale = renderScale(cb, r)
        return { x: r.x + (parseFloat(cs.borderLeftWidth) || 0) * scale.x,
          y: r.y + (parseFloat(cs.borderTopWidth) || 0) * scale.y, scale: scale }
      }
    }
    // the initial containing block: the document's own corner
    return { x: -scrollX, y: -scrollY, scale: { x: 1, y: 1 } }
  }

  /* at: where the layer is drawn, when the drag shows a copy of it and
     leaves the layer itself where it was */
  function absoluteDrop(parent, source, at) {
    var origin = placementOrigin(parent)
    var rect = at || designRect(source)
    var cs = getComputedStyle(source)
    var width = source.offsetWidth !== undefined ? source.offsetWidth : parseFloat(cs.width) || 0
    var height = source.offsetHeight !== undefined ? source.offsetHeight : parseFloat(cs.height) || 0
    // by the centre, which a turn or scale about it leaves where it is; the
    // move its transform makes stays with it, so it is not counted twice
    // (its translate is the drag's, which the drop replaces)
    var shift = new DOMMatrix(cs.transform === 'none' ? undefined : cs.transform)
    var cx = (rect.x + rect.width / 2 - origin.x) / origin.scale.x - shift.e
    var cy = (rect.y + rect.height / 2 - origin.y) / origin.scale.y - shift.f
    var round = function (n) { return Math.round(n * 100) / 100 }
    var last = null
    for (var i = parent.children.length - 1; i >= 0 && !last; i--) {
      var child = parent.children[i]
      if (child !== source && ['SCRIPT', 'STYLE', 'LINK', 'META', 'TEMPLATE'].indexOf(child.tagName) === -1) last = child
    }
    var bounds = designRect(parent)
    return {
      // on top of what the box already holds
      target: last ? { selector: cssPath(last), place: 'after' } : { selector: cssPath(parent), place: 'inside' },
      styles: { order: cs.order, absolute: {
        left: round(cx - width / 2 - (parseFloat(cs.marginLeft) || 0)),
        top: round(cy - height / 2 - (parseFloat(cs.marginTop) || 0)),
      } },
      container: bounds,
      line: null,
      reparent: parent !== source.parentElement && parent !== document.body,
    }
  }

  /* How a layer moved from the Layers panel sits in its new box, the way a
     canvas drag would put it: a flow item in a flex or grid box, placed
     absolute where it shows now in a box that places its layers by hand,
     and left as authored anywhere else (null). */
  function layerPlacement(selector, target) {
    var source = styleTarget(selector)
    var at = target && styleTarget(target.selector)
    if (!source || !at || isLocked(source)) return null
    var parent = target.place === 'inside' ? at : at.parentElement
    if (!parent || parent === source || source.contains(parent)) return null
    var display = getComputedStyle(parent).display
    var position = getComputedStyle(source).position
    var floating = position === 'absolute' || position === 'fixed'
    if (display.indexOf('flex') !== -1 || display.indexOf('grid') !== -1) {
      return floating ? { order: '0', flexItem: display.indexOf('flex') !== -1 } : null
    }
    if (!freeform(parent, source)) return null
    // the box's own layers stay put when only their order changes
    if (floating && parent === source.parentElement) return null
    return absoluteDrop(parent, source).styles
  }

  function moveTarget(selector, x, y, at) {
    var source = styleTarget(selector)
    var empty = { free: false, drop: null }
    if (!source || isLocked(source)) return empty
    var position = getComputedStyle(source).position
    var floating = position === 'absolute' || position === 'fixed'
    if (!straightLayout(source.parentElement)) return { free: true, drop: null }
    if (x < 0 || y < 0 || x >= frameWidth() || y >= frameHeight()) return { free: floating, drop: null }
    var stack = document.elementsFromPoint(viewX(x), viewX(y))
    var hit = null
    for (var i = 0; i < stack.length; i++) {
      if (!source.contains(stack[i])) { hit = stack[i]; break }
    }
    if (!hit || isLocked(hit)) return empty
    if (hit === document.documentElement) hit = document.body
    var parent = hit
    while (parent && !dropContainer(parent, source)) parent = parent.parentElement
    if (!parent) return empty
    // Near a container's edge, offer a sibling slot; its center accepts children.
    if (parent === hit && parent !== source.parentElement && parent !== document.body) {
      var outer = parent.parentElement
      if (dropContainer(outer, source)) {
        var axes = dropAxes(outer), r = designRect(parent)
        var coordinate = axes.horizontal ? x : y
        var start = axes.horizontal ? r.x : r.y
        var size = axes.horizontal ? r.width : r.height
        var edge = Math.min(12, size * 0.2)
        if (coordinate - start < edge || start + size - coordinate < edge) parent = outer
      }
    }
    if (floating && parent === source.parentElement) return { free: true, drop: null }
    if (!straightLayout(parent)) return empty
    if (freeform(parent, source)) return { free: false, drop: absoluteDrop(parent, source, at) }
    var axes = dropAxes(parent)
    var bounds = designRect(parent)
    var children = Array.prototype.filter.call(parent.children, function (el) {
      if (el === source || ['SCRIPT', 'STYLE', 'LINK', 'META', 'TEMPLATE'].indexOf(el.tagName) !== -1) return false
      var cs = getComputedStyle(el), rect = designRect(el)
      return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.position !== 'absolute'
        && cs.position !== 'fixed' && rect.width > 0 && rect.height > 0
    })
    var best = null, distance = Infinity
    children.forEach(function (child) {
      var rect = designRect(child)
      var start = axes.horizontal ? rect.x : rect.y
      var length = axes.horizontal ? rect.width : rect.height
      var crossStart = axes.horizontal ? rect.y : rect.x
      var crossLength = axes.horizontal ? rect.height : rect.width
      var main = axes.horizontal ? x : y, cross = axes.horizontal ? y : x
      ;['before', 'after'].forEach(function (place) {
        var end = (place === 'after') !== axes.reverse
        var edge = start + (end ? length : 0)
        var crossDistance = Math.max(crossStart - cross, 0, cross - crossStart - crossLength)
        var score = Math.abs(main - edge) + crossDistance * 4
        if (score >= distance) return
        distance = score
        var line = axes.horizontal
          ? { x: edge, y: axes.wrapped ? rect.y : bounds.y, width: 0, height: axes.wrapped ? rect.height : bounds.height }
          : { x: axes.wrapped ? rect.x : bounds.x, y: edge, width: axes.wrapped ? rect.width : bounds.width, height: 0 }
        best = { selector: cssPath(child), place: place, line: line, order: getComputedStyle(child).order }
      })
    })
    if (!best) {
      var cs = getComputedStyle(parent)
      var scale = renderScale(parent, bounds)
      var left = bounds.x + ((parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0)) * scale.x
      var top = bounds.y + ((parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0)) * scale.y
      var right = bounds.x + bounds.width - ((parseFloat(cs.borderRightWidth) || 0) + (parseFloat(cs.paddingRight) || 0)) * scale.x
      var bottom = bounds.y + bounds.height - ((parseFloat(cs.borderBottomWidth) || 0) + (parseFloat(cs.paddingBottom) || 0)) * scale.y
      best = { selector: cssPath(parent), place: 'inside', order: '0', line: axes.horizontal
        ? { x: axes.reverse ? right : left, y: top, width: 0, height: Math.max(20, bottom - top) }
        : { x: left, y: axes.reverse ? bottom : top, width: Math.max(20, right - left), height: 0 } }
    }
    var styles = { order: best.order, orderChanged: getComputedStyle(source).order !== best.order,
      fromFlow: !floating, flexItem: getComputedStyle(parent).display.indexOf('flex') !== -1 }
    var transform = getComputedStyle(source).transform
    if (transform !== 'none') {
      var matrix = new DOMMatrix(transform)
      if (matrix.m41 || matrix.m42 || matrix.m43) {
        matrix.m41 = matrix.m42 = matrix.m43 = 0
        styles.transform = matrix.isIdentity ? 'none' : matrix.toString()
      }
    }
    return { free: false, drop: { target: { selector: best.selector, place: best.place },
      styles: styles, container: bounds, line: best.line, reparent: parent !== source.parentElement } }
  }
`
