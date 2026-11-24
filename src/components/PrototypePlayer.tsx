import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useComposedFrame } from '../lib/frameCompose'
import type { Frame } from '../../shared/types'
import type { Interaction, ProtoTransition } from '../../shared/prototype'
import { canCommentOpenCanvas, useStore } from '../lib/store'
import { frameHtmlReady } from '../lib/pages'
import { showFrames } from '../lib/ws'
import { posthog } from '../lib/posthog'
import { FRAME_BOOTSTRAP } from '../lib/frameRuntime'
import {
  fitScale,
  historyStep,
  isProtoScaling,
  jumpTargets,
  pagerPlace,
  protoHistoryState,
  readProtoHistory,
  readProtoScaling,
  sanitizeInteraction,
  saveProtoScaling,
  screenLayout,
  transitionFrames,
  type PagerPlace,
  type ProtoScaling,
  type ScreenLayout,
} from '../lib/prototypePlayer'
import { prototypePath } from '../lib/prototype'
import { IconButton } from './ui/icon-button'
import { cn } from '@/lib/utils'
import { Pressable } from './ui/pressable'
import { PrototypeComments } from './PrototypeComments'
import { CommentThreadLayer } from './FrameLabelLayer'
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CommentIcon,
  ExportIcon,
  HistoryIcon,
  HotspotIcon,
  ScalingIcon,
  XIcon,
} from './ui/icons'
import {
  DropdownMenu,
  DropdownMenuCaption,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { t as translate, useT } from '@/lib/i18n'

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
  const t = useT()

  /* one play of the prototype: Present on the canvas, or its own page */
  useEffect(() => {
    posthog.capture('prototype_played', { via: syncUrl ? 'prototype_page' : 'present' })
  }, [syncUrl])

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
  /* closing an overlay that holds the focus drops it on the page: the
     screen it uncovers takes it back (see ProtoScreen) */
  const focusHandoff = useRef(false)
  const setOverlays = (next: Entry[]) => {
    if (next.length < overlaysRef.current.length && screenHasFocus()) focusHandoff.current = true
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

  /* the screens' box, not the window: the desktop shell's tab strip (and the
     impersonation banner) take the top of the window, and the player's bar
     sits above the screens. Null until measured: no screen is laid out on a
     guess (the layout effect measures before the first paint) */
  const stageRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState<{ w: number; h: number } | null>(null)
  useLayoutEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const measure = () => setViewport({ w: stage.clientWidth, h: stage.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [])

  /* comment mode (C, or the toolbar's bubble): clicks on the screen pin
     comments instead of playing the prototype */
  const canComment = useStore(canCommentOpenCanvas)
  const [commenting, setCommentingState] = useState(false)
  const commentingRef = useRef(false)
  const setCommenting = (next: boolean) => {
    commentingRef.current = next
    setCommentingState(next)
  }
  /* a viewer who loses comment access mid-way leaves comment mode with it */
  const commentsOn = commenting && canComment
  const [threadLayer, setThreadLayer] = useState<HTMLDivElement | null>(null)
  /* a click on the player around the screens hides its bar and pager, as
     Figma's does, and the next one brings them back; they keep their room,
     so the screens neither move nor rescale */
  const [chromeHidden, setChromeHidden] = useState(false)

  const [scaling, setScalingState] = useState(readProtoScaling)
  const setScaling = (next: ProtoScaling) => {
    saveProtoScaling(next)
    setScalingState(next)
  }

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
    if (!frameById(frameId)) return flash(translate('panels.protoScreenGone'))
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
    if (!frameById(frameId)) return flash(translate('panels.protoScreenGone'))
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
    if (!frameById(prev.frameId)) return flash(translate('panels.protoScreenGone'))
    const to = { ...prev, key: nextKey() }
    setOverlays([])
    setStack([...current.slice(0, -2), to])
    setMove({ from, to, transition: from.transition, duration: from.duration, back: true, ready: false })
  }

  function openOverlay(frameId: string, transition: ProtoTransition, duration: number) {
    if (!frameById(frameId)) return flash(translate('panels.protoOverlayGone'))
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
     interaction; then, over the editor, the player itself. Comment mode
     goes before all of them: Esc leaves it as it does on the canvas */
  function escape() {
    if (commentingRef.current && canComment) return setCommenting(false)
    if (overlaysRef.current.length) return closeOverlay()
    const win = topWindow()
    if (!win) return onClose?.()
    askKey(win, 'Escape')
      .then((handled) => !handled && onClose?.())
      .catch(console.error)
  }

  /* the one screen that takes input: the top overlay, else the screen shown */
  function topEntry(): Entry | undefined {
    return overlaysRef.current.at(-1) ?? moveRef.current?.to ?? stackRef.current.at(-1)
  }

  function topWindow(): Window | undefined {
    const top = topEntry()
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
  const handlers = useRef({ escape, back, jumpTo, release, topWindow, commentKey })
  useLayoutEffect(() => {
    handlers.current = { escape, back, jumpTo, release, topWindow, commentKey }
  })

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      /* the scaling menu and its button take their own keys (arrows, Enter,
         Escape in the menu) and stop them short of the editor themselves;
         Escape on the button still leaves the player */
      const target = e.target instanceof Element ? e.target : null
      if (target?.closest('[data-proto-menu]')) return
      /* a comment being written or answered types into its own field */
      if (target?.closest('[data-proto-comment]')) return
      if (target?.closest('[data-proto-menu-trigger]') && e.key !== 'Escape') return
      /* capture phase, and modal: no key reaches the editor underneath (an
         arrow would nudge the selected frame, Delete would remove it) */
      e.stopPropagation()
      if (e.key === 'Escape') return handlers.current.escape()
      if (e.repeat || e.metaKey || e.ctrlKey) return
      const win = handlers.current.topWindow()
      if (e.key.toLowerCase() === 'c' && !e.altKey && !e.shiftKey && handlers.current.commentKey(win)) return
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

  /** Switch comment mode; false when this viewer may not comment. */
  function toggleComments(): boolean {
    if (!canComment) return false
    setCommenting(!commentingRef.current)
    return true
  }

  /** C: the screen's own key:c interaction goes first, as Escape's does;
   *  only a C nothing on the screen takes switches comment mode. */
  function commentKey(win: Window | undefined): boolean {
    if (!canComment) return false
    if (!win) return toggleComments()
    askKey(win, 'c')
      .then((handled) => !handled && toggleComments())
      .catch(console.error)
    return true
  }

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
  const stage = viewport ?? { w: 0, h: 0 }
  const baseScale = baseFrame ? screenLayout(baseFrame, stage, scaling).scale : 1
  /* a screen larger than the player scrolls from its top-left corner, except
     under Fill, which crops it around its centre (clipped, so nothing
     can scroll it, not even focus) */
  const screenPlacement =
    scaling === 'fill' || scaling === 'fit'
      ? 'place-content-center overflow-clip'
      : 'place-items-center-safe overflow-auto'

  const screenProps = (entry: Entry) => ({
    entry,
    frame: frameById(entry.frameId),
    takeFocus: () => {
      const handoff = focusHandoff.current
      focusHandoff.current = false
      return handoff
    },
    register: (key: number, win: Window | null) => {
      if (win) windows.current.set(key, win)
      else windows.current.delete(key)
    },
    onMessage: (data: { type?: string; interaction?: unknown; press?: boolean }) => {
      /* a covered screen is switched off, but an action it sent before the
         switch reached it must not act over the screen on top */
      if (data.type === 'doop:proto-action') {
        if (topEntry()?.key === entry.key) run(data.interaction, !!data.press)
      } else if (data.type === 'doop:proto-release') release()
      /* Escape with the focus in a screen: the same overlay-first path as a
         key pressed on the player itself */
      else if (data.type === 'doop:esc') escape()
    },
  })

  return (
    <div
      /* below the shell's tab strip, by the --app-inset contract (App.tsx) */
      className="fixed inset-x-0 bottom-0 top-[var(--app-inset,0px)] z-[80] flex flex-col overflow-hidden bg-code"
      role="dialog"
      aria-label={t('panels.protoAria', { name: shownFrame?.name ?? t('panels.protoMissingLower') })}
      /* hidden, the bar and the pager keep their room, and a click there
         (where they were) brings them back: under Fill, or on a screen larger
         than the stage, there is no empty space around the screens to click */
      onClick={(e) => {
        if (chromeHidden && e.target === e.currentTarget) setChromeHidden(false)
      }}
      data-prototype-player=""
    >
      <CommentThreadLayer.Provider value={threadLayer}>
        <div
          className={cn(
            'relative z-10 flex h-10 shrink-0 items-center justify-between gap-2 border-b border-white/10 px-2 text-code-ink',
            chromeHidden && chromeOff,
          )}
          data-proto-bar=""
        >
          <div className="flex min-w-0 items-center gap-1">
            <FrameMenu
              currentId={shownFrame?.id}
              label={shownFrame?.name ?? t('panels.protoMissing')}
              /* the screen already shown: picking it again only closes an overlay over it */
              onPick={(id) => {
                if (id !== current.frameId) navigate(id, 'instant', 0)
                else if (overlays.length) setOverlays([])
              }}
            />
            <IconButton
              size="sm"
              className={playerBtn}
              aria-label={t('common.back')}
              disabled={stack.length < 2 && !overlays.length}
              onClick={() => back()}
            >
              <ArrowLeftIcon size="rail" />
            </IconButton>
            <IconButton size="sm" className={playerBtn} aria-label={t('panels.protoRestart')} onClick={restart}>
              <HistoryIcon size="rail" />
            </IconButton>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <IconButton size="sm" className={playerBtn} aria-label={t('panels.protoHotspots')} onClick={flashHotspots}>
              <HotspotIcon size="rail" />
            </IconButton>
            {canComment && (
              <IconButton
                size="sm"
                className={cn(playerBtn, commentsOn && 'bg-white/15 text-code-ink')}
                aria-label={t('panels.protoComments')}
                aria-pressed={commentsOn}
                title={t('panels.protoCommentsTitle')}
                data-proto-comments=""
                onClick={() => toggleComments()}
              >
                <CommentIcon size="rail" />
              </IconButton>
            )}
            <ScalingMenu scaling={scaling} onChange={setScaling} />
            {onClose && canvasId && (
              <IconButton
                size="sm"
                className={playerBtn}
                aria-label={t('panels.protoNewTab')}
                onClick={() => window.open(prototypePath(canvasId, current.frameId), '_blank', 'noopener')}
              >
                <ExportIcon size="rail" />
              </IconButton>
            )}
            {onClose && (
              <IconButton
                size="sm"
                className={playerBtn}
                aria-label={t('panels.protoExit')}
                title={t('panels.protoExitTitle')}
                onClick={onClose}
              >
                <XIcon size="rail" />
              </IconButton>
            )}
          </div>
        </div>
        {/* the screens: everything between the bar and the pager, which never cover them */}
        <div
          ref={stageRef}
          className="relative min-h-0 flex-1 overflow-hidden"
          data-proto-stage=""
          onClick={(e) => {
            /* only the empty space around the screens: a click in a screen
               stays in its iframe, and comment threads sit in their own layer */
            const target = e.target as HTMLElement
            if (target !== e.currentTarget && !target.hasAttribute('data-proto-screen')) return
            /* a scrollable screen's wrapper: its scrollbars are not empty space */
            const { offsetX, offsetY } = e.nativeEvent
            if (offsetX >= target.clientWidth || offsetY >= target.clientHeight) return
            setChromeHidden((h) => !h)
          }}
        >
          {(viewport ? base : []).map(({ entry, role }) => {
            const frame = frameById(entry.frameId)
            return (
              <div
                key={entry.key}
                ref={(el) => {
                  if (el) wrappers.current.set(entry.key, el)
                  else wrappers.current.delete(entry.key)
                }}
                className={`absolute inset-0 grid ${screenPlacement}`}
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
                  layout={frame ? screenLayout(frame, stage, scaling) : undefined}
                  interactive={role !== 'from' && !overlays.length}
                  commenting={commentsOn && role === 'still' && !overlays.length}
                  onReady={onScreenReady}
                />
              </div>
            )
          })}

          {(viewport ? overlays : []).map((entry, index) => {
            const frame = frameById(entry.frameId)
            const scale = frame
              ? Math.min(baseScale, fitScale(frame, { w: stage.w * OVERLAY_FIT, h: stage.h * OVERLAY_FIT }))
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
                  <ProtoScreen
                    {...screenProps(entry)}
                    layout={frame ? { width: frame.width, height: frame.height, scale } : undefined}
                    interactive={index === overlays.length - 1}
                    commenting={commentsOn && index === overlays.length - 1}
                    onReady={() => onOverlayReady(entry)}
                  />
                </div>
              </div>
            )
          })}

          {/* the composer and open threads: above the screens, unclipped by them */}
          <div
            ref={setThreadLayer}
            className="pointer-events-none absolute inset-0 z-[20]"
            data-proto-comment=""
            onKeyDown={(e) => e.stopPropagation()}
          />
          {notice && (
            <div className="absolute bottom-5 left-1/2 z-10 -translate-x-1/2 rounded-pill bg-black/70 px-3 py-1.5 text-body text-code-ink">
              {notice}
            </div>
          )}
        </div>
        <Pager
          frameId={(move?.to ?? current).frameId}
          hidden={chromeHidden}
          onStep={(id) => {
            /* the screen stepped to takes the keys, as one picked from the menu
               does: Enter or Space for the design never press the pager again */
            focusHandoff.current = true
            navigate(id, 'instant', 0)
          }}
        />
      </CommentThreadLayer.Provider>
    </div>
  )
}

/** Figma's ‹ n / N › under the screens: steps through the frames of the
 *  shown screen's page in reading order, as a navigation with no transition,
 *  so Back returns from a step. Not shown when there is nowhere to step. */
function Pager({ frameId, hidden, onStep }: { frameId: string; hidden: boolean; onStep: (frameId: string) => void }) {
  /* the canvas's own fields, not the canvas: presence, cursors and agent
     status change it all the time under a playing prototype */
  const id = useStore((s) => s.canvas?.id)
  const pages = useStore((s) => s.canvas?.pages)
  const frames = useStore((s) => s.canvas?.frames)
  const place = useMemo(
    () => (id && frames ? pagerPlace({ id, pages, frames }, frameId) : null),
    [id, pages, frames, frameId],
  )
  /* the strip is there whether or not there is anywhere to step, so going to
     a page of one frame, or a frame added to this one, never moves the screens */
  return (
    <div className={cn('flex h-14 shrink-0 items-center justify-center', hidden && chromeOff)} data-proto-pager="">
      {place && <PagerControls place={place} onStep={onStep} />}
    </div>
  )
}

function PagerControls({ place, onStep }: { place: PagerPlace; onStep: (frameId: string) => void }) {
  const t = useT()
  const { prev, next } = place
  return (
    <div className="flex h-10 items-center rounded-panel bg-white/10 px-1 text-code-ink">
      <IconButton
        size="md"
        className={playerBtn}
        aria-label={t('panels.protoPrevFrame')}
        disabled={!prev}
        onClick={() => prev && onStep(prev)}
      >
        <ChevronLeftIcon />
      </IconButton>
      <span className="h-5 w-px bg-white/15" />
      <span className="min-w-16 px-3 text-center text-body tabular-nums" data-proto-count="">
        {t('panels.protoCount', { index: place.index, total: place.total })}
      </span>
      <span className="h-5 w-px bg-white/15" />
      <IconButton
        size="md"
        className={playerBtn}
        aria-label={t('panels.protoNextFrame')}
        disabled={!next}
        onClick={() => next && onStep(next)}
      >
        <ChevronRightIcon />
      </IconButton>
    </div>
  )
}

const playerBtn = 'text-code-ink/80 hover:bg-white/10 hover:text-code-ink'
/* hidden UI keeps its room, so the screens stay put at the same scale */
const chromeOff = 'invisible'

/** The current screen's name, and a menu of every frame to jump to: a jump
 *  is a navigation with no transition, so Back returns from it. */
function FrameMenu({
  currentId,
  label,
  onPick,
}: {
  currentId: string | undefined
  label: string
  onPick: (frameId: string) => void
}) {
  const t = useT()
  const canvas = useStore((s) => s.canvas)
  /* worked out only while the menu shows: the canvas changes under a
     playing prototype all the time (streams, peers' edits) */
  const [open, setOpen] = useState(false)
  const groups = open && canvas ? jumpTargets(canvas) : []
  const titled = groups.length > 1
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild data-proto-menu-trigger="" onKeyDown={(e) => e.stopPropagation()}>
        <Pressable
          className="flex max-w-[220px] min-w-0 items-center gap-1 rounded-pill px-2 py-1 text-caption text-code-ink/80 hover:bg-white/10 hover:text-code-ink"
          aria-label={t('panels.protoJumpTo')}
          data-proto-frame-menu=""
        >
          <span className="truncate" data-proto-current="">
            {label}
          </span>
          <ChevronDownIcon size={12} className="shrink-0" />
        </Pressable>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        width="lg"
        align="start"
        className="z-[90] max-h-[min(70vh,480px)] overflow-y-auto"
        data-proto-menu=""
        onKeyDown={(e) => e.stopPropagation()}
        onCloseAutoFocus={(e) => {
          const screen = interactiveScreen()
          if (!screen) return
          e.preventDefault()
          screen.focus()
        }}
      >
        <DropdownMenuRadioGroup value={currentId ?? ''}>
          {groups.map(({ page, frames }, index) => (
            <Fragment key={page.id}>
              {index > 0 && <DropdownMenuSeparator />}
              {titled && <DropdownMenuCaption>{page.name}</DropdownMenuCaption>}
              {frames.map((frame) => (
                <DropdownMenuRadioItem
                  key={frame.id}
                  value={frame.id}
                  data-proto-jump={frame.id}
                  onSelect={() => onPick(frame.id)}
                >
                  <span className="truncate">{frame.name}</span>
                </DropdownMenuRadioItem>
              ))}
            </Fragment>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** How the player scales its screens: the two recommended choices, then
 *  the scaled ones. */
function ScalingMenu({ scaling, onChange }: { scaling: ProtoScaling; onChange: (next: ProtoScaling) => void }) {
  const t = useT()
  const pick = (value: string) => isProtoScaling(value) && onChange(value)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild data-proto-menu-trigger="" onKeyDown={(e) => e.stopPropagation()}>
        <IconButton size="sm" className={playerBtn} aria-label={t('panels.protoScaling')}>
          <ScalingIcon size="rail" />
        </IconButton>
      </DropdownMenuTrigger>
      {/* above the player, which sits over every other layer of the editor */}
      <DropdownMenuContent
        width="md"
        className="z-[90]"
        data-proto-menu=""
        onKeyDown={(e) => e.stopPropagation()}
        /* a closed menu hands the keys back to the prototype: the screen that
           takes them gets the focus; with none up, the button keeps it */
        onCloseAutoFocus={(e) => {
          const screen = interactiveScreen()
          if (!screen) return
          e.preventDefault()
          screen.focus()
        }}
      >
        <DropdownMenuRadioGroup value={scaling} onValueChange={pick}>
          <DropdownMenuCaption>{t('panels.protoScalingRecommended')}</DropdownMenuCaption>
          <DropdownMenuRadioItem value="actual">{t('panels.protoScaleActual')}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="responsive">{t('panels.protoScaleResponsive')}</DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          <DropdownMenuCaption>{t('panels.protoScalingOther')}</DropdownMenuCaption>
          <DropdownMenuRadioItem value="fit-width">{t('panels.protoScaleFitWidth')}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="fit">{t('panels.protoScaleFit')}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="fill">{t('panels.protoScaleFill')}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function readState(): Record<string, unknown> {
  const state: unknown = history.state
  return state && typeof state === 'object' ? (state as Record<string, unknown>) : {}
}
/** The screen whose turn it is to take the keys: the topmost overlay, else
 *  the base screen that is not on its way out. */
function interactiveScreen(): HTMLIFrameElement | null {
  const overlays = document.querySelectorAll<HTMLIFrameElement>('[data-prototype-player] [data-proto-overlay] iframe')
  return (
    overlays[overlays.length - 1] ??
    document.querySelector<HTMLIFrameElement>(
      '[data-prototype-player] [data-proto-screen]:not([data-proto-role="from"]) iframe',
    )
  )
}

/** Whether one of the player's screens holds the keyboard focus. */
function screenHasFocus(): boolean {
  const focused = document.activeElement
  return focused instanceof HTMLIFrameElement && !!focused.closest('[data-prototype-player]')
}

const KEY_REPLY_MS = 400
let keyRequests = 0

/** Offer a key to the screen's own key interactions; true when one took it. */
let switchRequests = 0

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
  layout,
  interactive,
  takeFocus,
  register,
  onReady,
  onMessage,
  commenting,
}: {
  entry: Entry
  frame: Frame | undefined
  /** the document's size and draw scale; undefined while the frame is gone */
  layout: ScreenLayout | undefined
  interactive: boolean
  /** true once when the overlay closed over this screen held the focus */
  takeFocus: () => boolean
  register: (key: number, win: Window | null) => void
  onReady: (key: number) => void
  onMessage: (data: { type?: string; interaction?: unknown; press?: boolean }) => void
  /** the top screen while the viewer comments: clicks pin comments */
  commenting: boolean
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [booted, setBooted] = useState(false)
  /* each document the runtime has shown: comment pins are located again */
  const [rendered, setRendered] = useState(0)
  const [shown, setShown] = useState(false)
  const latest = useRef({ onReady, onMessage, register, takeFocus })
  const t = useT()
  useLayoutEffect(() => {
    latest.current = { onReady, onMessage, register, takeFocus }
  })

  /* the `doop:proto` switch this screen is waiting on, when its reply is
     also the moment the screen should take the focus */
  const focusOnSwitch = useRef<string | null>(null)
  useEffect(() => {
    const key = entry.key
    let first = true
    function onMsg(ev: MessageEvent) {
      const win = iframeRef.current?.contentWindow
      if (!win || ev.source !== win) return
      const data = ev.data as { type?: string; reqId?: string } | null
      if (!data?.type) return
      if (data.type === 'doop:frame-ready') {
        latest.current.register(key, win)
        setBooted(true)
      } else if (data.type === 'doop:html-result') {
        setRendered((n) => n + 1)
        if (!first) return
        first = false
        setShown(true)
        latest.current.onReady(key)
      } else if (data.type === 'doop:proto-result') {
        if (data.reqId === focusOnSwitch.current) {
          focusOnSwitch.current = null
          iframeRef.current?.focus()
        }
      } else latest.current.onMessage(data)
    }
    window.addEventListener('message', onMsg)
    return () => {
      window.removeEventListener('message', onMsg)
      latest.current.register(key, null)
    }
  }, [entry.key])

  /* a screen on a page this browser has not read waits for that page, so it
     never shows a blank or old copy of the frame; the page is kept here and in
     the room's memory for as long as the screen is up */
  const frameId = frame?.id
  const ready = useStore((s) => !frameId || frameHtmlReady(s, frameId))
  useEffect(() => (frameId ? showFrames([frameId]) : undefined), [frameId])
  /* the store holds the frame's source: the canvas's styles are composed in here */
  const { html } = useComposedFrame(frame?.html ?? '')
  useEffect(() => {
    if (booted && ready) iframeRef.current?.contentWindow?.postMessage({ type: 'doop:html', html, reqId: 'proto' }, '*')
  }, [booted, ready, html])

  useEffect(() => {
    const iframe = iframeRef.current
    if (!shown || !iframe) return
    const reqId = `proto-switch-${++switchRequests}`
    /* keys go to the focused document: take the focus over from the screen
       this one now covers, or back from the overlay that closed over it, so
       its key interactions and controls answer instead of that screen's.
       The focus moves on the runtime's reply, not now: the switch travels
       as a message, and a key pressed into a focused screen whose runtime
       had not yet heard it was dropped. */
    const focused = document.activeElement
    const takesFocus = interactive && ((screenHasFocus() && focused !== iframe) || latest.current.takeFocus())
    focusOnSwitch.current = takesFocus ? reqId : null
    iframe.contentWindow?.postMessage({ type: 'doop:proto', on: interactive, reqId }, '*')
  }, [shown, interactive])

  if (!frame || !layout) return <div className="text-body text-code-ink/70">{t('panels.protoDeleted')}</div>

  const { width, height, scale } = layout
  const box: CSSProperties = { width: Math.round(width * scale), height: Math.round(height * scale) }
  return (
    <div className="relative overflow-hidden bg-white" style={box}>
      <iframe
        ref={iframeRef}
        className="block border-none bg-white"
        title={frame.name}
        data-doop-proto-frame={frame.id}
        sandbox="allow-scripts"
        srcDoc={FRAME_BOOTSTRAP}
        style={{ width, height, transform: `scale(${scale})`, transformOrigin: '0 0' }}
      />
      <PrototypeComments
        frame={frame}
        iframeRef={iframeRef}
        scale={scale}
        width={width}
        height={height}
        rendered={rendered}
        commenting={commenting}
      />
    </div>
  )
}
