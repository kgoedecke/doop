import { memo, useEffect, useRef, useState } from 'react'
import type { ElementComment, Frame } from '../../shared/types'
import { colorFor } from '../../shared/types'
import { useStore } from '../lib/store'
import { api } from '../lib/api'
import { sendWs } from '../lib/ws'
import { throttle } from '../lib/throttle'
import { getIdentity } from '../lib/identity'
import { FRAME_BOOTSTRAP } from '../lib/frameRuntime'
import { recordCreate, recordUpdate } from '../lib/history'
import { snapFrame } from '../lib/snap'
import { FrameContextMenu } from './FrameContextMenu'
import { ContextMenu, ContextMenuTrigger } from './ui/context-menu'
import { AGENT_ROLES, DEFAULT_ROLE_ID, mentionedRole, roleName } from '../../shared/agents'
import { posthog } from '../lib/posthog'
import { isResidentLimit } from './TeamAllowance'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'
import { Tooltip } from './ui/tooltip'
import { GithubIcon, SyncIcon } from './ui/icons'
import { isSyncedFrame } from '../lib/sync'
import { isGithubFrame, isGithubPlaceholder } from '../lib/github'

/* Counter-scale contract: chrome that keeps constant on-screen size divides
   by the `--zoom` variable the Stage publishes (capped at 2.4× when zoomed
   far out). Preserve these expressions exactly. */
const COUNTER_SCALE = '[transform:scale(min(calc(1/var(--zoom,1)),2.4))]'
const EDITOR_CHIP =
  'inline-flex items-center gap-1 rounded-full px-[7px] py-0.5 text-[10px] font-bold text-white animate-[chip-in_0.25s_ease]'
/* the element toolbar's buttons sit on ink and stay compact */
const EL_TOOLBAR_BTN = 'rounded-[7px] px-2 py-1 text-xs'

/* Figma-style ⌥⇧-drag duplicate cursor: a doubled pointer, hotspot on the
   front arrow's tip. `copy` is the fallback where custom cursors fail. */
const DUP_CURSOR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M9 8v12.6l3.4-2.9 2 4.6 2.3-1-2-4.5 4.5-.4z" fill="#000" stroke="#fff" stroke-width="1.2"/><path d="M4 3v12.6l3.4-2.9 2 4.6 2.3-1-2-4.5 4.5-.4z" fill="#000" stroke="#fff" stroke-width="1.2"/></svg>`
const DUP_CURSOR = `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(DUP_CURSOR_SVG)}") 4 3, copy`

/** True while ⌥⇧ is held. The duplicate cursor must be showing BEFORE the
 *  drag starts: Chromium freezes the effective cursor for the duration of a
 *  pointer drag, so a swap at drag-start never paints. */
function useDupModifier(): boolean {
  const [held, setHeld] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => setHeld(e.altKey && e.shiftKey)
    const reset = () => setHeld(false)
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
      window.removeEventListener('blur', reset)
    }
  }, [])
  return held
}

/** Re-render the iframe at most every `ms` — keeps streaming chunk updates smooth. */
function useThrottledValue<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  const last = useRef(0)
  useEffect(() => {
    const wait = Math.max(0, last.current + ms - Date.now())
    const t = window.setTimeout(() => {
      last.current = Date.now()
      setV(value)
    }, wait)
    return () => window.clearTimeout(t)
  }, [value, ms])
  return v
}

interface ProbeHit {
  selector: string
  tag: string
  text: string
  snippet: string
  rect: { x: number; y: number; width: number; height: number }
}

interface HoverHit {
  tag: string
  rect: { x: number; y: number; width: number; height: number }
}

/* Counter-scaled overlays (labels, pins, popovers) get their scale from the
   `--zoom` CSS variable the Stage sets, so a viewport change never re-renders
   this component — memo holds as long as the frame and raster are unchanged. */
export const FrameView = memo(function FrameView({ frame, raster }: { frame: Frame; raster: number }) {
  const selected = useStore((s) => s.selectedId === frame.id)
  const select = useStore((s) => s.select)
  const flash = useStore((s) => s.flashes[frame.id])
  const stream = useStore((s) => s.streams[frame.id])
  /* select the stable presences map, derive in render — a selector that
     builds a fresh array re-renders every frame on EVERY store update
     (zustand compares by identity), which defeats the memo above */
  const presences = useStore((s) => s.presences)
  const me = getIdentity().clientId
  const editors = Object.values(presences).filter((p) => p.activeFrameId === frame.id && p.clientId !== me)
  const [dragging, setDragging] = useState(false)
  /* ⌥⇧-drag (Figma-style duplicate): the original stays behind, the copy
     rides the cursor — the doubled cursor shows from the moment ⌥⇧ is held */
  const [duping, setDuping] = useState(false)
  const dupKeyHeld = useDupModifier()
  const [editing, setEditing] = useState(false)
  /* after exiting edit mode, hold renders until the final serialized HTML
     lands in the store — otherwise a stale post would morph the edit away */
  const [suspendPost, setSuspendPost] = useState(false)

  const sendDrag = useRef(
    throttle((f: { id: string; x: number; y: number; width: number; height: number }) => {
      sendWs({ type: 'frame:drag', frameId: f.id, x: f.x, y: f.y, width: f.width, height: f.height })
    }, 50),
  ).current

  function startDrag(e: React.PointerEvent, mode: 'move' | 'resize', probeOnClick = false, panelOnClick = false) {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    select(frame.id)
    setDragging(true)
    clearHover()
    const start = { x: e.clientX, y: e.clientY }
    const off = { x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY }
    const orig = { x: frame.x, y: frame.y, width: frame.width, height: frame.height }
    let moved = false
    /* ⌥⇧-drag duplicates: the moment the drag is real, leave a copy of the
       frame at its origin and keep dragging this one — same net effect as
       Figma's "drag off a duplicate", without retargeting the drag */
    const duplicating = mode === 'move' && e.altKey && e.shiftKey
    let dupDropped = false
    if (duplicating) setDuping(true)

    function onMove(ev: PointerEvent) {
      if (Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) > 4) moved = true
      if (duplicating && moved && !dupDropped) {
        dupDropped = true
        api
          .createFrame(frame.canvasId, { name: frame.name, html: frame.html, ...orig })
          .then((f) => {
            posthog.capture('frame_duplicated', { via: 'drag' })
            recordCreate(f)
          })
          .catch(console.error)
      }
      const zoom = useStore.getState().viewport.zoom
      const dx = (ev.clientX - start.x) / zoom
      const dy = (ev.clientY - start.y) / zoom
      const raw =
        mode === 'move'
          ? { ...orig, x: Math.round(orig.x + dx), y: Math.round(orig.y + dy) }
          : {
              ...orig,
              width: Math.max(120, Math.round(orig.width + dx)),
              height: Math.max(80, Math.round(orig.height + dy)),
            }
      /* edges pull onto neighbouring frames' edges/centers; ⌥ drags free */
      const others = useStore.getState().canvas?.frames.filter((f) => f.id !== frame.id) ?? []
      const snapped = ev.altKey ? { ...raw, guides: [] } : snapFrame(mode, raw, others, zoom)
      useStore.getState().setSnapGuides(snapped.guides)
      const patch = mode === 'move' ? { x: snapped.x, y: snapped.y } : { width: snapped.width, height: snapped.height }
      useStore.getState().patchFrameLocal(frame.id, patch)
      const f = useStore.getState().canvas?.frames.find((x) => x.id === frame.id)
      if (f) sendDrag({ id: f.id, x: f.x, y: f.y, width: f.width, height: f.height })
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setDragging(false)
      if (duplicating) setDuping(false)
      useStore.getState().setSnapGuides([])
      const f = useStore.getState().canvas?.frames.find((x) => x.id === frame.id)
      if (f) {
        api.updateFrame(f.id, { x: f.x, y: f.y, width: f.width, height: f.height }).catch(console.error)
        recordUpdate(f.id, orig, { x: f.x, y: f.y, width: f.width, height: f.height })
      }
      /* a click (no drag) on the frame surface targets the element under
         the cursor: probe it and show the element toolbar */
      if (!moved && probeOnClick) probeAt(off.x, off.y)
      else if (moved) closePopovers()
      /* a click (no drag) on the frame name opens the details panel */
      if (!moved && panelOnClick) useStore.getState().setInspectorOpen(true)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const html = useThrottledValue(frame.html, 150)
  const remoteEditor = editors[0]

  /* The iframe loads a bootstrap once; HTML is posted in and DOM-morphed in
     place, so updates never white-flash the frame with a full reload. */
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  /* where the last right-click landed, in screen coordinates: Paste drops the
     frame there, and the menu's own box is not that point once Radix has
     flipped or shifted it away from a viewport edge */
  const menuAt = useRef({ x: 0, y: 0 })
  const [runtimeReady, setRuntimeReady] = useState(false)
  useEffect(() => {
    function onMsg(ev: MessageEvent) {
      if (ev.data?.type === 'doop:frame-ready' && ev.source === iframeRef.current?.contentWindow) {
        setRuntimeReady(true)
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])
  useEffect(() => {
    if (!runtimeReady || editing || suspendPost) return
    iframeRef.current?.contentWindow?.postMessage({ type: 'doop:html', html }, '*')
  }, [runtimeReady, html, editing, suspendPost])

  /* ---- element comments ---- */
  const frameComments = useStore((s) => s.comments).filter((c) => c.frameId === frame.id)
  /* only thread roots get a pin; replies live inside the root's popover */
  const comments = frameComments.filter((c) => !c.parentId && !c.resolvedAt)
  const [probe, setProbe] = useState<ProbeHit | null>(null)
  /* element selected for text editing inside the iframe (edit mode only) */
  const [activeHit, setActiveHit] = useState<ProbeHit | null>(null)
  const [composing, setComposing] = useState(false)
  const [openThread, setOpenThread] = useState<string | null>(null)
  const [pinPos, setPinPos] = useState<Record<string, { x: number; y: number } | null>>({})
  const probeReq = useRef(0)
  const probeTimer = useRef<number | null>(null)
  const activeSelRef = useRef<string | null>(null)

  /* ---- hover inspection (paper.design-style element outlines) ---- */
  const [hover, setHover] = useState<HoverHit | null>(null)
  const hoverReq = useRef(0)
  const hoverKey = useRef<string | null>(null)

  const hoverLast = useRef(0)
  function sendHover(x: number, y: number) {
    /* pointermove fires every frame — one probe per ~40ms is plenty */
    const now = Date.now()
    if (now - hoverLast.current < 40) return
    hoverLast.current = now
    hoverReq.current += 1
    iframeRef.current?.contentWindow?.postMessage({ type: 'doop:hover', reqId: hoverReq.current, x, y }, '*')
  }

  function clearHover() {
    hoverReq.current += 1 // drop any in-flight result
    hoverKey.current = null
    setHover(null)
  }

  /* source view + composer prefill for the element toolbar */
  const [codeView, setCodeView] = useState<string | null>(null)
  const [composePrefill, setComposePrefill] = useState('')
  const codeReq = useRef(0)

  function requestCode(selector: string) {
    codeReq.current += 1
    iframeRef.current?.contentWindow?.postMessage({ type: 'doop:code', reqId: codeReq.current, selector }, '*')
  }

  function closePopovers() {
    if (probeTimer.current) {
      window.clearTimeout(probeTimer.current)
      probeTimer.current = null
    }
    setProbe(null)
    setComposing(false)
    setComposePrefill('')
    setCodeView(null)
    setOpenThread(null)
  }

  /* delayed slightly so the second click of a double-click (→ edit mode)
     cancels it instead of flashing the toolbar */
  function probeAt(x: number, y: number) {
    if (!frame.html || editing) return
    closePopovers()
    probeTimer.current = window.setTimeout(() => {
      probeTimer.current = null
      probeReq.current += 1
      iframeRef.current?.contentWindow?.postMessage({ type: 'doop:probe', reqId: probeReq.current, x, y }, '*')
    }, 250)
  }

  /* keep comment pins glued to their elements: re-locate whenever the frame's
     html or the comment set changes */
  const commentKey = comments.map((c) => c.id).join(',')
  useEffect(() => {
    if (!runtimeReady) return
    for (const c of comments) {
      iframeRef.current?.contentWindow?.postMessage({ type: 'doop:locate', reqId: c.id, selector: c.selector }, '*')
    }
  }, [runtimeReady, html, commentKey]) // eslint-disable-line react-hooks/exhaustive-deps

  /* the selection outline follows its element across html updates (streams,
     agent edits) the same way pins do */
  const probeSel = probe?.selector ?? null
  useEffect(() => {
    if (!runtimeReady || !probeSel) return
    iframeRef.current?.contentWindow?.postMessage({ type: 'doop:locate', reqId: '__probe__', selector: probeSel }, '*')
  }, [runtimeReady, html, probeSel])

  useEffect(() => {
    function onMsg(ev: MessageEvent) {
      if (ev.source !== iframeRef.current?.contentWindow) return
      if (ev.data?.type === 'doop:probe-result' && ev.data.reqId === probeReq.current) {
        setProbe(ev.data.hit ?? null)
      }
      if (ev.data?.type === 'doop:hover-result' && ev.data.reqId === hoverReq.current) {
        const hit = (ev.data.hit ?? null) as HoverHit | null
        /* only re-render when the outlined element actually changes */
        const key = hit ? hit.tag + JSON.stringify(hit.rect) : null
        if (key !== hoverKey.current) {
          hoverKey.current = key
          setHover(hit)
        }
      }
      if (ev.data?.type === 'doop:active') {
        const hit = (ev.data.hit ?? null) as ProbeHit | null
        /* rect refreshes for the same element keep the composer open;
           switching elements (or deselecting) closes it */
        if ((hit?.selector ?? null) !== activeSelRef.current) setComposing(false)
        activeSelRef.current = hit?.selector ?? null
        setActiveHit(hit)
      }
      if (ev.data?.type === 'doop:code-result' && ev.data.reqId === codeReq.current) {
        setCodeView(typeof ev.data.html === 'string' ? ev.data.html : null)
      }
      if (ev.data?.type === 'doop:located' && typeof ev.data.reqId === 'string') {
        if (ev.data.reqId === '__probe__') {
          /* re-glue the selected element's outline after the html changed */
          const rect = ev.data.rect as ProbeHit['rect'] | null
          setProbe((p) => (p && rect ? { ...p, rect } : rect ? p : null))
          return
        }
        const rect = ev.data.rect as { x: number; y: number; width: number } | null
        setPinPos((m) => ({ ...m, [ev.data.reqId]: rect ? { x: rect.x + rect.width, y: rect.y } : null }))
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  /* Esc dismisses popovers (edit mode has its own Esc path inside the iframe) */
  useEffect(() => {
    if (!probe && !openThread) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') closePopovers()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [probe, openThread])

  useEffect(() => {
    if (!selected) {
      closePopovers()
      const s = useStore.getState()
      if (s.ctxMenu?.frameId === frame.id) s.closeCtxMenu()
    }
  }, [selected]) // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- inline text editing ---- */
  const canEdit = !!frame.html && !stream && !/<script/i.test(frame.html)

  function enterEdit() {
    select(frame.id)
    closePopovers()
    clearHover()
    setEditing(true)
    iframeRef.current?.contentWindow?.postMessage({ type: 'doop:edit', on: true }, '*')
  }
  function exitEdit() {
    iframeRef.current?.contentWindow?.postMessage({ type: 'doop:edit', on: false }, '*')
    setEditing(false)
    setActiveHit(null)
    setComposing(false)
    activeSelRef.current = null
    setSuspendPost(true)
    window.setTimeout(() => setSuspendPost(false), 500)
  }

  /* serialized edits stream out of the iframe; save through the human path */
  useEffect(() => {
    function onMsg(ev: MessageEvent) {
      if (ev.source !== iframeRef.current?.contentWindow) return
      if (ev.data?.type === 'doop:edited' && typeof ev.data.html === 'string') {
        const before = useStore.getState().canvas?.frames.find((f) => f.id === frame.id)?.html
        useStore.getState().patchFrameLocal(frame.id, { html: ev.data.html })
        api.updateFrame(frame.id, { html: ev.data.html }).catch(console.error)
        if (before !== undefined) recordUpdate(frame.id, { html: before }, { html: ev.data.html })
      }
      if (ev.data?.type === 'doop:edit-esc') {
        setEditing(false)
        setSuspendPost(true)
        window.setTimeout(() => setSuspendPost(false), 500)
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [frame.id])

  /* deselecting the frame ends the edit session */
  useEffect(() => {
    if (!selected && editing) exitEdit()
  }, [selected]) // eslint-disable-line react-hooks/exhaustive-deps

  /* When zoomed past 100%, render the iframe k× larger and counter-scale it,
     with a matching CSS zoom inside — same layout, k× the raster density, so
     frames stay crisp instead of looking like scaled-up bitmaps. The factor
     is computed by the Stage from the settled (gesture-idle) zoom. */
  useEffect(() => {
    if (!runtimeReady) return
    iframeRef.current?.contentWindow?.postMessage({ type: 'doop:zoom', zoom: raster }, '*')
  }, [runtimeReady, raster])

  return (
    <ContextMenu
      onOpenChange={(open) => {
        const store = useStore.getState()
        if (!open) return store.closeCtxMenu()
        /* deferPanel: when this right-click is what selects the frame, the
           Inspector waits until the menu closes — it must not slide in
           underneath the menu the user just opened */
        const alreadySelected = store.selectedId === frame.id
        select(frame.id)
        closePopovers()
        store.openCtxMenu({ frameId: frame.id, deferPanel: !alreadySelected })
      }}
    >
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            'group absolute',
            stream &&
              "before:pointer-events-none before:absolute before:-inset-[3px] before:rounded-[9px] before:border-2 before:border-dashed before:border-[var(--editing-color,var(--brand))] before:content-[''] before:animate-[stream-pulse_1.1s_ease-in-out_infinite]",
          )}
          style={
            {
              left: frame.x,
              top: frame.y,
              width: frame.width,
              height: frame.height,
              '--editing-color': stream?.color ?? remoteEditor?.color ?? flash?.color,
            } as React.CSSProperties
          }
          /* stop the event here so the Stage's background menu — whose trigger
         wraps this one — does not open a second menu behind ours */
          onContextMenu={(e) => {
            /* stop here so the Stage's background trigger, which wraps this
               one, does not open a second menu behind ours */
            e.stopPropagation()
            menuAt.current = { x: e.clientX, y: e.clientY }
          }}
        >
          <div
            className={cn(
              'absolute -top-[26px] left-0 right-0 flex origin-bottom-left cursor-grab select-none items-center gap-2 whitespace-nowrap text-[12px] font-semibold text-ink-soft',
              COUNTER_SCALE,
            )}
            style={duping || dupKeyHeld ? { cursor: DUP_CURSOR } : undefined}
            onPointerDown={(e) => startDrag(e, 'move', false, true)}
          >
            {isSyncedFrame(frame.html) && (
              <Tooltip label="Synced from a live app" side="top" align="start">
                <span className="flex shrink-0 items-center text-brand">
                  <SyncIcon width={11} height={11} />
                </span>
              </Tooltip>
            )}
            {isGithubFrame(frame.html) && (
              <Tooltip
                label={
                  isGithubPlaceholder(frame.html)
                    ? 'Found in the repo — awaiting capture'
                    : 'Imported from a GitHub repo'
                }
                side="top"
                align="start"
              >
                <span
                  className={cn(
                    'flex shrink-0 items-center',
                    isGithubPlaceholder(frame.html) ? 'text-ink-faint' : 'text-brand',
                  )}
                >
                  <GithubIcon width={11} height={11} />
                </span>
              </Tooltip>
            )}
            <span className="overflow-hidden text-ellipsis">{frame.name}</span>
            <span className="flex gap-1">
              {stream && (
                <span className={EDITOR_CHIP} style={{ background: stream.color }}>
                  ✦ {stream.name} is designing
                  <span className="after:content-['…'] after:[animation:ellipsis_1.2s_steps(4)_infinite]" />
                </span>
              )}
              {editors
                .filter((p) => p.name !== stream?.name)
                .map((p) => (
                  <span key={p.clientId} className={EDITOR_CHIP} style={{ background: p.color }}>
                    {p.kind === 'agent' ? '✦' : '✎'} {p.name}
                  </span>
                ))}
            </span>
          </div>

          <div
            className={cn(
              'absolute inset-0 cursor-grab overflow-hidden rounded-[6px] border border-line bg-white',
              dragging ? 'shadow-pop' : 'shadow-card',
              selected && 'outline-2 outline-offset-1 outline-brand',
              editing && 'cursor-text outline-2 outline-offset-1 outline-dashed outline-brand',
              !stream &&
                remoteEditor &&
                'outline-2 outline-offset-1 outline-solid outline-[var(--editing-color,var(--brand))]',
              stream && 'border-transparent outline-none',
              dragging && 'cursor-grabbing',
            )}
            style={duping || (dupKeyHeld && !editing) ? { cursor: DUP_CURSOR } : undefined}
            onPointerDown={(e) => startDrag(e, 'move', true)}
            onDoubleClick={() => canEdit && !editing && enterEdit()}
            onPointerMove={(e) => {
              if (editing || dragging || !frame.html || !runtimeReady) return
              /* screen px → design px: the frame lives inside the zoomed stage */
              const r = e.currentTarget.getBoundingClientRect()
              const zoom = useStore.getState().viewport.zoom
              sendHover((e.clientX - r.left) / zoom, (e.clientY - r.top) / zoom)
            }}
            onPointerLeave={clearHover}
          >
            <iframe
              ref={iframeRef}
              className="block border-none bg-white"
              title={frame.name}
              sandbox="allow-scripts"
              srcDoc={FRAME_BOOTSTRAP}
              style={{
                width: frame.width * raster,
                height: frame.height * raster,
                transform: `scale(${1 / raster})`,
                transformOrigin: '0 0',
              }}
            />
            {!frame.html && (
              <div className="absolute inset-0 grid place-items-center bg-[repeating-linear-gradient(45deg,transparent_0_10px,rgba(28,26,21,0.025)_10px_20px)] text-[13px] text-ink-faint">
                empty frame — add HTML
              </div>
            )}
            {/* shield keeps pointer events on the canvas, not the iframe;
            lifted while editing so clicks land in the editable document */}
            {!editing && <div className="absolute inset-0" />}
            {hover && !editing && !dragging && (
              <div
                className="pointer-events-none absolute z-[3] bg-[rgba(60,130,246,0.06)] shadow-[inset_0_0_0_calc(1.5px/var(--zoom,1))_#3c82f6]"
                style={{ left: hover.rect.x, top: hover.rect.y, width: hover.rect.width, height: hover.rect.height }}
              >
                <span
                  className={cn(
                    'absolute top-0 left-0 whitespace-nowrap bg-[#3c82f6] px-1.5 py-[3px] text-[10px] font-bold leading-none text-white [font-family:ui-monospace,monospace]',
                    hover.rect.y < 18
                      ? 'origin-top-left rounded-[0_0_4px_0] [transform:translateY(0)_scale(min(calc(1/var(--zoom,1)),2.4))]'
                      : 'origin-bottom-left rounded-[4px_4px_4px_0] [transform:translateY(-100%)_scale(min(calc(1/var(--zoom,1)),2.4))]',
                  )}
                >
                  {hover.tag}
                </span>
              </div>
            )}
            {probe && selected && !editing && !dragging && (
              <div
                className="pointer-events-none absolute z-[3] shadow-[inset_0_0_0_calc(1.5px/var(--zoom,1))_#3c82f6,0_0_0_calc(1.5px/var(--zoom,1))_rgba(60,130,246,0.35)]"
                style={{ left: probe.rect.x, top: probe.rect.y, width: probe.rect.width, height: probe.rect.height }}
              />
            )}
            {flash && (
              <div
                className="pointer-events-none absolute -inset-px rounded-[6px] animate-[frame-flash_1.2s_ease-out_forwards]"
                style={{ '--editing-color': flash.color } as React.CSSProperties}
              />
            )}
          </div>

          {editing && (
            <div
              className={cn(
                'absolute top-[calc(100%_+_10px)] left-0 flex origin-top-left items-center gap-[9px] whitespace-nowrap rounded-full bg-ink py-1 pr-[5px] pl-3 text-[11px] font-semibold text-white shadow-card animate-[chip-in_0.25s_ease]',
                COUNTER_SCALE,
              )}
              onPointerDown={(e) => e.stopPropagation()}
            >
              Click any text to edit
              <Button
                variant="primary"
                size="pill"
                className="border-transparent px-2.5 shadow-none hover:translate-x-0 hover:translate-y-0 hover:brightness-110 hover:shadow-none"
                onClick={exitEdit}
                title="Save and finish editing (Esc)"
              >
                ✓ Done
              </Button>
            </div>
          )}

          {/* element comments: pins + element toolbar + composer, all in frame
          coords. The toolbar anchors to the probed element normally, and to
          the actively edited element in edit mode. */}
          {(() => {
            const anchor = editing ? activeHit : probe
            return (
              <div className="pointer-events-none absolute inset-0">
                {comments.map((c) => {
                  const pos = pinPos[c.id]
                  if (!pos) return null
                  const open = openThread === c.id
                  const replies = frameComments.filter((r) => r.parentId === c.id).reverse() // store is newest-first
                  const thread = [c, ...replies.sort((a, b) => a.at - b.at)]
                  /* the pin reflects the newest agent request in the thread */
                  const agentItem = [...thread].reverse().find((x) => x.forAgent && !x.resolvedAt)
                  const working = agentItem?.claimedBy && !agentItem.failedAt
                  return (
                    <div
                      key={c.id}
                      className={cn(
                        'pointer-events-auto absolute z-[4] grid h-[26px] w-[26px] cursor-pointer place-items-center rounded-[50%_50%_50%_4px] border-2 border-white text-[13px] text-white [transform:translate(-50%,-50%)_scale(min(calc(1/var(--zoom,1)),2.4))] animate-[chip-in_0.25s_ease]',
                        agentItem?.failedAt
                          ? 'bg-accent-ink! font-extrabold shadow-[0_0_0_3px_rgba(208,52,31,0.2),var(--shadow-card)]'
                          : 'shadow-card',
                        working &&
                          "after:absolute after:-inset-1.5 after:rounded-[inherit] after:border-2 after:border-current after:opacity-50 after:content-[''] after:[animation:stream-pulse_1.1s_ease-in-out_infinite]",
                      )}
                      style={{
                        left: Math.min(Math.max(pos.x, 10), frame.width - 10),
                        top: Math.min(Math.max(pos.y, 10), frame.height - 10),
                        background: colorFor(c.from),
                      }}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => {
                        setProbe(null)
                        setComposing(false)
                        setOpenThread(open ? null : c.id)
                      }}
                      title={`${c.from}: ${c.text}${thread.length > 1 ? ` (${thread.length - 1} replies)` : ''}`}
                    >
                      {agentItem?.failedAt ? '!' : working ? '✦' : '💬'}
                      {open && (
                        <CommentThread
                          thread={thread}
                          onReply={(text) =>
                            api
                              .replyComment(c.id, text)
                              .then(() => posthog.capture('element_comment_replied'))
                              .catch((err) => {
                                /* the wall explains a hit limit; anything else
                                   surfaces in the thread so the draft survives */
                                if (isResidentLimit(err)) useStore.getState().setLimitWall(true)
                                throw err
                              })
                          }
                          onResolve={() => {
                            api
                              .resolveComment(c.id)
                              .then(() => posthog.capture('element_comment_resolved'))
                              .catch(console.error)
                            setOpenThread(null)
                          }}
                          onRetry={(id) =>
                            api.retryComment(id).catch((err) => {
                              if (isResidentLimit(err)) useStore.getState().setLimitWall(true)
                              else console.error(err)
                            })
                          }
                        />
                      )}
                    </div>
                  )
                })}

                {anchor && selected && (
                  <div
                    className="pointer-events-auto absolute z-[7] origin-top-left [transform:scale(min(calc(1/var(--zoom,1)),2.4))_translateY(calc(-100%_-_8px))]"
                    style={{
                      left: Math.min(Math.max(anchor.rect.x, 4), Math.max(4, frame.width - 60)),
                      top: Math.max(anchor.rect.y, 2),
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    {!composing ? (
                      <>
                        <div className="flex items-center gap-1.5 whitespace-nowrap rounded-[10px] bg-ink px-[7px] py-[5px] shadow-pop animate-[chip-in_0.18s_ease]">
                          <span className="px-[3px] text-[11px] font-bold text-brand [font-family:ui-monospace,monospace]">
                            {anchor.tag}
                          </span>
                          <Button
                            variant="inverse"
                            className={EL_TOOLBAR_BTN}
                            onClick={() => {
                              setComposePrefill('')
                              setComposing(true)
                            }}
                          >
                            💬 Comment
                          </Button>
                          <Button
                            variant="inverse"
                            className={EL_TOOLBAR_BTN}
                            onClick={() => {
                              /* pre-mentioned → the comment dispatches as an agent
                             job scoped to this element's selector + snippet */
                              setComposePrefill(`@${DEFAULT_ROLE_ID} `)
                              setComposing(true)
                            }}
                          >
                            ✦ Ask AI
                          </Button>
                          <Button
                            variant="inverse"
                            className={EL_TOOLBAR_BTN}
                            onClick={() => (codeView === null ? requestCode(anchor.selector) : setCodeView(null))}
                          >
                            {'</>'} Code
                          </Button>
                          {!editing && canEdit && anchor.text !== '' && (
                            <Button
                              variant="inverse"
                              className={EL_TOOLBAR_BTN}
                              onClick={() => {
                                enterEdit()
                              }}
                            >
                              ✎ Edit text
                            </Button>
                          )}
                        </div>
                        {codeView !== null && (
                          <div className="relative mt-1.5 w-[440px] max-w-[80vw] rounded-[10px] bg-ink px-3 py-2.5 shadow-pop animate-[chip-in_0.18s_ease]">
                            <Button
                              variant="inverse"
                              size="sm"
                              className="absolute right-2 top-[7px] rounded-md bg-white/[0.12] px-[9px] py-[3px] text-[11px] hover:bg-white/[0.22]"
                              onClick={() => navigator.clipboard.writeText(codeView)}
                            >
                              Copy
                            </Button>
                            <pre className="max-h-[260px] overflow-auto whitespace-pre-wrap text-[11px] leading-[1.55] text-[#d9e2ec] [font-family:ui-monospace,monospace] [word-break:break-word]">
                              {codeView}
                            </pre>
                          </div>
                        )}
                      </>
                    ) : (
                      <CommentComposer
                        initialText={composePrefill}
                        onSubmit={(text) => {
                          api
                            .addComment(frame.id, { selector: anchor.selector, snippet: anchor.snippet, text })
                            .then(() => posthog.capture('element_comment_created'))
                            .catch((err) => {
                              /* an @mention past the free tier raises the wall */
                              if (isResidentLimit(err)) useStore.getState().setLimitWall(true)
                              else console.error(err)
                            })
                          if (editing) setComposing(false)
                          else closePopovers()
                        }}
                        onCancel={() => (editing ? setComposing(false) : closePopovers())}
                      />
                    )}
                  </div>
                )}
              </div>
            )
          })()}

          <div
            className={cn(
              'absolute -right-[7px] -bottom-[7px] h-3.5 w-3.5 cursor-nwse-resize rounded-[4px] border-[1.5px] border-ink bg-surface opacity-0 [transition:opacity_0.12s] group-hover:opacity-100',
              selected && 'opacity-100',
            )}
            onPointerDown={(e) => startDrag(e, 'resize')}
          />
        </div>
      </ContextMenuTrigger>
      <FrameContextMenu frame={frame} at={menuAt} />
    </ContextMenu>
  )
})

function CommentComposer({
  onSubmit,
  onCancel,
  initialText = '',
}: {
  onSubmit: (text: string) => void
  onCancel: () => void
  initialText?: string
}) {
  const [text, setText] = useState(initialText)
  const taRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => taRef.current?.focus(), [])
  const send = () => text.trim() && onSubmit(text)
  /* @mention a resident agent to route the comment to it; without one the
     comment is a note for the humans in the room */
  const mentioned = mentionedRole(text)
  return (
    <div className="w-[240px] rounded-[10px] border border-line bg-surface p-2 shadow-pop animate-[chip-in_0.18s_ease]">
      <Textarea
        ref={taRef}
        variant="bare"
        className="min-h-[58px] md:text-[13px]"
        value={text}
        placeholder="Leave a comment on this element…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send()
          if (e.key === 'Escape') onCancel()
        }}
      />
      {!mentioned && (
        <div className="mb-2 flex flex-wrap gap-1">
          {AGENT_ROLES.map((role) => (
            <Button
              key={role.id}
              variant="ghost"
              size="pill"
              className="border-dashed px-2 text-[11px] font-semibold text-ink-soft hover:border-brand hover:bg-transparent hover:text-brand"
              title={`${role.name} — ${role.blurb}`}
              onClick={() => setText((t) => (t ? t.replace(/\s*$/, ' ') : '') + `@${role.id} `)}
            >
              {role.emoji} @{role.id}
            </Button>
          ))}
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        {mentioned && (
          <span className="mr-auto text-[11px] font-semibold text-brand">
            {mentioned.emoji} {mentioned.name} will pick this up
          </span>
        )}
        <Button variant="solid" size="pill" className="px-3.5 py-[5px] text-xs" disabled={!text.trim()} onClick={send}>
          Post
        </Button>
      </div>
    </div>
  )
}

/** Where an @agent request in the thread stands, or null for a human note. */
function agentStatus(c: ElementComment): string | null {
  const target = c.targetAgent ?? roleName(DEFAULT_ROLE_ID)
  if (c.failedAt) return `${target} stopped`
  if (c.resolvedAt) return c.forAgent ? `✓ ${c.resolvedBy ?? target}` : null
  if (c.claimedBy) return `✦ ${c.claimedBy} is on it`
  return c.forAgent ? `✦ waiting for ${target}` : null
}

function CommentThread({
  thread,
  onReply,
  onResolve,
  onRetry,
}: {
  /** root comment first, then its replies oldest → newest */
  thread: ElementComment[]
  /** rejects when the reply did not land — the draft is kept for a retry */
  onReply: (text: string) => Promise<unknown>
  onResolve: () => void
  onRetry: (commentId: string) => void
}) {
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  /* a long conversation opens (and grows) scrolled to its newest message */
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [thread.length])
  const send = () => {
    if (!reply.trim() || sending) return
    setSending(true)
    setFailed(false)
    onReply(reply)
      .then(() => setReply(''))
      .catch(() => setFailed(true))
      .finally(() => setSending(false))
  }
  const mentioned = mentionedRole(reply)
  return (
    <div
      className="absolute top-[calc(100%_+_8px)] left-1/2 w-[250px] -translate-x-1/2 cursor-default rounded-[10px] border border-line bg-surface p-2.5 text-left shadow-pop animate-[chip-in_0.18s_ease]"
      onClick={(e) => e.stopPropagation()}
    >
      <div ref={listRef} className="-mx-1 max-h-[240px] overflow-y-auto px-1">
        {thread.map((c, i) => {
          const status = agentStatus(c)
          return (
            <div key={c.id} className={cn(i > 0 && 'mt-2 border-t border-line-soft pt-2')}>
              <div className="flex items-center justify-between gap-2 text-[12px]">
                <b style={{ color: colorFor(c.from) }}>{c.from}</b>
                {status && <span className="whitespace-nowrap text-[11px] font-semibold text-brand">{status}</span>}
              </div>
              <div className="mt-1 break-words text-[13px] leading-[1.45] text-ink">{c.text}</div>
              {c.failedAt ? (
                <div className="mt-1 flex items-center gap-2 text-[11px] leading-[1.4] text-accent-ink">
                  <span>{c.failureReason ?? 'The agent did not finish.'}</span>
                  <Button
                    variant="danger-solid"
                    size="pill"
                    className="shrink-0 px-[9px] py-[3px] text-[11px]"
                    onClick={() => onRetry(c.id)}
                  >
                    ↻ Retry
                  </Button>
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
      <Textarea
        variant="bare"
        className="mt-2 min-h-[38px] md:text-[13px]"
        value={reply}
        placeholder="Reply… (@doop to ask the agent)"
        onChange={(e) => setReply(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send()
        }}
      />
      {failed && (
        <div className="mt-1 text-[11px] leading-[1.4] text-accent-ink">
          That reply did not go through — it may be resolved already. Try again.
        </div>
      )}
      <div className="mt-1.5 flex items-center gap-1.5">
        <Button
          variant="ghost"
          size="pill"
          className="px-2.5 text-ink-soft hover:border-ink-soft hover:bg-transparent hover:text-ink"
          onClick={onResolve}
        >
          ✓ Resolve
        </Button>
        {mentioned && (
          <span
            className="ml-auto truncate text-[11px] font-semibold text-brand"
            title={`${mentioned.name} will pick this up`}
          >
            {mentioned.emoji} {mentioned.name}
          </span>
        )}
        <Button
          variant="solid"
          size="pill"
          className={cn('px-3 py-[4px] text-xs', !mentioned && 'ml-auto')}
          disabled={!reply.trim() || sending}
          onClick={send}
        >
          {sending ? 'Posting…' : 'Reply'}
        </Button>
      </div>
    </div>
  )
}
