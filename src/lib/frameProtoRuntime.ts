import { parseInteractions, PROTO_SELECTOR } from '../../shared/prototype'

/**
 * Prototype triggers, inside the sandboxed frame (spliced into
 * FRAME_BOOTSTRAP's scope, so `editing`, `cssPath` and `designRect` are the
 * runtime's own). Inert until the parent turns prototype mode on with
 * `doop:proto` — the canvas never does, so a click while editing still only
 * selects. Once on, a trigger posts `doop:proto-action` with the parsed
 * interaction and the player does the navigation; only scroll-to runs here.
 *
 * The parser is shared/prototype.ts's own, inlined by source: one definition
 * of what an interaction attribute means, on both sides of the sandbox.
 */
export const FRAME_PROTO_RUNTIME = `
  var parseInteractions = (${parseInteractions.toString()});
  var PROTO_SEL = '${PROTO_SELECTOR}'
  var protoOn = false
  var protoHints = true
  var protoTimers = []
  var protoHoverEl = null
  var protoSheet = null
  /* a press this screen reported and whose release it still owes the player */
  var protoPressing = false

  function protoList(el) {
    return parseInteractions({
      on: el.getAttribute('data-doop-on'),
      action: el.getAttribute('data-doop-action'),
      transition: el.getAttribute('data-doop-transition'),
      duration: el.getAttribute('data-doop-duration'),
      interactions: el.getAttribute('data-doop-interactions'),
    })
  }

  /* the nearest element at or above start with an interaction for this trigger */
  function protoFind(start, trigger) {
    var el = start && start.nodeType === 3 ? start.parentElement : start
    while (el && el.nodeType === 1) {
      if (el.matches(PROTO_SEL)) {
        var list = protoList(el)
        for (var i = 0; i < list.length; i++) if (list[i].trigger === trigger) return { el: el, interaction: list[i] }
      }
      el = el.parentElement
    }
    return null
  }

  /* press: the player reverts what this opened on release; a scroll has
     nothing to revert and runs here either way */
  function protoFire(interaction, press) {
    if (interaction.action === 'scroll-to') {
      var target = null
      try { target = document.querySelector(interaction.target) } catch (e) { /* bad selector */ }
      if (target) target.scrollIntoView({ behavior: interaction.transition === 'instant' ? 'auto' : 'smooth', block: 'start' })
      return
    }
    if (press) protoPressing = true
    parent.postMessage({ type: 'doop:proto-action', interaction: interaction, press: !!press }, '*')
  }

  function protoActive() {
    return protoOn && !editing
  }

  function protoEnsureSheet() {
    if (protoSheet) return
    try {
      protoSheet = new CSSStyleSheet()
      protoSheet.replaceSync(
        '@keyframes doop-proto-flash{0%{outline-color:rgba(1,119,211,.9)}100%{outline-color:rgba(1,119,211,0)}}' +
        '[data-v-proto-flash]{outline:2px solid rgba(1,119,211,.9)!important;outline-offset:1px!important;' +
        'animation:doop-proto-flash .9s ease-out forwards!important}'
      )
      document.adoptedStyleSheets = document.adoptedStyleSheets.concat(protoSheet)
    } catch (e) {}
  }

  /* flash every element that does something when clicked or pressed */
  function protoFlash() {
    protoEnsureSheet()
    var els = document.querySelectorAll(PROTO_SEL)
    for (var i = 0; i < els.length; i++) {
      var el = els[i]
      el.removeAttribute('data-v-proto-flash')
      void el.offsetWidth // restart the animation
      el.setAttribute('data-v-proto-flash', '')
    }
    setTimeout(function () {
      var lit = document.querySelectorAll('[data-v-proto-flash]')
      for (var j = 0; j < lit.length; j++) lit[j].removeAttribute('data-v-proto-flash')
    }, 950)
  }

  function protoKey(key) {
    var els = document.querySelectorAll(PROTO_SEL)
    for (var i = 0; i < els.length; i++) {
      var list = protoList(els[i])
      for (var j = 0; j < list.length; j++) {
        if (list[j].trigger === 'key' && list[j].key === key) {
          protoFire(list[j])
          return true
        }
      }
    }
    return false
  }

  function protoStopDelays() {
    for (var i = 0; i < protoTimers.length; i++) clearTimeout(protoTimers[i])
    protoTimers = []
  }

  function protoStartDelays() {
    var els = document.querySelectorAll(PROTO_SEL)
    for (var i = 0; i < els.length; i++) {
      var list = protoList(els[i])
      for (var j = 0; j < list.length; j++) {
        if (list[j].trigger !== 'delay') continue
        ;(function (el, interaction) {
          protoTimers.push(setTimeout(function () {
            if (protoActive() && el.isConnected) protoFire(interaction)
          }, interaction.delay))
        })(els[i], list[j])
      }
    }
  }

  function setProto(on, hints) {
    protoHints = hints
    if (on === protoOn) return
    protoOn = on
    protoHoverEl = null
    protoStopDelays()
    if (on) protoStartDelays()
  }

  /* a live edit replaced the document: its delays are the new HTML's, timed
     from now, as on a reload of the screen */
  function protoHtmlChanged() {
    protoHoverEl = null
    protoStopDelays()
    if (protoActive()) protoStartDelays()
  }

  /* links and form controls keep their own behaviour; a click there is
     not a "miss" that should flash the hotspots */
  function protoNative(el) {
    return !!(el && el.closest && el.closest('a[href],button,input,select,textarea,label,summary,[contenteditable]'))
  }

  document.addEventListener('click', function (ev) {
    if (!protoActive()) return
    var hit = protoFind(ev.target, 'click')
    if (hit) {
      ev.preventDefault()
      protoFire(hit.interaction)
    } else if (protoHints && !protoNative(ev.target)) protoFlash()
  }, true)

  document.addEventListener('pointerdown', function (ev) {
    if (!protoActive()) return
    var hit = protoFind(ev.target, 'press')
    if (!hit) return
    ev.preventDefault()
    protoFire(hit.interaction, true)
  }, true)

  /* A press that navigated has switched this screen off by the time the
     pointer comes up (it is the outgoing one now), so the release of a press
     it reported still goes out: dropping it would leave the press open for
     some later, unrelated release to undo. */
  function protoRelease() {
    if (!protoActive() && !protoPressing) return
    protoPressing = false
    parent.postMessage({ type: 'doop:proto-release' }, '*')
  }
  document.addEventListener('pointerup', protoRelease, true)
  document.addEventListener('pointercancel', protoRelease, true)

  document.addEventListener('mouseover', function (ev) {
    if (!protoActive()) return
    var hit = protoFind(ev.target, 'hover')
    if (!hit) {
      protoHoverEl = null
      return
    }
    if (hit.el === protoHoverEl) return
    protoHoverEl = hit.el
    protoFire(hit.interaction)
  }, true)

  /* registered before the runtime's own Escape relay: a key the design
     handles is not also an "exit the player". Escape is left to that relay:
     the player closes an open overlay first and only then offers the key
     back through doop:proto-key, wherever the focus is. */
  document.addEventListener('keydown', function (ev) {
    if (!protoActive() || ev.repeat || ev.key === 'Escape') return
    if (protoKey(ev.key)) ev.preventDefault()
  }, true)

  function protoScan() {
    var els = document.querySelectorAll(PROTO_SEL)
    var out = []
    for (var i = 0; i < els.length; i++) {
      var list = protoList(els[i])
      if (list.length) out.push({ selector: cssPath(els[i]), rect: designRect(els[i]), interactions: list })
    }
    return out
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== parent) return
    var d = ev.data
    if (!d) return
    if (d.type === 'doop:proto') setProto(!!d.on, d.hints !== false)
    if (d.type === 'doop:proto-hotspots') protoFlash()
    if (d.type === 'doop:proto-key') {
      var handled = protoActive() && protoKey(d.key)
      parent.postMessage({ type: 'doop:proto-key-result', reqId: d.reqId, handled: handled }, '*')
    }
    if (d.type === 'doop:proto-scan') {
      parent.postMessage({ type: 'doop:proto-scan-result', reqId: d.reqId, items: protoScan() }, '*')
    }
  })
`
