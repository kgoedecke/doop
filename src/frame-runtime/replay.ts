import { clearTimeout, setTimeout } from './timers'

/* Session replay inside the opaque-origin frame. Only the parent can enable
   capture; the bundled rrweb recorder forwards into the parent's replay via
   postMessage. No PostHog identity, storage, API key, or independent network
   capture here. */

type ReplayOptions = Record<string, unknown> & { slimDOMOptions?: unknown }

interface Recorder {
  record: ((options: Record<string, unknown>) => () => void) & { takeFullSnapshot(): void }
}

/** the window as PostHog's recorder bundle leaves it */
interface ReplayWindow {
  __PosthogExtensions__?: { rrweb?: Recorder }
}

/** what the editor sends with `doop:replay` */
interface ReplayCommand {
  type: 'doop:replay'
  generation: unknown
  options: ReplayOptions | null
  url: string
  snapshot: boolean
}

let replayStop: (() => void) | null = null
let replayOptions: ReplayOptions | null = null
let replayGeneration: unknown = -1
/** the recorder's loader while it loads: the document's own, never saved */
export let replayScript: HTMLScriptElement | null = null
let replayRetryTimer: number | null = null
let replayAttempts = 0
let replayUrl = ''
let replaySnapshot = false

function syncReplay(): void {
  const extensions = (window as ReplayWindow).__PosthogExtensions__
  const rr = extensions && extensions.rrweb
  if (!replayOptions) return
  if (!rr) {
    loadReplay()
    return
  }
  if (!replayStop) {
    replayStop = rr.record(
      Object.assign({}, replayOptions, {
        recordCrossOriginIframes: true,
        // Match PostHog's defaults, including suppression of runtime scripts.
        slimDOMOptions: replayOptions.slimDOMOptions || {},
        errorHandler: () => true,
      }),
    )
  } else if (replaySnapshot) {
    rr.record.takeFullSnapshot()
  }
  replaySnapshot = false
}

function loadReplay(): void {
  // Three total attempts per recording generation, with 250/500ms backoff.
  if (!replayOptions || replayScript || replayRetryTimer || replayAttempts >= 3) return
  replayAttempts++
  const script = document.createElement('script')
  replayScript = script
  script.setAttribute('data-doop-replay', '')
  script.src = replayUrl
  script.onload = () => {
    script.remove()
    replayScript = null
    syncReplay()
  }
  script.onerror = () => {
    script.remove()
    replayScript = null
    if (replayOptions && replayAttempts < 3) {
      replayRetryTimer = setTimeout(
        () => {
          replayRetryTimer = null
          syncReplay()
        },
        250 * Math.pow(2, Math.max(0, replayAttempts - 1)),
      )
    }
  }
  // Outside head/body: streamed HTML morphs must not remove a pending load.
  document.documentElement.appendChild(script)
}

export function installReplay(): void {
  window.addEventListener('message', (ev) => {
    const data = ev.data as Partial<ReplayCommand> | null
    if (ev.source !== parent || !data || data.type !== 'doop:replay') return
    const d = data as ReplayCommand
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
    replaySnapshot = replaySnapshot || !!d.snapshot
    syncReplay()
  })
}
