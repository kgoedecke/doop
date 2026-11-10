import { TEXT_FORMAT_COMMANDS, TEXT_STYLE_PROPERTIES } from './richText'

/** Runs in FRAME_BOOTSTRAP's closure, sharing its active element and save path. */
export const FRAME_TEXT_RUNTIME = `
  var textCommands = ${JSON.stringify(TEXT_FORMAT_COMMANDS)}
  var textProps = ${JSON.stringify(TEXT_STYLE_PROPERTIES)}
  var TEXT_RUN_MARK = 'doop-run'
  var textRange = null
  var lastTextSelection = ''

  function validTextRange(range) {
    return !!(activeEl && !isLocked(activeEl) && range &&
      activeEl.contains(range.startContainer) && activeEl.contains(range.endContainer) &&
      !Array.prototype.some.call(activeEl.querySelectorAll(LOCKED), function (el) { return range.intersectsNode(el) }))
  }

  function postTextState() {
    if (!editing || !activeEl) return
    var selection = getSelection()
    var range = selection && selection.rangeCount ? selection.getRangeAt(0) : null
    if (!validTextRange(range)) return
    textRange = range.cloneRange()
    var state = {}
    textCommands.forEach(function (command) { state[command] = document.queryCommandState(command) })
    parent.postMessage({ type: 'doop:text-state', state: state }, '*')
    // The Design panel shows the selected run's styles: tell it when the run changes.
    var key = range.collapsed ? '' : cssPath(range.startContainer.parentElement || activeEl) + ':' + range.startOffset +
      '-' + cssPath(range.endContainer.parentElement || activeEl) + ':' + range.endOffset
    if (key !== lastTextSelection) {
      lastTextSelection = key
      parent.postMessage({ type: 'doop:text-selection' }, '*')
    }
  }

  /* The run the Design panel edits: the selected text while editing, else none. */
  function selectedTextRange(el) {
    if (!editing || activeEl !== el || !textRange || textRange.collapsed || !validTextRange(textRange)) return null
    // Everything selected (a double-click's select-all) is the layer itself.
    return textRange.toString().trim() === el.textContent.trim() ? null : textRange
  }

  function textNodesIn(el, range) {
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    var nodes = []
    while (walker.nextNode()) {
      var node = walker.currentNode
      if (!node.nodeValue.replace(/[\\s\\u00a0]+/g, '')) continue
      if (range && !range.intersectsNode(node)) continue
      if (range && !range.collapsed) {
        // A node touching the range only at its boundary is not selected.
        if (node === range.endContainer && range.endOffset === 0) continue
        if (node === range.startContainer && range.startOffset === node.nodeValue.length) continue
      }
      nodes.push(node)
    }
    return nodes
  }

  /* Whether every element under el is an inline run (or, under a list, an
     item of it): such an element is one text layer, as a drawing text, an
     edited paragraph or a bulleted list is. */
  function isTextBlock(el) {
    if (hasOwnText(el) || el.hasAttribute('data-doop-text') || el.getAttribute('data-doop-drawing') === 'text') return true
    var children = el.querySelectorAll('*')
    if (!children.length || !textNodesIn(el, null).length) return false
    var list = /^(UL|OL)$/.test(el.tagName)
    return Array.prototype.every.call(children, function (child) {
      return child.tagName === 'BR' || (list && child.tagName === 'LI') || getComputedStyle(child).display === 'inline'
    })
  }

  /* The text styles of el's runs, as the Design panel shows them: the
     selected run's while editing, else the first run's, with a flag for each
     property whose runs disagree (Figma's "Mixed"). */
  function textStyleSummary(el) {
    var nodes = textNodesIn(el, selectedTextRange(el))
    var keys = ['fontFamily', 'fontSize', 'fontWeight', 'color']
    var mixed = {}
    var values = null
    nodes.forEach(function (node) {
      var cs = getComputedStyle(node.parentElement)
      if (!values) {
        values = {}
        keys.forEach(function (key) { values[key] = cs[key] })
        return
      }
      keys.forEach(function (key) { if (cs[key] !== values[key]) mixed[key] = true })
    })
    return { values: values, mixed: mixed }
  }

  function isTextPatch(styles) {
    return Object.keys(styles).every(function (key) { return textProps.indexOf(key) !== -1 })
  }

  var INLINE_RUN = /^(SPAN|B|STRONG|I|EM|U|S|STRIKE|DEL|INS|A|MARK|SMALL|SUB|SUP|CODE|FONT|ABBR|Q|CITE|TIME|LABEL)$/

  /* Widen the selection over a run it covers whole, so the run itself is
     restyled rather than wrapped in another. */
  function coverRuns(range, el) {
    for (;;) {
      var node = range.startContainer
      var run = node.nodeType === 3 ? node.parentElement : null
      if (!run || run === el || range.startOffset !== 0 || run.firstChild !== node || !INLINE_RUN.test(run.tagName)) break
      range.setStartBefore(run)
    }
    for (;;) {
      var last = range.endContainer
      var holder = last.nodeType === 3 ? last.parentElement : null
      if (!holder || holder === el || range.endOffset !== last.nodeValue.length || holder.lastChild !== last ||
        !INLINE_RUN.test(holder.tagName)) break
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
  function styleTextRange(el, styles) {
    var range = textRange.cloneRange()
    coverRuns(range, el)
    // A space right outside the selection rides along as its own text node:
    // left behind, insertHTML would make it no-break to keep it from collapsing.
    var endNode = range.endContainer
    var padEnd = endNode.nodeType === 3 && endNode.nodeValue[range.endOffset] === ' '
    if (padEnd) range.setEnd(endNode, range.endOffset + 1)
    var startNode = range.startContainer
    var padStart = startNode.nodeType === 3 && range.startOffset > 0 && startNode.nodeValue[range.startOffset - 1] === ' '
    if (padStart) range.setStart(startNode, range.startOffset - 1)
    var partial = []
    Array.prototype.forEach.call(el.querySelectorAll('[data-doop-id]'), function (node) {
      if (!range.intersectsNode(node)) return
      var whole = document.createRange()
      whole.selectNode(node)
      if (range.compareBoundaryPoints(Range.START_TO_START, whole) > 0 || range.compareBoundaryPoints(Range.END_TO_END, whole) < 0) {
        partial.push(node.getAttribute('data-doop-id'))
      }
    })
    var fragment = range.cloneContents()
    var walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT)
    var nodes = []
    while (walker.nextNode()) if (walker.currentNode.nodeValue.replace(/[\\s\\u00a0]+/g, '')) nodes.push(walker.currentNode)
    if (!nodes.length) return
    // The spaces taken along stand apart from the runs, unstyled.
    if (padStart && nodes[0].nodeValue[0] === ' ') nodes[0] = nodes[0].splitText(1)
    var last = nodes[nodes.length - 1]
    if (padEnd && last.nodeValue[last.nodeValue.length - 1] === ' ') last.splitText(last.nodeValue.length - 1)
    nodes.forEach(function (node) {
      var run = node.parentNode
      if (run === fragment || run.childNodes.length !== 1 || !INLINE_RUN.test(run.tagName)) {
        run = document.createElement('span')
        node.parentNode.insertBefore(run, node)
        run.appendChild(node)
      }
      patchStyle(run.style, styles)
      if (!run.getAttribute('style')) run.removeAttribute('style')
      run.setAttribute('data-doop-run', '')
    })
    fragment.querySelectorAll('[data-doop-id]').forEach(function (node) {
      if (partial.indexOf(node.getAttribute('data-doop-id')) !== -1) node.removeAttribute('data-doop-id')
    })
    var holder = document.createElement('div')
    holder.appendChild(fragment)
    var text = el.textContent
    el.focus({ preventScroll: true })
    var selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    document.execCommand('insertHTML', false, holder.innerHTML)
    restoreSpaces(el, text)
    textSnapshots.set(el, el.textContent)
    var runs = el.querySelectorAll('[data-doop-run]')
    runs.forEach(function (run) { run.removeAttribute('data-doop-run') })
    if (editTimer) { clearTimeout(editTimer); editTimer = null }
    if (runs.length) {
      var selected = document.createRange()
      selected.setStartBefore(runs[0])
      selected.setEndAfter(runs[runs.length - 1])
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
  var textSnapshots = new WeakMap()
  document.addEventListener('input', function (ev) {
    if (ev.inputType === 'historyRedo' && activeEl && textSnapshots.has(activeEl)) restoreSpaces(activeEl, textSnapshots.get(activeEl))
  })
  function restoreSpaces(el, before) {
    var after = el.textContent
    if (after.length !== before.length || after.indexOf('\\u00a0') === -1) return
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    var offset = 0
    while (walker.nextNode()) {
      var node = walker.currentNode
      var value = node.nodeValue
      var fixed = ''
      for (var i = 0; i < value.length; i++) {
        fixed += value[i] === '\\u00a0' && before[offset + i] === ' ' ? ' ' : value[i]
      }
      if (fixed !== value) node.nodeValue = fixed
      offset += value.length
    }
  }

  /* A scrub's live preview: the selected text nodes styled in place (the
     boundary nodes split so the selected part stands alone), outside the undo
     history. The gesture's end puts this back and, on commit, applies the
     final styles once through styleTextRange. Returns what to put back. */
  function previewTextRange(el, styles) {
    var range = textRange
    var start = range.startContainer
    var end = range.endContainer
    if (end.nodeType === 3 && range.endOffset < end.nodeValue.length) {
      end.splitText(range.endOffset)
      range.setEnd(end, end.nodeValue.length)
    }
    if (start.nodeType === 3 && range.startOffset > 0) {
      var tail = start.splitText(range.startOffset)
      range.setStart(tail, 0)
      if (end === start) range.setEnd(tail, tail.nodeValue.length)
    }
    var nodes = textNodesIn(el, range)
    var before = []
    var created = []
    nodes.forEach(function (node) {
      var run = node.parentElement
      if (run === el || run.childNodes.length !== 1 || getComputedStyle(run).display !== 'inline') {
        run = document.createElement('span')
        node.parentNode.insertBefore(run, node)
        run.appendChild(node)
        created.push(run)
      } else before.push({ el: run, cssText: run.style.cssText })
      patchStyle(run.style, styles)
      if (!run.getAttribute('style')) run.removeAttribute('style')
    })
    if (nodes.length) {
      var selected = document.createRange()
      selected.setStart(nodes[0], 0)
      selected.setEnd(nodes[nodes.length - 1], nodes[nodes.length - 1].nodeValue.length)
      var selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(selected)
      textRange = selected.cloneRange()
    }
    return { before: before, created: created, nodes: nodes }
  }

  function unwrapRun(run) {
    while (run.firstChild) run.parentNode.insertBefore(run.firstChild, run)
    run.remove()
  }

  /* A value set on the whole layer makes it uniform: the inline runs under it
     drop their own copy of the property, and a weight set over <b> / <strong>
     runs takes their boldness with it (the tag becomes a span with the same
     attributes), as Figma applies a layer-wide value over its mixed runs.
     Returns what a cancelled gesture must undo. */
  function clearTextRuns(el, styles) {
    var before = []
    var renamed = []
    Array.prototype.forEach.call(el.querySelectorAll('*'), function (run) {
      if (isLocked(run) || getComputedStyle(run).display !== 'inline') return
      var cssText = run.style.cssText
      for (var key in styles) if (Object.prototype.hasOwnProperty.call(styles, key)) run.style.removeProperty(key)
      if (run.style.cssText !== cssText) {
        before.push({ el: run, cssText: cssText })
        if (!run.getAttribute('style')) run.removeAttribute('style')
      }
      if (!Object.prototype.hasOwnProperty.call(styles, 'font-weight') || !/^(B|STRONG)$/.test(run.tagName)) return
      var span = document.createElement('span')
      Array.prototype.forEach.call(run.attributes, function (attr) { span.setAttribute(attr.name, attr.value) })
      while (run.firstChild) span.appendChild(run.firstChild)
      run.replaceWith(span)
      renamed.push({ el: run, span: span })
    })
    return { before: before, created: [], renamed: renamed }
  }

  /* Put back what clearTextRuns and styleTextRange did during a cancelled gesture. */
  function restoreTextRuns(edit) {
    edit.runs.forEach(function (run) { run.el.style.cssText = run.cssText; if (!run.el.getAttribute('style')) run.el.removeAttribute('style') })
    edit.created.forEach(unwrapRun)
    // Moving the text nodes out of their spans collapsed the live selection
    // around them; the nodes themselves survived, so it is rebuilt from them.
    if (edit.nodes && edit.nodes.length && editing && activeEl) {
      var nodes = edit.nodes
      var range = document.createRange()
      range.setStart(nodes[0], 0)
      range.setEnd(nodes[nodes.length - 1], nodes[nodes.length - 1].nodeValue.length)
      var selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      textRange = range.cloneRange()
    }
    edit.renamed.forEach(function (change) {
      while (change.span.firstChild) change.el.appendChild(change.span.firstChild)
      change.span.replaceWith(change.el)
    })
  }

  function formatText(command) {
    if (!editing || textCommands.indexOf(command) === -1 || !validTextRange(textRange)) return
    activeEl.focus({ preventScroll: true })
    var selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(textRange)
    // Native commands preserve the browser's undo stack, including typed text.
    document.execCommand(command, false, null)
    activeEl.setAttribute('data-doop-text', '')
    styleLists(activeEl, command, selection)
    if (editTimer) { clearTimeout(editTimer); editTimer = null }
    postEdited(true)
    postTextState()
  }

  // Design resets often hide list markers. Keep the formatting in saved HTML.
  function styleLists(el, command, selection) {
    if (command !== 'insertUnorderedList' && command !== 'insertOrderedList') return
    el.querySelectorAll('ul,ol').forEach(function (list) {
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
  function formatLayers(selectors, command) {
    if (editing || textCommands.indexOf(command) === -1) return null
    var changed = false
    var retagged = false
    // Positional selectors shift once a layer changes tag: resolve them all first.
    var layers = selectors.map(function (selector) { return { selector: selector, el: styleTarget(selector) } })
    layers.forEach(function (layer) {
      var el = layer.el
      if (!el || isLocked(el) || !isTextBlock(el) || el.querySelector(LOCKED)) return
      var editable = el.getAttribute('contenteditable')
      prepareText(el)
      el.setAttribute('contenteditable', 'true')
      // Editing commands act on the focused editable only; the parent takes
      // the keyboard back once the reply lands.
      el.focus({ preventScroll: true })
      var selection = getSelection()
      var range = document.createRange()
      range.selectNodeContents(el)
      selection.removeAllRanges()
      selection.addRange(range)
      document.execCommand(command, false, null)
      styleLists(el, command, selection)
      selection.removeAllRanges()
      el.blur()
      if (editable === null) el.removeAttribute('contenteditable')
      else el.setAttribute('contenteditable', editable)
      el.setAttribute('data-doop-text', '')
      changed = true
      var normalized = normalizeTextParagraph(el, paragraphStyleDiff(el))
      if (normalized !== el) retagged = true
      layer.el = normalized
    })
    if (changed) postEdited(true)
    // A retagged layer shifts its positional neighbours too: every selector is re-read then.
    return layers.map(function (layer) { return retagged && layer.el ? cssPath(layer.el) : layer.selector })
  }

  document.addEventListener('selectionchange', postTextState)
  document.addEventListener('keydown', function (ev) {
    if (!editing || !activeEl || !(ev.metaKey || ev.ctrlKey) || ev.altKey) return
    var key = ev.key.toLowerCase()
    var command = !ev.shiftKey ? { b: 'bold', i: 'italic', u: 'underline' }[key]
      : ev.code === 'Digit7' ? 'insertOrderedList' : ev.code === 'Digit8' ? 'insertUnorderedList' : null
    if (!command) return
    ev.preventDefault()
    postTextState()
    formatText(command)
  })

  // Preserve the old plain-text paste contract: clipboard HTML must not import
  // arbitrary styles, images or executable attributes into the design.
  document.addEventListener('paste', function (ev) {
    if (!editing || !activeEl || !activeEl.contains(ev.target)) return
    ev.preventDefault()
    if (ev.clipboardData) document.execCommand('insertText', false, ev.clipboardData.getData('text/plain'))
  })

  function prepareText(el) {
    // Pre-wrapped newlines are separate visual lines, but native list commands
    // only understand DOM line breaks. Convert before editing/undo begins.
    if (!/^pre/.test(getComputedStyle(el).whiteSpace)) return
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    var nodes = []
    while (walker.nextNode()) nodes.push(walker.currentNode)
    nodes.forEach(function (node) {
      if (node.nodeValue.indexOf('\\n') === -1 || !/^pre/.test(getComputedStyle(node.parentElement).whiteSpace)) return
      var fragment = document.createDocumentFragment()
      node.nodeValue.split('\\n').forEach(function (line, index) {
        if (index) fragment.appendChild(document.createElement('br'))
        fragment.appendChild(document.createTextNode(line))
      })
      node.parentNode.replaceChild(fragment, node)
    })
  }

  /* What a <div> in the paragraph's place would render differently: the
     paragraph's computed longhands that a probe div with the same attributes,
     put beside it for the measurement, does not share (its default margins,
     whatever p rules gave it). Box sizes follow from content and are skipped. */
  function paragraphStyleDiff(paragraph) {
    var probe = document.createElement('div')
    Array.prototype.forEach.call(paragraph.attributes, function (attr) { probe.setAttribute(attr.name, attr.value) })
    paragraph.parentNode.insertBefore(probe, paragraph.nextSibling)
    var was = getComputedStyle(paragraph)
    var would = getComputedStyle(probe)
    var diff = {}
    for (var i = 0; i < was.length; i++) {
      var name = was[i]
      if (/^(--|-webkit-|width$|height$|inline-size$|block-size$|.*-origin$)/.test(name)) continue
      var value = was.getPropertyValue(name)
      if (value && would.getPropertyValue(name) !== value) diff[name] = value
    }
    probe.remove()
    return diff
  }

  /* Browsers allow block children in an editable <p>, but HTML parsing ejects
     them on reload: a paragraph holding a list becomes a <div> that renders
     the same, carrying the styles the paragraph owed to its tag inline. */
  function normalizeTextParagraph(paragraph, diff) {
    if (paragraph.tagName !== 'P' || !paragraph.querySelector('ul,ol,div,p')) return paragraph
    var block = document.createElement('div')
    Array.prototype.forEach.call(paragraph.attributes, function (attr) { block.setAttribute(attr.name, attr.value) })
    for (var name in diff) if (!block.style.getPropertyValue(name)) block.style.setProperty(name, diff[name])
    while (paragraph.firstChild) block.appendChild(paragraph.firstChild)
    paragraph.replaceWith(block)
    return block
  }

  function serializeText(root) {
    // Normalize the saved clone while native undo is active; deactivate
    // reconciles the live host when the editing session ends.
    var live = document.querySelectorAll('p[data-doop-text]')
    root.querySelectorAll('p[data-doop-text]').forEach(function (paragraph, index) {
      if (paragraph.querySelector('ul,ol,div,p')) normalizeTextParagraph(paragraph, paragraphStyleDiff(live[index]))
    })
  }
`
