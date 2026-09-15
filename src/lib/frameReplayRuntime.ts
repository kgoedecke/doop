/** Runs in the opaque-origin frame. Only the parent can enable capture; the
 * bundled rrweb recorder forwards into the parent's replay via postMessage.
 * No PostHog identity, storage, API key, or independent network capture here. */
export const FRAME_REPLAY_RUNTIME = `
  var replayStop = null
  var replayOptions = null
  var replayGeneration = -1
  var replayScript = null
  var replayRetryTimer = null
  var replayAttempts = 0
  var replayUrl = null
  var replaySnapshot = false
  function syncReplay() {
    var rr = window.__PosthogExtensions__ && window.__PosthogExtensions__.rrweb
    if (!replayOptions) return
    if (!rr) { loadReplay(); return }
    if (!replayStop) {
      replayStop = rr.record(Object.assign({}, replayOptions, {
        recordCrossOriginIframes: true,
        // Match PostHog's defaults, including suppression of runtime scripts.
        slimDOMOptions: replayOptions.slimDOMOptions || {},
        errorHandler: function () { return true }
      }))
    } else if (replaySnapshot) {
      rr.record.takeFullSnapshot()
    }
    replaySnapshot = false
  }
  function loadReplay() {
    // Three total attempts per recording generation, with 250/500ms backoff.
    if (!replayOptions || replayScript || replayRetryTimer || replayAttempts >= 3) return
    replayAttempts++
    var script = document.createElement('script')
    replayScript = script
    script.setAttribute('data-doop-replay', '')
    script.src = replayUrl
    script.onload = function () {
      script.remove()
      replayScript = null
      syncReplay()
    }
    script.onerror = function () {
      script.remove()
      replayScript = null
      if (replayOptions && replayAttempts < 3) {
        replayRetryTimer = setTimeout(function () {
          replayRetryTimer = null
          syncReplay()
        }, 250 * Math.pow(2, Math.max(0, replayAttempts - 1)))
      }
    }
    // Outside head/body: streamed HTML morphs must not remove a pending load.
    document.documentElement.appendChild(script)
  }
  window.addEventListener('message', function (ev) {
    if (ev.source !== parent || !ev.data || ev.data.type !== 'doop:replay') return
    var d = ev.data
    if (d.generation !== replayGeneration || !d.options) {
      if (replayStop) replayStop()
      replayStop = null
      if (replayRetryTimer) clearTimeout(replayRetryTimer)
      replayRetryTimer = null
      replayAttempts = replayScript ? 1 : 0
    }
    replayGeneration = d.generation
    replayOptions = d.options
    replayUrl = d.url
    replaySnapshot = replaySnapshot || d.snapshot
    syncReplay()
  })
`
