import { createPortal } from 'react-dom'
import {
  useContext,
  useLayoutEffect,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import type { ElementComment, Frame } from '../../shared/types'
import { FRAME_COMMENT_SELECTOR, elementCommentPosition, isElementComment, isFrameComment } from '../../shared/comments'
import { elementIdSelector } from '../../shared/elementId'
import { api } from '../lib/api'
import { posthog } from '../lib/posthog'
import { useStore } from '../lib/store'
import { useT } from '../lib/i18n'
import { commentCursorStyle } from '../lib/commentCursor'
import { CommentComposer, CommentPin, CommentThread } from './CommentPopovers'
import { CommentThreadLayer } from './FrameLabelLayer'
import { isResidentLimit } from './TeamAllowance'

/** What the frame runtime answers a `doop:probe` with, as far as a comment needs. */
interface ProbeHit {
  selector: string
  elementId?: string
  snippet: string
  rect: { x: number; y: number; width: number; height: number }
}

interface Compose {
  hit: ProbeHit
  /** the click, in the frame's design px */
  point: { x: number; y: number }
  /** where the composer sits, in the thread layer's px */
  at: { left: number; top: number }
}

const COMPOSER_WIDTH = 240
const LOCATE_REQ = 'proto-comment:'
let probeRequests = 0

/**
 * Comments on the screen a prototype shows, as the canvas has them: the
 * frame's open threads as pins, and, while commenting, a click on the
 * screen pins a new thread to the element under it (or to the frame at
 * that point, on its background). The screen's own runtime answers where
 * things are, so the screen stays the live design underneath.
 *
 * Pins live in the frame's design px, drawn at the screen's scale and
 * counter-scaled like the canvas's (`--zoom`). The composer and the open
 * thread go into the player's thread layer, since the screen's box clips.
 */
export function PrototypeComments({
  frame,
  iframeRef,
  scale,
  width,
  height,
  rendered,
  commenting,
}: {
  frame: Frame
  iframeRef: RefObject<HTMLIFrameElement | null>
  scale: number
  /** the document's size, which a responsive screen sets to the player's */
  width: number
  height: number
  /** bumped each time the screen's runtime has shown a new document */
  rendered: number
  commenting: boolean
}) {
  const t = useT()
  const threadLayer = useContext(CommentThreadLayer)
  const all = useStore((s) => s.comments)
  const frameComments = all.filter((c) => c.frameId === frame.id)
  const roots = frameComments.filter((c) => !c.parentId && !c.resolvedAt)
  const [pinPos, setPinPos] = useState<Record<string, { x: number; y: number } | null>>({})
  const [openThread, setOpenThread] = useState<string | null>(null)
  const [compose, setCompose] = useState<Compose | null>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  /* read by the runtime's replies, which subscribe once */
  const layerRef = useRef(threadLayer)
  const rootsRef = useRef(roots)
  const commentingRef = useRef(commenting)
  useLayoutEffect(() => {
    layerRef.current = threadLayer
    rootsRef.current = roots
    commentingRef.current = commenting
  })
  /* each scroll the surface passed on: pins are located again */
  const [scrolls, setScrolls] = useState(0)
  const pending = useRef<{ reqId: number; point: { x: number; y: number }; client: { x: number; y: number } } | null>(
    null,
  )

  /* leaving comment mode puts away what it opened */
  const [wasCommenting, setWasCommenting] = useState(commenting)
  if (wasCommenting !== commenting) {
    setWasCommenting(commenting)
    if (!commenting) {
      setCompose(null)
      setOpenThread(null)
    }
  }

  /* the runtime's answers: where each pinned element is, and what a click hit */
  useEffect(() => {
    function onMsg(ev: MessageEvent) {
      const win = iframeRef.current?.contentWindow
      if (!win || ev.source !== win) return
      const data = ev.data as {
        type?: string
        reqId?: unknown
        hit?: ProbeHit | null
        rect?: { x: number; y: number } | null
      } | null
      if (data?.type === 'doop:located' && typeof data.reqId === 'string' && data.reqId.startsWith(LOCATE_REQ)) {
        const id = data.reqId.slice(LOCATE_REQ.length)
        const rect = data.rect
        setPinPos((m) => ({ ...m, [id]: rect ? { x: rect.x, y: rect.y } : null }))
      }
      if (data?.type === 'doop:scroll-by-result') setScrolls((n) => n + 1)
      const asked = pending.current
      if (data?.type === 'doop:probe-result' && asked && data.reqId === asked.reqId) {
        const { point, client } = asked
        pending.current = null
        /* comment mode ended while the screen looked: the click lands nowhere */
        if (!commentingRef.current) return
        const layer = layerRef.current
        const hit = data.hit ?? {
          selector: FRAME_COMMENT_SELECTOR,
          snippet: '',
          rect: { x: point.x, y: point.y, width: 0, height: 0 },
        }
        setCompose({ hit, point, at: composerSpot(layer, client) })
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [iframeRef])

  /* keep pins on their elements while they show: ask again when comment
     mode starts, once a document is shown, after a scroll, and when the
     comment set or the document's size changes */
  const commentKey = JSON.stringify(roots.map((c) => [c.id, c.elementId]))
  useEffect(() => {
    const win = iframeRef.current?.contentWindow
    if (!win || !rendered || !commenting) return
    for (const c of rootsRef.current) {
      if (!isElementComment(c)) continue
      win.postMessage(
        { type: 'doop:locate', reqId: `${LOCATE_REQ}${c.id}`, selector: elementIdSelector(c.elementId) },
        '*',
      )
    }
  }, [iframeRef, rendered, commenting, scrolls, commentKey, width, height])

  function onSurfaceClick(e: MouseEvent<HTMLDivElement>) {
    /* a click away from what is open closes it, as on the canvas */
    if (compose || openThread) {
      setCompose(null)
      setOpenThread(null)
      return
    }
    const box = surfaceRef.current?.getBoundingClientRect()
    const win = iframeRef.current?.contentWindow
    if (!box || !win) return
    const point = { x: (e.clientX - box.left) / scale, y: (e.clientY - box.top) / scale }
    const reqId = ++probeRequests
    pending.current = { reqId, point, client: { x: e.clientX, y: e.clientY } }
    /* not grouped: a comment pins to what is under the pointer */
    win.postMessage({ type: 'doop:probe', reqId, x: point.x, y: point.y, grouped: false, selected: [] }, '*')
  }

  function submit(text: string, mentions: string[]) {
    if (!compose) return
    const { hit, point } = compose
    api
      .addComment(frame.id, {
        selector: hit.selector,
        ...(hit.elementId ? { elementId: hit.elementId } : {}),
        snippet: hit.snippet,
        text,
        mentions,
        x: point.x,
        y: point.y,
        elementOrigin: { x: hit.rect.x, y: hit.rect.y },
      })
      .then(() => posthog.capture('element_comment_created', { via: 'prototype' }))
      .catch((err) => {
        if (isResidentLimit(err)) useStore.getState().setLimitWall(true)
        else console.error(err)
      })
    setCompose(null)
  }

  const world: CSSProperties & Record<'--zoom', number> = {
    width,
    height,
    transform: `scale(${scale})`,
    transformOrigin: '0 0',
    '--zoom': scale,
  }

  return (
    <>
      {commenting && (
        <div
          ref={surfaceRef}
          className="absolute inset-0 z-[3] cursor-comment"
          style={commentCursorStyle()}
          data-proto-comment-surface=""
          onClick={onSurfaceClick}
          /* the cover takes the wheel from the screen: hand it on, so a long
             screen still scrolls to what is below the fold */
          onWheel={(e) =>
            iframeRef.current?.contentWindow?.postMessage(
              { type: 'doop:scroll-by', dx: e.deltaX / scale, dy: e.deltaY / scale },
              '*',
            )
          }
        />
      )}
      {commenting && (
        <div className="pointer-events-none absolute top-0 left-0 z-[4]" style={world} data-proto-comment="">
          {roots.map((c) => {
            const pos = isFrameComment(c) ? { x: c.x, y: c.y } : elementCommentPosition(c, pinPos[c.id])
            if (!pos) return null
            const open = openThread === c.id
            const thread = threadOf(c, frameComments)
            return (
              <CommentPin
                key={c.id}
                still
                thread={thread}
                open={open}
                left={pos.x}
                top={pos.y}
                onToggle={() => {
                  setCompose(null)
                  setOpenThread(open ? null : c.id)
                }}
              >
                <div data-proto-comment="" onKeyDown={(e) => e.stopPropagation()}>
                  <CommentThread
                    thread={thread}
                    onReply={(text, mentions) =>
                      api
                        .replyComment(c.id, text, mentions)
                        .then(() => posthog.capture('element_comment_replied', { via: 'prototype' }))
                        .catch((err) => {
                          if (isResidentLimit(err)) useStore.getState().setLimitWall(true)
                          throw err
                        })
                    }
                    onResolve={() => {
                      api
                        .resolveComment(c.id)
                        .then(() => posthog.capture('element_comment_resolved', { via: 'prototype' }))
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
                </div>
              </CommentPin>
            )
          })}
        </div>
      )}
      {compose && threadLayer && (
        <ComposerPortal layer={threadLayer} at={compose.at}>
          <CommentComposer
            placeholder={compose.hit.selector === FRAME_COMMENT_SELECTOR ? t('stage.commentOnFrame') : undefined}
            onSubmit={submit}
            onCancel={() => setCompose(null)}
          />
        </ComposerPortal>
      )}
    </>
  )
}

/** Beside the click, kept inside the thread layer. */
function composerSpot(layer: HTMLElement | null, client: { x: number; y: number }) {
  const box = layer?.getBoundingClientRect()
  if (!box) return { left: client.x, top: client.y }
  const left = Math.min(Math.max(client.x - box.left + 14, 8), Math.max(8, box.width - COMPOSER_WIDTH - 8))
  const top = Math.min(Math.max(client.y - box.top, 8), Math.max(8, box.height - 200))
  return { left, top }
}

function threadOf(root: ElementComment, comments: ElementComment[]): [ElementComment, ...ElementComment[]] {
  const replies = comments.filter((r) => r.parentId === root.id).sort((a, b) => a.at - b.at)
  return [root, ...replies]
}

function ComposerPortal({
  layer,
  at,
  children,
}: {
  layer: HTMLElement
  at: { left: number; top: number }
  children: ReactNode
}) {
  return createPortal(
    <div
      className="pointer-events-auto absolute"
      style={{ left: at.left, top: at.top }}
      data-proto-comment=""
      data-proto-composer=""
      onKeyDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    layer,
  )
}
