import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import type { Frame } from '../../shared/types'
import type { Interaction, ProtoTransition } from '../../shared/prototype'
import { useStore } from '../lib/store'
import { FRAME_BOOTSTRAP } from '../lib/frameRuntime'
import {
  fitScale,
  historyStep,
  protoHistoryState,
  readProtoHistory,
  sanitizeInteraction,
  transitionFrames,
} from '../lib/prototypePlayer'
import { prototypePath } from '../lib/prototype'
import { IconButton } from './ui/icon-button'
import { ArrowLeftIcon, ExportIcon, HistoryIcon, HotspotIcon, XIcon } from './ui/icons'

/* One screen on the player's history stack: the frame it shows and how it
   arrived, so Back can play that transition in reverse. The key is unique per
   visit — going back mounts a fresh document, as a reload of that page would.
   The depth is the screen's position in the flow (0 for the start), which the
   browser history entries carry too, so a popstate knows where it landed even
   when a screen repeats. */
interface Entry {
  key: number
  frameId: string
  transition: ProtoTransition
  duration: number
  depth: number
}

/* a navigation in flight: both screens are mounted until it settles */
interface Move {
  from: Entry
  to: Entry
  transition: ProtoTransition
  duration: number
  back: boolean
  ready: boolean
}

const MAX_HISTORY = 50
const EASING = 'cubic-bezier(0.2, 0.7, 0.2, 1)'
/* a hair of the frame's own canvas around an overlay, so its edge reads */
const OVERLAY_FIT = 0.94

/**
 * The prototype player: the frame fills the viewport (letterboxed, scaled to
 * fit) and its interactions run. Each frame's runtime reports triggers as
 * `doop:proto-action`; the player keeps the history stack, the overlays and
 * the transitions, which animate two stacked iframes. Frames stay live: an
 * edit streaming into one re-renders here as it does on the canvas.
 *
 * `onClose` set: presenting over the editor — Esc (with nothing else to
 * close) exits. `syncUrl`: the full-page route — each navigation is a browser
 * history entry, so the browser's Back and Forward walk the flow.
 */
export function PrototypePlayer({
  startFrameId,
  onClose,
  syncUrl = false,
}: {
  startFrameId: string
  onClose?: () => void
  syncUrl?: boolean
}) {
  const frames = useStore((s) => s.canvas?.frames)
  const canvasId = useStore((s) => s.canvas?.id)
  const frameById = useCallback((id: string) => frames?.find((f) => f.id === id), [frames])

  const seq = useRef(0)
  const nextKey = () => ++seq.current
  const [stack, setStackState] = useState<Entry[]>(() => [entryFor(startFrameId, 0)])
  const [overlays, setOverlaysState] = useState<Entry[]>([])
  const [move, setMoveState] = useState<Move | null>(null)
  const [readyOverlays, setReadyOverlays] = useState<ReadonlySet<number>>(() => new Set())
  const [notice, setNotice] = useState<string | null>(null)
  /* the handlers below run from message listeners: they read the latest
     state through these refs, written together with the state */
  const stackRef = useRef(stack)
  const overlaysRef = useRef(overlays)
  const moveRef = useRef(move)
  const setStack = (next: Entry[]) => {
    stackRef.current = next
    setStackState(next)
  }
  const setOverlays = (next: Entry[]) => {
    overlaysRef.current = next
    setOverlaysState(next)
  }
  const setMove = (next: Move | null) => {
    moveRef.current = next
    setMoveState(next)
  }
  const running = useRef<Animation[]>([])
  const wrappers = useRef(new Map<number, HTMLDivElement>())
  const windows = useRef(new Map<number, Window>())
  /* what letting go of a press undoes: the overlay or the navigation it
     opened, by the key of the entry it made — once the flow has moved past
     that entry there is nothing left to undo */
  const pressRevert = useRef<{ action: 'overlay' | 'navigate'; key: number } | null>(null)
  const noticeTimer = useRef<number | null>(null)

  const [viewport, setViewport] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }))
  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  function entryFor(
    frameId: string,
    key: number,
    transition: ProtoTransition = 'instant',
    duration = 0,
    depth = 0,
  ): Entry {
    return { key, frameId, transition, duration, depth }
  }

  function flash(message: string) {
    setNotice(message)
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(null), 2400)
  }

  /* a navigation that starts while another animates snaps that one to its end */
  function settle() {
    const anims = running.current
    running.current = []
    for (const a of anims) a.cancel()
    if (moveRef.current) setMove(null)
  }

  function navigate(frameId: string, transition: ProtoTransition, duration: number) {
    if (!frameById(frameId)) return flash('That screen is no longer on the canvas')
    settle()
    const current = stackRef.current
    const from = current.at(-1)!
    const to = entryFor(frameId, nextKey(), transition, duration, from.depth + 1)
    setOverlays([])
    setStack([...current, to].slice(-MAX_HISTORY))
    setMove({ from, to, transition, duration, back: false, ready: false })
    if (syncUrl) history.pushState(protoHistoryState(frameId, to.depth), '', prototypeUrl(frameId))
  }

  /* the browser's history moved somewhere other than one screen back: show
     that screen at that depth, keeping the screens before it */
  function jumpTo(frameId: string, depth: number) {
    if (!frameById(frameId)) return flash('That screen is no longer on the canvas')
    settle()
    const kept = stackRef.current.filter((e) => e.depth < depth)
    setOverlays([])
    setStack([...kept, entryFor(frameId, nextKey(), 'instant', 0, depth)].slice(-MAX_HISTORY))
  }

  function prototypeUrl(frameId: string) {
    return canvasId ? prototypePath(canvasId, frameId) : location.pathname
  }

  /* Back pops one screen; with the browser's history in play the popstate
     handler does it, so both stay in step */
  function back(fromHistory = false) {
    /* overlays are not history entries: the browser's Back leaves the screen */
    if (!fromHistory && overlaysRef.current.length) return closeOverlay()
    const current = stackRef.current
    if (current.length < 2) return
    if (syncUrl && !fromHistory) return history.back()
    settle()
    const from = current.at(-1)!
    const prev = current.at(-2)!
    if (!frameById(prev.frameId)) return flash('That screen is no longer on the canvas')
    const to = { ...prev, key: nextKey() }
    setOverlays([])
    setStack([...current.slice(0, -2), to])
    setMove({ from, to, transition: from.transition, duration: from.duration, back: true, ready: false })
  }

  function openOverlay(frameId: string, transition: ProtoTransition, duration: number) {
    if (!frameById(frameId)) return flash('That overlay is no longer on the canvas')
    setOverlays([...overlaysRef.current, entryFor(frameId, nextKey(), transition, duration)])
  }

  function closeOverlay() {
    setOverlays(overlaysRef.current.slice(0, -1))
  }

  /* the start again, in place of the current browser entry (at its depth, so
     the entries behind it still read as earlier screens) */
  function restart() {
    settle()
    const depth = syncUrl ? (stackRef.current.at(-1)?.depth ?? 0) : 0
    setOverlays([])
    setStack([entryFor(startFrameId, nextKey(), 'instant', 0, depth)])
    if (syncUrl) history.replaceState(protoHistoryState(startFrameId, depth), '', prototypeUrl(startFrameId))
  }

  function run(raw: unknown, press: boolean) {
    const interaction = sanitizeInteraction(raw)
    if (!interaction) return
    /* any other interaction leaves a held press pending: release checks the
       entry it opened is still on top, so it cannot undo a different screen */
    perform(interaction)
    if (!press || (interaction.action !== 'overlay' && interaction.action !== 'navigate')) return
    const opened = interaction.action === 'overlay' ? overlaysRef.current.at(-1) : stackRef.current.at(-1)
    if (opened) pressRevert.current = { action: interaction.action, key: opened.key }
  }

  function perform(i: Interaction) {
    switch (i.action) {
      case 'navigate':
        return navigate(i.target!, i.transition, i.duration)
      case 'overlay':
        return openOverlay(i.target!, i.transition, i.duration)
      case 'back':
        return back()
      case 'close-overlay':
        return closeOverlay()
      case 'url':
        window.open(i.target, '_blank', 'noopener,noreferrer')
        return
      case 'scroll-to':
        return // the frame scrolls itself
    }
  }

  function release() {
    const revert = pressRevert.current
    pressRevert.current = null
    if (revert?.action === 'overlay' && overlaysRef.current.at(-1)?.key === revert.key) closeOverlay()
    else if (
      revert?.action === 'navigate' &&
      !overlaysRef.current.length &&
      stackRef.current.at(-1)?.key === revert.key
    )
      back()
  }

  /* Escape: an open overlay closes first; then the screen's own key:Escape
     interaction; then, over the editor, the player itself */
  function escape() {
    if (overlaysRef.current.length) return closeOverlay()
    const win = topWindow()
    if (!win) return onClose?.()
    askKey(win, 'Escape')
      .then((handled) => !handled && onClose?.())
      .catch(console.error)
  }

  function topWindow(): Window | undefined {
    const top = overlaysRef.current.at(-1) ?? moveRef.current?.to ?? stackRef.current.at(-1)
    return top ? windows.current.get(top.key) : undefined
  }

  function onScreenReady(key: number) {
    const m = moveRef.current
    if (!m || m.to.key !== key) return
    if (m.transition === 'instant' || m.duration === 0) return setMove(null)
    const next = { ...m, ready: true }
    setMove(next)
    const { incoming, outgoing } = transitionFrames(m.transition, m.back)
    const options: KeyframeAnimationOptions = { duration: m.duration, easing: EASING, fill: 'both' }
    const anims = [
      incoming.length ? wrappers.current.get(m.to.key)?.animate(incoming, options) : undefined,
      outgoing.length ? wrappers.current.get(m.from.key)?.animate(outgoing, options) : undefined,
    ].filter((a): a is Animation => !!a)
    running.current = anims
    Promise.all(anims.map((a) => a.finished))
      .then(() => {
        if (moveRef.current !== next) return
        running.current = []
        setMove(null)
      })
      .catch(() => {
        /* cancelled by a newer navigation, which owns the screens now */
      })
  }

  function onOverlayReady(entry: Entry) {
    setReadyOverlays((ready) => new Set(ready).add(entry.key))
    const { incoming } = transitionFrames(entry.transition, false)
    if (incoming.length)
      wrappers.current.get(entry.key)?.animate(incoming, { duration: entry.duration, easing: EASING, fill: 'both' })
  }

  /* the latest handlers for the listeners below, which subscribe once */
  const handlers = useRef({ escape, back, jumpTo, release, topWindow })
  useLayoutEffect(() => {
    handlers.current = { escape, back, jumpTo, release, topWindow }
  })

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      /* capture phase, and modal: no key reaches the editor underneath (an
         arrow would nudge the selected frame, Delete would remove it) */
      e.stopPropagation()
      if (e.key === 'Escape') return handlers.current.escape()
      if (e.repeat || e.metaKey || e.ctrlKey) return
      const win = handlers.current.topWindow()
      win?.postMessage({ type: 'doop:proto-key', key: e.key, reqId: `key-${e.timeStamp}` }, '*')
    }
    const onUp = () => handlers.current.release()
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerup', onUp)
    }
  }, [])
  useEffect(() => {
    if (!syncUrl) return
    /* the entry the player opened on records its start screen, so Back to it
       restores the start even when its URL names no frame (?page=, or none) */
    const start = stackRef.current[0]!
    history.replaceState({ ...readState(), ...protoHistoryState(start.frameId, start.depth) }, '', location.href)
    function onPop(e: PopStateEvent) {
      const target = readProtoHistory(e.state)
      if (!target) return
      const step = historyStep(stackRef.current, target)
      if (step === 'back') handlers.current.back(true)
      else if (step === 'jump') handlers.current.jumpTo(target.frameId, target.depth)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [syncUrl])

  useEffect(
    () => () => {
      if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
    },
    [],
  )

  function flashHotspots() {
    for (const win of windows.current.values()) win.postMessage({ type: 'doop:proto-hotspots' }, '*')
  }

  const current = stack.at(-1)!
  const base: { entry: Entry; role: 'from' | 'to' | 'still' }[] = move
    ? [
        { entry: move.from, role: 'from' },
        { entry: move.to, role: 'to' },
      ]
    : [{ entry: current, role: 'still' }]
  const outgoingOnTop = move ? transitionFrames(move.transition, move.back).outgoingOnTop : false
  const shownFrame = frameById((move?.to ?? current).frameId)
  const baseFrame = frameById(current.frameId)
  const baseScale = baseFrame ? fitScale(baseFrame, viewport) : 1

  const screenProps = (entry: Entry) => ({
    entry,
    frame: frameById(entry.frameId),
    register: (key: number, win: Window | null) => {
      if (win) windows.current.set(key, win)
      else windows.current.delete(key)
    },
    onMessage: (data: { type?: string; interaction?: unknown; press?: boolean }) => {
      if (data.type === 'doop:proto-action') run(data.interaction, !!data.press)
      else if (data.type === 'doop:proto-release') release()
      /* Escape with the focus in a screen: the same overlay-first path as a
         key pressed on the player itself */
      else if (data.type === 'doop:esc') escape()
    },
  })

  return (
    <div
      className="fixed inset-0 z-[80] overflow-hidden bg-code"
      role="dialog"
      aria-label={`Prototype: ${shownFrame?.name ?? 'missing screen'}`}
      data-prototype-player=""
    >
      {base.map(({ entry, role }) => {
        const frame = frameById(entry.frameId)
        return (
          <div
            key={entry.key}
            ref={(el) => {
              if (el) wrappers.current.set(entry.key, el)
              else wrappers.current.delete(entry.key)
            }}
            className="absolute inset-0 grid place-items-center"
            data-proto-screen={entry.frameId}
            data-proto-role={role}
            style={{
              zIndex: role === 'from' ? (outgoingOnTop ? 2 : 1) : role === 'to' ? (outgoingOnTop ? 1 : 2) : 1,
              /* the incoming screen stays hidden until its document has rendered */
              visibility: role === 'to' && !move?.ready ? 'hidden' : undefined,
            }}
          >
            <ProtoScreen
              {...screenProps(entry)}
              scale={frame ? fitScale(frame, viewport) : 1}
              interactive={role !== 'from'}
              onReady={onScreenReady}
            />
          </div>
        )
      })}

      {overlays.map((entry) => {
        const frame = frameById(entry.frameId)
        const scale = frame
          ? Math.min(baseScale, fitScale(frame, { w: viewport.w * OVERLAY_FIT, h: viewport.h * OVERLAY_FIT }))
          : 1
        return (
          <div key={entry.key} className="absolute inset-0 z-[5] grid place-items-center">
            <div className="absolute inset-0 bg-black/45" data-proto-scrim="" onClick={closeOverlay} />
            <div
              ref={(el) => {
                if (el) wrappers.current.set(entry.key, el)
                else wrappers.current.delete(entry.key)
              }}
              className="relative shadow-pop"
              data-proto-overlay={entry.frameId}
              style={{ opacity: readyOverlays.has(entry.key) ? 1 : 0 }}
            >
              <ProtoScreen {...screenProps(entry)} scale={scale} interactive onReady={() => onOverlayReady(entry)} />
            </div>
          </div>
        )
      })}

      <div className="absolute top-3 right-3 z-10 flex items-center gap-1 rounded-pill bg-black/55 p-1 text-code-ink opacity-70 backdrop-blur-[6px] transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100">
        <span className="max-w-[180px] truncate px-2 text-caption text-code-ink/80" data-proto-current="">
          {shownFrame?.name ?? 'Missing screen'}
        </span>
        <IconButton
          size="sm"
          className={playerBtn}
          aria-label="Back"
          disabled={stack.length < 2 && !overlays.length}
          onClick={() => back()}
        >
          <ArrowLeftIcon size="rail" />
        </IconButton>
        <IconButton size="sm" className={playerBtn} aria-label="Restart prototype" onClick={restart}>
          <HistoryIcon size="rail" />
        </IconButton>
        <IconButton size="sm" className={playerBtn} aria-label="Show hotspots" onClick={flashHotspots}>
          <HotspotIcon size="rail" />
        </IconButton>
        {onClose && canvasId && (
          <IconButton
            size="sm"
            className={playerBtn}
            aria-label="Open prototype in a new tab"
            onClick={() => window.open(prototypePath(canvasId, current.frameId), '_blank', 'noopener')}
          >
            <ExportIcon size="rail" />
          </IconButton>
        )}
        {onClose && (
          <IconButton size="sm" className={playerBtn} aria-label="Exit prototype" title="Exit (Esc)" onClick={onClose}>
            <XIcon size="rail" />
          </IconButton>
        )}
      </div>
      {notice && (
        <div className="absolute bottom-5 left-1/2 z-10 -translate-x-1/2 rounded-pill bg-black/70 px-3 py-1.5 text-body text-code-ink">
          {notice}
        </div>
      )}
    </div>
  )
}

const playerBtn = 'text-code-ink/80 hover:bg-white/10 hover:text-code-ink'

function readState(): Record<string, unknown> {
  const state: unknown = history.state
  return state && typeof state === 'object' ? (state as Record<string, unknown>) : {}
}
const KEY_REPLY_MS = 400
let keyRequests = 0

/** Offer a key to the screen's own key interactions; true when one took it. */
function askKey(win: Window, key: string): Promise<boolean> {
  const reqId = `proto-key-${++keyRequests}`
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => done(false), KEY_REPLY_MS)
    function onMsg(ev: MessageEvent) {
      const data = ev.data as { type?: string; reqId?: string; handled?: boolean } | null
      if (ev.source === win && data?.type === 'doop:proto-key-result' && data.reqId === reqId) done(!!data.handled)
    }
    function done(handled: boolean) {
      window.clearTimeout(timer)
      window.removeEventListener('message', onMsg)
      resolve(handled)
    }
    window.addEventListener('message', onMsg)
    win.postMessage({ type: 'doop:proto-key', key, reqId }, '*')
  })
}

/** One frame's document inside the player: boots the runtime, renders the
 *  frame's live HTML, then switches its prototype triggers on. */
function ProtoScreen({
  entry,
  frame,
  scale,
  interactive,
  register,
  onReady,
  onMessage,
}: {
  entry: Entry
  frame: Frame | undefined
  scale: number
  interactive: boolean
  register: (key: number, win: Window | null) => void
  onReady: (key: number) => void
  onMessage: (data: { type?: string; interaction?: unknown; press?: boolean }) => void
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [booted, setBooted] = useState(false)
  const [shown, setShown] = useState(false)
  const latest = useRef({ onReady, onMessage, register })
  useLayoutEffect(() => {
    latest.current = { onReady, onMessage, register }
  })

  useEffect(() => {
    const key = entry.key
    let first = true
    function onMsg(ev: MessageEvent) {
      const win = iframeRef.current?.contentWindow
      if (!win || ev.source !== win) return
      const data = ev.data as { type?: string } | null
      if (!data?.type) return
      if (data.type === 'doop:frame-ready') {
        latest.current.register(key, win)
        setBooted(true)
      } else if (data.type === 'doop:html-result') {
        if (!first) return
        first = false
        setShown(true)
        latest.current.onReady(key)
      } else latest.current.onMessage(data)
    }
    window.addEventListener('message', onMsg)
    return () => {
      window.removeEventListener('message', onMsg)
      latest.current.register(key, null)
    }
  }, [entry.key])

  const html = frame?.html ?? ''
  useEffect(() => {
    if (booted) iframeRef.current?.contentWindow?.postMessage({ type: 'doop:html', html, reqId: 'proto' }, '*')
  }, [booted, html])

  useEffect(() => {
    if (shown) iframeRef.current?.contentWindow?.postMessage({ type: 'doop:proto', on: interactive }, '*')
  }, [shown, interactive])

  if (!frame) return <div className="text-body text-code-ink/70">This screen was deleted from the canvas.</div>

  const box: CSSProperties = { width: Math.round(frame.width * scale), height: Math.round(frame.height * scale) }
  return (
    <div className="relative overflow-hidden bg-white" style={box}>
      <iframe
        ref={iframeRef}
        className="block border-none bg-white"
        title={frame.name}
        data-doop-proto-frame={frame.id}
        sandbox="allow-scripts"
        srcDoc={FRAME_BOOTSTRAP}
        style={{ width: frame.width, height: frame.height, transform: `scale(${scale})`, transformOrigin: '0 0' }}
      />
    </div>
  )
}
