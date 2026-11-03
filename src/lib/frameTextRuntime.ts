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

  /* Whether every element under el is an inline run: such an element is one
     text layer, as a drawing text or an edited paragraph is. */
  function isTextBlock(el) {
    if (hasOwnText(el) || el.hasAttribute('data-doop-text') || el.getAttribute('data-doop-drawing') === 'text') return true
    var children = el.querySelectorAll('*')
    if (!children.length || !textNodesIn(el, null).length) return false
    return Array.prototype.every.call(children, function (child) {
      return child.tagName === 'BR' || getComputedStyle(child).display === 'inline'
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

  /* Style only the selected text. The boundary text nodes are split so the
     selected part stands alone, then each selected text node is styled on its
     own inline parent (a span wrapping only it, made here if needed), so a
     run's other inline styles survive. The selection then covers the styled
     text, so a second edit lands on the same runs. Returns what a cancelled
     gesture must undo: the runs' former styles and the spans made here. */
  function styleTextRange(el, styles) {
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
    if (editTimer) { clearTimeout(editTimer); editTimer = null }
    if (nodes.length) {
      var selected = document.createRange()
      selected.setStart(nodes[0], 0)
      selected.setEnd(nodes[nodes.length - 1], nodes[nodes.length - 1].nodeValue.length)
      var selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(selected)
      textRange = selected.cloneRange()
    }
    el.setAttribute('data-doop-text', '')
    return { before: before, created: created }
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
      var normalized = normalizeTextParagraph(el, getComputedStyle(el))
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

  function normalizeTextParagraph(paragraph, computed) {
    if (paragraph.tagName !== 'P' || !paragraph.querySelector('ul,ol,div,p')) return paragraph
    var block = document.createElement('div')
    Array.prototype.forEach.call(paragraph.attributes, function (attr) { block.setAttribute(attr.name, attr.value) })
    ;['display', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'color',
      'text-align', 'white-space', 'letter-spacing', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left'].forEach(function (name) {
      if (!block.style.getPropertyValue(name)) block.style.setProperty(name, computed.getPropertyValue(name))
    })
    while (paragraph.firstChild) block.appendChild(paragraph.firstChild)
    paragraph.replaceWith(block)
    return block
  }

  function serializeText(root) {
    // Browsers allow block children in an editable <p>, but HTML parsing ejects
    // them on reload. Normalize the saved clone while native undo is active;
    // deactivate reconciles the live host when the editing session ends.
    var live = document.querySelectorAll('p[data-doop-text]')
    root.querySelectorAll('p[data-doop-text]').forEach(function (paragraph, index) {
      normalizeTextParagraph(paragraph, getComputedStyle(live[index]))
    })
  }
`
