/**
 * doop design sync — one tag in your app, your live screens on a doop canvas.
 *
 *   <script async src="https://yourdoop.example/doop-sync.js?key=dk_…"></script>
 *
 * Runs in the USER'S browser, so it captures apps no crawler can reach
 * (SSO, VPN, localhost) exactly as the signed-in user sees them. Each
 * distinct route becomes one frame, imported once — a short grace window
 * lets the first capture settle, then the screen freezes on the canvas.
 *
 * Options (attributes on the script tag):
 *   data-key   required — a canvas sync key from doop's share dialog
 *   data-host  override the doop origin (defaults to where this file loaded from)
 *   data-mask  extra CSS selector whose text is redacted before upload
 *
 * The key can also ride in the URL itself — the form that survives every
 * tag manager, since src is the one attribute injectors never strip:
 *   <script async src="https://yourdoop.example/doop-sync.js?key=dk_…"></script>
 * Last resort (injector rewrites the src too): set globals in the same tag:
 *   <script>window.doopSyncKey = 'dk_…'; window.doopSyncHost = 'https://yourdoop.example'</script>
 *
 * Privacy: input values are always dropped, [data-doop-mask] subtrees are
 * redacted, scripts never leave the page. `window.doopSync.capture()` forces
 * a capture; add data-doop-sync-ignore to elements that should never upload.
 *
 * Frames show each screen as it GREETS the user: after the first hover over
 * a menu, click, or keypress, the poked-at DOM (open dropdowns, modals,
 * moved focus) never replaces a copy the canvas already has.
 */
;(function () {
  'use strict'
  if (window.doopSync) return
  /* Tag managers re-create script tags when injecting, which can leave
     document.currentScript null/useless and strip data attributes — so the
     canonical install carries the key in the src query string, and the tag
     is findable by that src. Priority: data attrs, then src params, then
     the window.* globals. */
  var script = document.currentScript
  if (!script || !(script.getAttribute('data-key') || (script.src || '').indexOf('doop-sync') !== -1)) {
    script = null
    var candidates = document.querySelectorAll('script[src]')
    for (var t = 0; t < candidates.length; t++) {
      if (candidates[t].src.indexOf('doop-sync') !== -1) {
        script = candidates[t]
        break
      }
    }
  }
  var srcUrl = null
  try {
    if (script && script.src) srcUrl = new URL(script.src)
  } catch (e) {
    /* unparsable src */
  }
  var KEY =
    (script && script.getAttribute('data-key')) || (srcUrl && srcUrl.searchParams.get('key')) || window.doopSyncKey
  var HOST =
    (script && script.getAttribute('data-host')) ||
    (srcUrl && srcUrl.searchParams.get('host')) ||
    window.doopSyncHost ||
    (srcUrl && srcUrl.origin) ||
    ''
  var MASK = (script && script.getAttribute('data-mask')) || ''
  if (!KEY || !HOST) {
    console.warn('[doop-sync] missing data-key or data-host — not capturing')
    return
  }

  var SETTLE_MS = 2500 // let data land and skeletons resolve before capturing
  var MIN_RESEND_MS = 30000 // floor between uploads of the same route (matches the server's)
  var MAX_BYTES = 2400000 // server rejects above 3 MB — stay under
  var MAX_ASSET_BYTES = 200000 // per-file cap for inlined fonts/images
  var ENDPOINT = HOST.replace(/\/$/, '') + '/ingest/' + KEY

  /* One frame per SCREEN, not per record: normalize id-looking path segments
     so /orders/8231 and /orders/9007 land on the same frame. */
  function routeKey(pathname) {
    var segs = (pathname === undefined ? location.pathname : pathname).split('/').map(function (seg) {
      if (!seg) return seg
      if (/^\d+$/.test(seg)) return ':id'
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ':id'
      if (/^[0-9a-f]{16,}$/i.test(seg)) return ':id'
      if (seg.length >= 20 && /^[\w-]+$/.test(seg) && /\d/.test(seg)) return ':id'
      return seg
    })
    var page = segs.join('/') || '/'
    return page.length > 280 ? page.slice(0, 280) : page
  }

  function absUrl(u) {
    try {
      return new URL(u, document.baseURI).href
    } catch (e) {
      return null
    }
  }
  function isSameOrigin(abs) {
    try {
      return new URL(abs).origin === location.origin
    } catch (e) {
      return false
    }
  }

  /* CSS must come from the CSSOM, not the markup: styled-components/emotion
     insert rules via insertRule and their <style> tags serialize empty.
     Same-origin sheets are readable; cross-origin ones are kept as links. */
  function collectCss() {
    var css = ''
    var links = []
    var sheets = []
    var i
    for (i = 0; i < document.styleSheets.length; i++) sheets.push(document.styleSheets[i])
    if (document.adoptedStyleSheets) {
      for (i = 0; i < document.adoptedStyleSheets.length; i++) sheets.push(document.adoptedStyleSheets[i])
    }
    for (i = 0; i < sheets.length; i++) {
      var sheet = sheets[i]
      try {
        if (sheet.media && sheet.media.mediaText && !matchMedia(sheet.media.mediaText).matches) continue
        var rules = sheet.cssRules
        var text = ''
        for (var r = 0; r < rules.length; r++) text += rules[r].cssText + '\n'
        css += text
      } catch (e) {
        if (sheet.href) links.push(sheet.href)
      }
    }
    return { css: css, links: links }
  }

  /* Same-origin assets are unreachable for anyone viewing the frame from
     outside this network (VPN, localhost) — and webfonts additionally demand
     CORS even when reachable. Inlining as data: URIs is the only rendering
     that works for every viewer. Cached across captures; a null means
     skipped/failed so we don't retry every capture. */
  var assetCache = {}

  function toDataUri(abs, budget) {
    if (assetCache[abs] !== undefined) return Promise.resolve(assetCache[abs])
    return fetch(abs)
      .then(function (r) {
        if (!r.ok) throw new Error('' + r.status)
        return r.blob()
      })
      .then(function (blob) {
        if (blob.size > MAX_ASSET_BYTES || blob.size > budget.left) {
          assetCache[abs] = null
          return null
        }
        return new Promise(function (resolve, reject) {
          var fr = new FileReader()
          fr.onload = function () {
            resolve(fr.result)
          }
          fr.onerror = reject
          fr.readAsDataURL(blob)
        }).then(function (uri) {
          budget.left -= blob.size
          assetCache[abs] = uri
          return uri
        })
      })
      ['catch'](function () {
        assetCache[abs] = null
        return null
      })
  }

  var FONT_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g

  /* Fetch every same-origin font the CSS references, then swap the url()s. */
  function inlineCssFonts(css, budget) {
    var jobs = []
    var m
    FONT_URL.lastIndex = 0
    while ((m = FONT_URL.exec(css))) {
      var u = m[2]
      if (/^data:/.test(u) || !/\.(woff2?|ttf|otf|eot)([?#]|$)/i.test(u)) continue
      var abs = absUrl(u)
      if (abs && isSameOrigin(abs) && assetCache[abs] === undefined) jobs.push(toDataUri(abs, budget))
    }
    return Promise.all(jobs).then(function () {
      return css.replace(FONT_URL, function (all, q, u) {
        var abs = absUrl(u)
        var data = abs && assetCache[abs]
        return data ? 'url(' + q + data + q + ')' : all
      })
    })
  }

  /* Inline small same-origin images; absolutize everything else. Pairing is
     done against the full clone BEFORE nodes are removed, so live and cloned
     img lists line up index for index. */
  function inlineImages(imgPairs, budget) {
    var jobs = []
    imgPairs.forEach(function (pair) {
      var src = pair.live.currentSrc || pair.live.src
      if (!src || /^data:/.test(src)) return
      var abs = absUrl(src)
      if (!abs) return
      pair.clone.setAttribute('src', abs)
      pair.clone.removeAttribute('srcset')
      pair.clone.removeAttribute('sizes')
      if (!isSameOrigin(abs)) return
      jobs.push(
        toDataUri(abs, budget).then(function (data) {
          if (data) pair.clone.setAttribute('src', data)
        }),
      )
    })
    return Promise.all(jobs)
  }

  function snapshotDom() {
    var root = document.documentElement.cloneNode(true)

    /* pair images while both trees are still structurally identical */
    var liveImgs = document.querySelectorAll('img')
    var cloneImgs = root.querySelectorAll('img')
    var imgPairs = []
    var i
    for (i = 0; i < cloneImgs.length && i < liveImgs.length; i++) {
      imgPairs.push({ live: liveImgs[i], clone: cloneImgs[i] })
    }

    var kill = root.querySelectorAll(
      'script,noscript,iframe,frame,frameset,object,embed,applet,portal,fencedframe,' +
        'link[rel="stylesheet"],link[rel="preload"],link[rel="modulepreload"],style,base,meta[http-equiv],' +
        '[data-doop-sync-ignore]',
    )
    for (i = kill.length - 1; i >= 0; i--) kill[i].parentNode && kill[i].parentNode.removeChild(kill[i])

    /* A live DOM can nest <a> inside <a> (React builds via DOM APIs), but
       serialized HTML cannot: reparsing closes the outer link at the inner
       one and spills the outer's content out as siblings. Demote inner
       links/buttons to spans — their classes keep the visual styling. */
    var nested = root.querySelectorAll('a a, button button')
    for (i = 0; i < nested.length; i++) {
      var link = nested[i]
      var span = document.createElement('span')
      for (var n = 0; n < link.attributes.length; n++)
        span.setAttribute(link.attributes[n].name, link.attributes[n].value)
      if (span.hasAttribute('href')) {
        span.setAttribute('data-href', span.getAttribute('href'))
        span.removeAttribute('href')
      }
      while (link.firstChild) span.appendChild(link.firstChild)
      link.parentNode.replaceChild(span, link)
    }

    var all = root.querySelectorAll('*')
    for (i = 0; i < all.length; i++) {
      var el = all[i]
      for (var a = el.attributes.length - 1; a >= 0; a--) {
        var attr = el.attributes[a]
        var name = attr.name.toLowerCase()
        if (name.indexOf('on') === 0 || name === 'srcdoc' || name === 'ping') el.removeAttribute(attr.name)
        else if (/^\s*javascript:/i.test(attr.value) && /^(href|src|action|formaction|poster|xlink:href)$/.test(name))
          el.removeAttribute(attr.name)
      }
    }

    /* never ship what people typed — the snapshot is about the design */
    var inputs = root.querySelectorAll('input,textarea')
    for (i = 0; i < inputs.length; i++) {
      inputs[i].removeAttribute('value')
      if (inputs[i].tagName === 'TEXTAREA') inputs[i].textContent = ''
    }
    var masked = MASK ? root.querySelectorAll('[data-doop-mask],' + MASK) : root.querySelectorAll('[data-doop-mask]')
    for (i = 0; i < masked.length; i++) masked[i].textContent = '•••'

    var styles = collectCss()
    /* phase 1 ends here: everything above is cheap DOM work whose serialized
       form is stable — the content hash is computed on it so unchanged
       screens skip phase 2 (asset fetches + base64) entirely */
    return { root: root, css: styles.css, cssLinks: styles.links, imgPairs: imgPairs, pre: root.outerHTML + styles.css }
  }

  /* phase 2: the expensive part — fetch + base64 same-origin fonts/images,
     then assemble the final document. Runs only for snapshots being sent. */
  function finalizeSnapshot(snap) {
    var budget = { left: Math.max(0, MAX_BYTES - snap.pre.length) }
    return Promise.all([inlineCssFonts(snap.css, budget), inlineImages(snap.imgPairs, budget)]).then(
      function (results) {
        var head = snap.root.querySelector('head')
        var inject = ''
        for (var l = 0; l < snap.cssLinks.length; l++) {
          inject += '<link rel="stylesheet" href="' + snap.cssLinks[l].replace(/"/g, '&quot;') + '">'
        }
        inject += '<style data-doop-sync>\n' + results[0].replace(/<\/style/gi, '<\\/style') + '\n</style>'
        if (head) head.insertAdjacentHTML('beforeend', inject)
        return '<!doctype html>\n' + snap.root.outerHTML
      },
    )
  }

  /* ---- flow map: which link sits where, and where people actually went */

  /* Same-app link hotspots visible on this screen, in document coordinates —
     doop draws them as connectors between the synced frames. */
  function collectLinks(page) {
    var out = []
    var anchors = document.querySelectorAll('a[href]')
    for (var i = 0; i < anchors.length && out.length < 100; i++) {
      var a = anchors[i]
      var abs = absUrl(a.getAttribute('href'))
      if (!abs || !isSameOrigin(abs)) continue
      var to
      try {
        to = routeKey(new URL(abs).pathname)
      } catch (e) {
        continue
      }
      if (to === page) continue
      var rect = a.getBoundingClientRect()
      if (rect.width < 2 || rect.height < 2) continue
      out.push({
        to: to,
        x: rect.left + window.scrollX,
        y: rect.top + window.scrollY,
        w: rect.width,
        h: rect.height,
        label: (a.getAttribute('aria-label') || a.textContent || '').trim().slice(0, 60),
      })
    }
    return out
  }

  /* Navigations users make are the traffic weights on the link map. Edges
     ride along on the next upload; an unchanged screen flushes them alone. */
  var lastPage = routeKey()
  var pendingEdges = []
  function recordNav() {
    var now = routeKey()
    if (now !== lastPage) {
      if (pendingEdges.length < 20) pendingEdges.push({ from: lastPage, to: now })
      lastPage = now
      /* a new screen opens a fresh untouched window — re-arm and re-stash */
      armInteractionWatch()
      scheduleStashes()
    }
  }

  function hash(s) {
    var h = 5381
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
    return String(h)
  }

  /* CAPTURE_VERSION invalidates the dedup when the capture format changes —
     an upgraded snippet must re-upload screens whose HTML alone is unchanged
     (e.g. to populate the flow map's link hotspots). v3: the hash moved to
     the pre-asset-inline serialization. */
  var CAPTURE_VERSION = '3'
  function memoKey(page) {
    return '__doopSync:' + CAPTURE_VERSION + ':' + KEY.slice(-6) + ':' + page
  }

  function readMemo(page) {
    try {
      return JSON.parse(localStorage.getItem(memoKey(page)) || 'null')
    } catch (e) {
      return null
    }
  }
  function writeMemo(page, memo) {
    try {
      localStorage.setItem(memoKey(page), JSON.stringify(memo))
    } catch (e) {
      /* private mode — fine, we just lose the dedup */
    }
  }

  function shouldSend(page, h) {
    var memo = readMemo(page)
    if (!memo) return true
    if (memo.s) return false // frozen server-side — this screen is settled
    if (memo.h === h && Date.now() - memo.t < 6 * 3600000) return false // unchanged — server has it
    return Date.now() - memo.t >= MIN_RESEND_MS
  }

  /* Cheapest skip of all: a global mutation counter. If the DOM hasn't
     changed since the last confirmed capture of this screen, there is
     nothing new to serialize — the scroll/nav trigger costs nothing. */
  var mutationCount = 0
  var capturedAtMutation = {}
  try {
    new MutationObserver(function (list) {
      mutationCount += list.length
    }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true })
  } catch (e) {
    /* no observer — every trigger serializes, as before */
  }

  /* Flush pending navigations without a snapshot. Requeue unless the
     server's marker proves the batch was recorded: its rate-limit 429 fires
     before recording, the page-throttle 429 after. */
  function sendEdges(page) {
    if (!pendingEdges.length) return
    var batch = pendingEdges.splice(0, 20)
    return fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({ page: page, edges: batch }),
    })
      .then(function (r) {
        if (r.headers.get('X-Doop-Edges') !== null) batch = []
        if (!r.ok) throw new Error('sync ' + r.status)
      })
      ['catch'](function () {
        if (batch.length) pendingEdges = batch.concat(pendingEdges).slice(0, 20)
      })
  }

  /* Screens should sync as they GREET the user, but hovering a nav opens
     mega-menus, clicks open modals, keys move focus — and the settle delay
     gives visitors plenty of time to do all three before the first capture.
     From the first interaction on, the live DOM is suspect: it never
     replaces a copy the server already has, and a screen the server lacks
     ships from the pristine stash below instead. mouseover only counts over
     interactive elements, so wheel-scrolling past body text stays untouched
     and the scroll re-capture can still cure reveal animations. */
  var interacted = false
  var INTERACT_EVENTS = ['mouseover', 'pointerdown', 'keydown']
  var HOVER_RISK =
    'nav,header,a,button,summary,select,[role="button"],[role="menu"],[role="menubar"],' +
    '[aria-haspopup],[aria-expanded],[tabindex]'
  function onInteract(e) {
    if (e.type === 'mouseover' && !(e.target && e.target.closest && e.target.closest(HOVER_RISK))) return
    /* Last pristine instant: this capture-phase listener runs BEFORE the
       app's own handler opens a menu or modal, so stashing synchronously
       here beats any timer race — including the cursor already resting on
       the nav when the page loads (interaction at ~0ms, both timers late).
       One-time cost on first interaction, and only if no stash exists yet. */
    if (!(pristine && pristine.page === routeKey())) stashPristine()
    interacted = true
    for (var i = 0; i < INTERACT_EVENTS.length; i++) window.removeEventListener(INTERACT_EVENTS[i], onInteract, true)
  }
  function armInteractionWatch() {
    interacted = false
    for (var i = 0; i < INTERACT_EVENTS.length; i++) window.addEventListener(INTERACT_EVENTS[i], onInteract, true)
  }
  armInteractionWatch()

  /* Snapshotted (phase 1 only — cheap) while the page is still untouched;
     finalized and uploaded in place of the live DOM when the user started
     poking before the settle capture fired. Stashed twice: early so fast
     hoverers don't beat it, late so skeletons have resolved. */
  var pristine = null
  var stashTimers = []
  function stashPristine() {
    if (interacted) return
    try {
      pristine = { page: routeKey(), snap: snapshotDom() }
    } catch (e) {
      /* a failed stash just means capture falls back to the live DOM */
    }
  }
  function scheduleStashes() {
    for (var i = 0; i < stashTimers.length; i++) clearTimeout(stashTimers[i])
    stashTimers = [setTimeout(stashPristine, 400), setTimeout(stashPristine, 1600)]
  }

  var capturing = false
  function capture(force) {
    if (capturing) return
    var page = routeKey()
    var memo = readMemo(page)
    var poked = !force && interacted
    if (!force && ((memo && memo.s) || capturedAtMutation[page] === mutationCount || (poked && memo))) {
      /* frozen screen, untouched DOM, or a poked-at DOM that must not
         replace a copy the server already has — only navigations flow */
      sendEdges(page)
      return
    }
    capturing = true
    var mc = mutationCount // state this capture describes — mutations during the async pipeline stay pending
    var usedPristine = false
    var sentSnapshot = false
    var edges = []
    /* Promise.resolve().then keeps a synchronous throw inside snapshotDom on
       the promise chain — it must hit the catch below, or `capturing` wedges
       shut and every later capture silently no-ops. */
    Promise.resolve()
      .then(function () {
        if (poked && pristine && pristine.page === page) {
          usedPristine = true
          return pristine.snap
        }
        return snapshotDom()
      })
      .then(function (snap) {
        var h = hash(snap.pre)
        if (!force && !shouldSend(page, h)) {
          /* content unchanged — remember which DOM state we confirmed, so
             later triggers skip even the serialize (unless the snapshot was
             the stash: the live DOM was never compared) */
          capturing = false
          if (!usedPristine) capturedAtMutation[page] = mc
          return sendEdges(page)
        }
        edges = pendingEdges.splice(0, 20)
        return finalizeSnapshot(snap).then(function (html) {
          capturing = false
          if (html.length > MAX_BYTES) {
            console.warn('[doop-sync] snapshot too large (' + html.length + ' bytes) — not uploading')
            return
          }
          writeMemo(page, { h: h, t: Date.now() })
          sentSnapshot = true
          return fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            keepalive: html.length < 60000, // keepalive caps the body — big snapshots go without it
            body: JSON.stringify({
              page: page,
              title: document.title,
              url: location.href,
              width: window.innerWidth,
              height: Math.min(document.documentElement.scrollHeight, 8000),
              html: html,
              links: collectLinks(page),
              edges: edges,
            }),
          }).then(function (r) {
            if (r.headers.get('X-Doop-Edges') !== null) edges = [] // recorded server-side — see sendEdges
            if (!r.ok) throw new Error('sync ' + r.status)
            if (r.headers.get('X-Doop-Synced') !== null) writeMemo(page, { s: 1, t: Date.now() }) // frozen for good
            if (!usedPristine) capturedAtMutation[page] = mc
          })
        })
      })
      ['catch'](function (err) {
        /* never break the host app over a sync error — but log it, put the
           drained navigations back so counts don't under-report, and if a
           SNAPSHOT upload failed drop its memo so the next capture retries
           instead of skipping. An edges-only failure keeps the memo — losing
           it would let a poked-at DOM slip past the gate above. */
        console.warn('[doop-sync] capture failed', err)
        capturing = false
        if (edges.length) pendingEdges = edges.concat(pendingEdges).slice(0, 20)
        if (sentSnapshot) {
          try {
            localStorage.removeItem(memoKey(page))
          } catch (e2) {
            /* private mode */
          }
        }
      })
  }

  var timer = null
  function schedule(delay) {
    if (timer) clearTimeout(timer)
    timer = setTimeout(function () {
      timer = null
      if (document.visibilityState !== 'hidden') capture(false)
    }, delay || SETTLE_MS)
  }

  /* initial screen + every SPA navigation */
  function onLoad() {
    scheduleStashes()
    schedule()
  }
  if (document.readyState === 'complete') onLoad()
  else window.addEventListener('load', onLoad)
  var push = history.pushState
  history.pushState = function () {
    var out = push.apply(this, arguments)
    recordNav()
    schedule()
    return out
  }
  var replace = history.replaceState
  history.replaceState = function () {
    var out = replace.apply(this, arguments)
    recordNav()
    schedule()
    return out
  }
  window.addEventListener('popstate', function () {
    recordNav()
    schedule()
  })

  /* Scroll-reveal animations leave below-the-fold content at opacity 0 until
     seen; a capture from the top of the page freezes that. Re-capture after
     scrolling stops — the hash memo turns fully-revealed pages into a single
     update and everything else into a no-op. */
  window.addEventListener(
    'scroll',
    function () {
      schedule(1800)
    },
    { passive: true },
  )

  window.doopSync = {
    capture: function () {
      capture(true)
    },
  }
})()
