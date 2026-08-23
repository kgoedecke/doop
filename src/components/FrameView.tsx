import { memo, useEffect, useRef, useState } from 'react'
import type { ElementComment, Frame } from '../../shared/types'
import { colorFor } from '../../shared/types'
import { useStore } from '../lib/store'
import { api } from '../lib/api'
import { sendWs } from '../lib/ws'
import { throttle } from '../lib/throttle'
import { getIdentity } from '../lib/identity'
import { FRAME_BOOTSTRAP } from '../lib/frameRuntime'
import { recordUpdate } from '../lib/history'
import { snapFrame } from '../lib/snap'
import { FrameContextMenu } from './FrameContextMenu'
import { BrainIcon } from './BrainIcon'
import { AGENT_ROLES, DEFAULT_ROLE_ID, mentionedRole, roleName } from '../../shared/agents'
import { posthog } from '../lib/posthog'
import { isResidentLimit } from './TeamAllowance'

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
  const [editing, setEditing] = useState(false)
  const ctxMenu = useStore((s) => (s.ctxMenu?.frameId === frame.id ? s.ctxMenu : null))
  /* after exiting edit mode, hold renders until the final serialized HTML
     lands in the store — otherwise a stale post would morph the edit away */
  const [suspendPost, setSuspendPost] = useState(false)

  const sendDrag = useRef(
    throttle((f: { id: string; x: number; y: number; width: number; height: number }) => {
      sendWs({ type: 'frame:drag', frameId: f.id, x: f.x, y: f.y, width: f.width, height: f.height })
    }, 50),
  ).current

  function startDrag(e: React.PointerEvent, mode: 'move' | 'resize', probeOnClick = false) {
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

    function onMove(ev: PointerEvent) {
      if (Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) > 4) moved = true
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
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const html = useThrottledValue(frame.html, 150)
  const remoteEditor = editors[0]

  /* The iframe loads a bootstrap once; HTML is posted in and DOM-morphed in
     place, so updates never white-flash the frame with a full reload. */
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
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
  const comments = useStore((s) => s.comments).filter((c) => c.frameId === frame.id && !c.resolvedAt)
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
    if (selected || !editing) return
    const id = window.requestAnimationFrame(() => {
      iframeRef.current?.contentWindow?.postMessage({ type: 'doop:edit', on: false }, '*')
      setEditing(false)
      setActiveHit(null)
      setComposing(false)
      activeSelRef.current = null
      setSuspendPost(true)
      window.setTimeout(() => setSuspendPost(false), 500)
    })
    return () => window.cancelAnimationFrame(id)
  }, [selected, editing])

  /* When zoomed past 100%, render the iframe k× larger and counter-scale it,
     with a matching CSS zoom inside — same layout, k× the raster density, so
     frames stay crisp instead of looking like scaled-up bitmaps. The factor
     is computed by the Stage from the settled (gesture-idle) zoom. */
  useEffect(() => {
    if (!runtimeReady) return
    iframeRef.current?.contentWindow?.postMessage({ type: 'doop:zoom', zoom: raster }, '*')
  }, [runtimeReady, raster])

  return (
    <div
      className={[
        'frame',
        selected ? 'selected' : '',
        editing ? 'editing' : '',
        dragging ? 'dragging' : '',
        stream ? 'streaming' : remoteEditor ? 'remote-editing' : '',
      ].join(' ')}
      style={
        {
          left: frame.x,
          top: frame.y,
          width: frame.width,
          height: frame.height,
          '--editing-color': stream?.color ?? remoteEditor?.color ?? flash?.color,
        } as React.CSSProperties
      }
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        const alreadySelected = useStore.getState().selectedId === frame.id
        select(frame.id)
        closePopovers()
        /* deferPanel: when this right-click is what selects the frame, the
           Inspector waits until the menu closes — it must not slide in
           underneath the menu the user just opened */
        useStore.getState().openCtxMenu({ frameId: frame.id, x: e.clientX, y: e.clientY, deferPanel: !alreadySelected })
      }}
    >
      <div className="frame-label" onPointerDown={(e) => startDrag(e, 'move')}>
        <span className="fname">{frame.name}</span>
        <span className="editors">
          {stream && (
            <span className="editor-chip streaming-chip" style={{ background: stream.color }}>
              ✦ {stream.name} is designing
              <span className="ellipsis" />
            </span>
          )}
          {editors
            .filter((p) => p.name !== stream?.name)
            .map((p) => (
              <span key={p.clientId} className="editor-chip" style={{ background: p.color }}>
                {p.kind === 'agent' ? '✦' : '✎'} {p.name}
              </span>
            ))}
        </span>
      </div>
      <PinToMemory frame={frame} />

      <div
        className="frame-body"
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
        {!frame.html && <div className="frame-empty">empty frame — add HTML</div>}
        {/* shield keeps pointer events on the canvas, not the iframe;
            lifted while editing so clicks land in the editable document */}
        {!editing && <div className="iframe-shield" />}
        {hover && !editing && !dragging && (
          <div
            className="el-hover"
            style={{ left: hover.rect.x, top: hover.rect.y, width: hover.rect.width, height: hover.rect.height }}
          >
            <span className={'el-hover-tag' + (hover.rect.y < 18 ? ' inside' : '')}>{hover.tag}</span>
          </div>
        )}
        {probe && selected && !editing && !dragging && (
          <div
            className="el-selected"
            style={{ left: probe.rect.x, top: probe.rect.y, width: probe.rect.width, height: probe.rect.height }}
          />
        )}
        {flash && <div className="frame-flash" style={{ '--editing-color': flash.color } as React.CSSProperties} />}
      </div>

      {editing && (
        <div className="edit-hint" onPointerDown={(e) => e.stopPropagation()}>
          Click any text to edit
          <button onClick={exitEdit} title="Save and finish editing (Esc)">
            ✓ Done
          </button>
        </div>
      )}

      {/* element comments: pins + element toolbar + composer, all in frame
          coords. The toolbar anchors to the probed element normally, and to
          the actively edited element in edit mode. */}
      {(() => {
        const anchor = editing ? activeHit : probe
        return (
          <div className="comment-layer">
            {comments.map((c) => {
              const pos = pinPos[c.id]
              if (!pos) return null
              const open = openThread === c.id
              return (
                <div
                  key={c.id}
                  className={[
                    'comment-pin',
                    c.failedAt ? 'failed' : c.claimedBy && !c.resolvedAt ? 'working' : '',
                  ].join(' ')}
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
                  title={`${c.from}: ${c.text}`}
                >
                  {c.failedAt ? '!' : c.claimedBy && !c.resolvedAt ? '✦' : '💬'}
                  {open && (
                    <CommentThread
                      comment={c}
                      onResolve={() => {
                        api
                          .resolveComment(c.id)
                          .then(() => posthog.capture('element_comment_resolved'))
                          .catch(console.error)
                        setOpenThread(null)
                      }}
                      onRetry={() => api.retryComment(c.id).catch(console.error)}
                    />
                  )}
                </div>
              )
            })}

            {anchor && selected && (
              <div
                className="el-popover"
                style={{
                  left: Math.min(Math.max(anchor.rect.x, 4), Math.max(4, frame.width - 60)),
                  top: Math.max(anchor.rect.y, 2),
                }}
                onPointerDown={(e) => e.stopPropagation()}
              >
                {!composing ? (
                  <>
                    <div className="el-toolbar">
                      <span className="el-tag">{anchor.tag}</span>
                      <button
                        onClick={() => {
                          setComposePrefill('')
                          setComposing(true)
                        }}
                      >
                        💬 Comment
                      </button>
                      <button
                        onClick={() => {
                          /* pre-mentioned → the comment dispatches as an agent
                             job scoped to this element's selector + snippet */
                          setComposePrefill(`@${DEFAULT_ROLE_ID} `)
                          setComposing(true)
                        }}
                      >
                        ✦ Ask AI
                      </button>
                      <button onClick={() => (codeView === null ? requestCode(anchor.selector) : setCodeView(null))}>
                        {'</>'} Code
                      </button>
                      {!editing && canEdit && anchor.text !== '' && (
                        <button
                          onClick={() => {
                            enterEdit()
                          }}
                        >
                          ✎ Edit text
                        </button>
                      )}
                    </div>
                    {codeView !== null && (
                      <div className="el-code">
                        <button className="el-code-copy" onClick={() => navigator.clipboard.writeText(codeView)}>
                          Copy
                        </button>
                        <pre>{codeView}</pre>
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

      <div className="resize-handle" onPointerDown={(e) => startDrag(e, 'resize')} />

      {ctxMenu && <FrameContextMenu frame={frame} at={ctxMenu} onClose={() => useStore.getState().closeCtxMenu()} />}
    </div>
  )
})

/** Quick path into Memory: the brain on the frame chrome pins this design
 *  as a style reference (same action as the context menu, less hidden). */
function PinToMemory({ frame }: { frame: Frame }) {
  const [state, setState] = useState<'idle' | 'pinned' | 'error'>('idle')
  return (
    <button
      className="frame-pin"
      data-tip="Add to design memory — will be used as reference"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        api
          .pinReference(frame.canvasId, frame.id)
          .then(() => setState('pinned'))
          .catch(() => setState('error')) // already pinned or at the cap
        window.setTimeout(() => setState('idle'), 1600)
      }}
    >
      {state === 'pinned' ? '✓ in Memory' : state === 'error' ? 'already pinned' : <BrainIcon />}
    </button>
  )
}

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
    <div className="comment-composer">
      <textarea
        ref={taRef}
        value={text}
        placeholder="Leave a comment on this element…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send()
          if (e.key === 'Escape') onCancel()
        }}
      />
      {!mentioned && (
        <div className="mention-row">
          {AGENT_ROLES.map((role) => (
            <button
              key={role.id}
              className="tag-doop"
              title={`${role.name} — ${role.blurb}`}
              onClick={() => setText((t) => (t ? t.replace(/\s*$/, ' ') : '') + `@${role.id} `)}
            >
              {role.emoji} @{role.id}
            </button>
          ))}
        </div>
      )}
      <div className="composer-row">
        {mentioned && (
          <span className="doop-note">
            {mentioned.emoji} {mentioned.name} will pick this up
          </span>
        )}
        <button className="post" disabled={!text.trim()} onClick={send}>
          Post
        </button>
      </div>
    </div>
  )
}

function CommentThread({
  comment,
  onResolve,
  onRetry,
}: {
  comment: ElementComment
  onResolve: () => void
  onRetry: () => void
}) {
  const target = comment.targetAgent ?? roleName(DEFAULT_ROLE_ID)
  const status = comment.failedAt
    ? `${target} stopped`
    : comment.claimedBy && !comment.resolvedAt
      ? `✦ ${comment.claimedBy} is on it`
      : comment.forAgent
        ? `✦ waiting for ${target}`
        : null
  return (
    <div className="comment-thread" onClick={(e) => e.stopPropagation()}>
      <div className="thread-head">
        <b style={{ color: colorFor(comment.from) }}>{comment.from}</b>
        {status && <span className="thread-status">{status}</span>}
      </div>
      <div className="thread-text">{comment.text}</div>
      {comment.failedAt ? (
        <div className="thread-failure">{comment.failureReason ?? 'The agent did not finish.'}</div>
      ) : null}
      <div className="thread-actions">
        {comment.failedAt ? (
          <button className="retry-action" onClick={onRetry}>
            ↻ Retry
          </button>
        ) : null}
        <button className="resolve" onClick={onResolve}>
          ✓ Resolve
        </button>
      </div>
    </div>
  )
}
