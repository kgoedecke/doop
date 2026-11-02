/** Runs inside the sandboxed frame, where browser layout and hit testing are
 * available. The parent draws the result and commits through the layer editor. */
export const FRAME_DROP_RUNTIME = `
  function dropContainer(el, source) {
    if (!el || el.namespaceURI !== 'http://www.w3.org/1999/xhtml' || isLocked(el)) return false
    if (el === source || source.contains(el)) return false
    if (el.hasAttribute('data-doop-drawing')) return false
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

  function moveTarget(selector, x, y) {
    var source = styleTarget(selector)
    var empty = { free: false, drop: null }
    if (!source || isLocked(source)) return empty
    var position = getComputedStyle(source).position
    var floating = position === 'absolute' || position === 'fixed'
    if (!straightLayout(source.parentElement)) return { free: true, drop: null }
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return { free: floating, drop: null }
    var stack = document.elementsFromPoint(x, y)
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
    var styles = { order: best.order, orderChanged: getComputedStyle(source).order !== best.order }
    var transform = getComputedStyle(source).transform
    if (transform !== 'none') {
      var matrix = new DOMMatrix(transform)
      if (matrix.m41 || matrix.m42 || matrix.m43) {
        matrix.m41 = matrix.m42 = matrix.m43 = 0
        styles.transform = matrix.isIdentity ? 'none' : matrix.toString()
      }
    }
    return { free: false, drop: { target: { selector: best.selector, place: best.place },
      styles: styles, container: bounds, line: best.line } }
  }
`
