;(() => {
  if (window.__doopCapture) return
  window.__doopCapture = (mode) => {
    window.__doopCaptureCleanup?.()
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none'
    const shadow = host.attachShadow({ mode: 'closed' })
    shadow.innerHTML =
      '<style>*{box-sizing:border-box}.box{position:fixed;border:2px solid #0177d3;background:#0177d312;pointer-events:none}.bar{position:fixed;top:16px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:14px;max-width:calc(100vw - 32px);padding:12px 16px;background:#fdfdfd;color:#111;border-radius:10px;font:12px "Helvetica Neue",Helvetica,Arial,sans-serif;pointer-events:auto;box-shadow:0 12px 40px -10px #0003,0 0 0 1px #0000000f}button{margin-left:12px;padding:8px 12px;border:0;border-radius:6px;background:#191919;color:white;font:inherit;cursor:pointer}button:hover{background:#333}button:focus-visible{outline:2px solid #0177d3;outline-offset:3px}.brand{font-weight:600;border-right:1px solid #dcdcdc;padding-right:14px;white-space:nowrap}.close{background:#f0f0f0;color:#555}.close:hover{background:#e5e5e5}</style><div class="box"></div><div class="bar"><div class="brand">Doop Cature</div><span role="status" aria-live="polite"></span><button class="close" aria-label="Close capture">Close</button></div>'
    document.documentElement.append(host)
    const label = shadow.querySelector('span')
    const box = shadow.querySelector('.box')
    let selected
    const cleanup = () => {
      host.remove()
      document.removeEventListener('pointermove', move, true)
      document.removeEventListener('click', click, true)
      document.removeEventListener('keydown', key, true)
    }
    window.__doopCaptureCleanup = cleanup
    shadow.querySelector('button').onclick = cleanup
    const move = (event) => {
      if (event.target === host) return
      selected = event.target
      const rect = selected.getBoundingClientRect()
      box.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`
    }
    const key = (event) => {
      if (event.key === 'Escape') cleanup()
    }
    const capture = async (root) => {
      document.removeEventListener('pointermove', move, true)
      document.removeEventListener('click', click, true)
      box.style.display = 'none'
      label.textContent = 'Preparing HTML…'
      try {
        const rect = root.getBoundingClientRect()
        const width = Math.max(1, Math.ceil(mode === 'page' ? document.documentElement.clientWidth : rect.width))
        const height = Math.max(1, Math.ceil(mode === 'page' ? document.documentElement.scrollHeight : rect.height))
        if (!Number.isInteger(width) || !Number.isInteger(height) || width > 30000 || height > 100000)
          throw new Error('Capture dimensions are too large. Select a smaller section.')
        let count = 0
        const forbidden = /^(SCRIPT|STYLE|LINK|META|BASE|IFRAME|OBJECT|EMBED|NOSCRIPT|TEMPLATE|AUDIO|VIDEO)$/
        const copy = (source) => {
          if (source.nodeType === Node.TEXT_NODE) return document.createTextNode(source.textContent)
          if (!(source instanceof Element) || source === host || forbidden.test(source.tagName)) return null
          if (++count > 12000) throw new Error('Page is too complex. Capture a smaller section.')
          const computed = getComputedStyle(source)
          if (computed.display === 'none') return null
          const target = source.cloneNode(false)
          for (const attr of [...target.attributes]) {
            if (
              ![
                'class',
                'id',
                'alt',
                'title',
                'viewBox',
                'd',
                'fill',
                'stroke',
                'xmlns',
                'width',
                'height',
                'cx',
                'cy',
                'r',
                'x',
                'y',
                'points',
                'transform',
                'role',
                'type',
              ].includes(attr.name)
            )
              target.removeAttribute(attr.name)
          }
          const style = target.style
          for (const prop of computed) {
            if (
              [
                '-webkit-user-modify',
                'user-modify',
                '-moz-user-modify',
                'user-select',
                '-webkit-user-select',
                '-moz-user-select',
              ].includes(prop)
            )
              continue
            style.setProperty(prop, computed.getPropertyValue(prop))
          }
          style.setProperty('animation', 'none')
          style.setProperty('transition', 'none')
          if (computed.position === 'sticky' || computed.position === 'fixed') style.position = 'absolute'
          if (source instanceof HTMLImageElement) {
            target.src = source.currentSrc || source.src
            target.loading = 'eager'
          }
          if (source instanceof HTMLInputElement || source instanceof HTMLTextAreaElement) {
            target.value = ''
            target.removeAttribute('value')
            if (target instanceof HTMLInputElement) {
              target.checked = false
              target.indeterminate = false
            }
            target.textContent = ''
          } else
            for (const child of source.childNodes) {
              const cloned = copy(child)
              if (cloned) target.append(cloned)
            }
          return target
        }
        const clone = copy(root)
        if (!clone) throw new Error('This section cannot be captured.')
        clone.style.margin = '0'
        clone.style.position = 'relative'
        clone.style.inset = 'auto'
        const doc = document.implementation.createHTMLDocument(document.title)
        doc.body.style.cssText = 'margin:0'
        if (clone.tagName === 'BODY') doc.body.replaceWith(clone)
        else doc.body.append(clone)
        const html = '<!doctype html>' + doc.documentElement.outerHTML
        if (new TextEncoder().encode(html).length > 3000000)
          throw new Error('Capture exceeds 3 MB. Select a smaller section.')
        const payload =
          'DOOP_CAPTURE_V1\n' + JSON.stringify({ name: document.title || 'Website capture', width, height, html })
        // A visible copy button provides a fresh gesture after capture and keeps failure recoverable.
        label.textContent = 'Ready. '
        const button = document.createElement('button')
        button.textContent = 'Copy to Doop'
        label.append(button)
        button.onclick = async () => {
          try {
            await navigator.clipboard.writeText(payload)
            label.textContent = 'Copied! Paste into your Doop canvas.'
          } catch {
            label.textContent = 'Clipboard denied. Keep this tab focused and capture again.'
          }
        }
      } catch (error) {
        label.textContent = error.message
      }
    }
    const click = (event) => {
      if (event.target === host || !selected) return
      event.preventDefault()
      event.stopImmediatePropagation()
      void capture(selected)
    }
    document.addEventListener('keydown', key, true)
    if (mode === 'page') void capture(document.body)
    else {
      label.textContent = 'Click a section to capture · Esc to cancel'
      document.addEventListener('pointermove', move, true)
      document.addEventListener('click', click, true)
    }
  }
})()
