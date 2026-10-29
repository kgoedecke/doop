import { useCallback, useEffect, useRef, useState } from 'react'
import type { ElementComment } from '../../shared/types'
import { colorFor } from '../../shared/types'
import { canvasPages } from '../../shared/pages'
import { isCanvasComment, type CanvasComment } from '../../shared/comments'
import { useStore } from '../lib/store'
import { api } from '../lib/api'
import { getIdentity } from '../lib/identity'
import type { ComposerPlacement } from '../lib/composerPlacement'
import { posthog } from '../lib/posthog'
import { isResidentLimit } from './TeamAllowance'
import { CommentComposer, CommentPin, CommentThread, PIN_SCALE } from './CommentPopovers'
import { cn } from '@/lib/utils'
import { CommentIcon } from './ui/icons'

/** Where the Comment tool was clicked on empty canvas: a world point on the
 *  active page. `at` makes a second click on the same spot a new request. */
export interface CanvasComposeAt {
  x: number
  y: number
  /** which side of the pin the composer hangs on, and how far to slide it
   *  along x to stay on the stage (src/lib/composerPlacement.ts) */
  placement: ComposerPlacement
  at: number
}

/* the composer hangs off its anchor point and counter-scales from it, so it
   keeps its screen size at every zoom like the pins */
const ANCHOR_SCALE = 'origin-top-left [transform:scale(calc(1/var(--zoom,1)))]'

/* the wall explains a hit limit; anything else is logged */
function reportLimit(err: unknown) {
  if (isResidentLimit(err)) useStore.getState().setLimitWall(true)
  else console.error(err)
}

/** Comments pinned to the canvas itself — a point on the page rather than
 *  an element: their pins on the active page, the thread that is open, and
 *  the composer the Comment tool opens where the canvas was clicked. Lives
 *  in the world layer so pins stay glued to their point as the camera
 *  moves; the pins and popovers counter-scale through `--zoom`. */
export function CanvasComments({
  composeAt,
  onComposeDone,
}: {
  composeAt: CanvasComposeAt | null
  /** the composer posted or was cancelled */
  onComposeDone: () => void
}) {
  const canvasId = useStore((s) => s.canvas?.id)
  const pageId = useStore((s) => (s.canvas ? (s.activePageId ?? canvasPages(s.canvas)[0]!.id) : null))
  const all = useStore((s) => s.comments)
  /* only thread roots get a pin; replies live inside the root's popover */
  const roots = all.filter(
    (c): c is CanvasComment => isCanvasComment(c) && c.pageId === pageId && !c.parentId && !c.resolvedAt,
  )
  const [openThread, setOpenThread] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  /* a pin being dragged, from this layer or out of a frame: its ghost rides
     the pointer here, above every frame, where no frame surface clips it */
  const drag = useStore((s) => s.commentDrag)
  const dragRoot = drag ? all.find((c) => c.id === drag.id) : undefined

  /* the Comments panel asked for one of these threads to open: the request
     is consumed once the thread is up, so a page switch back never reopens it */
  const threadRequest = useStore((s) => s.threadRequest)
  const requested = threadRequest && roots.some((c) => c.id === threadRequest.id) ? threadRequest : null
  const [seenRequest, setSeenRequest] = useState<typeof requested>(null)
  if (requested !== seenRequest) {
    setSeenRequest(requested)
    if (requested) setOpenThread(requested.id)
  }
  useEffect(() => {
    if (requested) useStore.getState().clearThreadRequest()
  }, [requested])

  /* a fresh compose point takes over from whatever thread was open */
  const [seenCompose, setSeenCompose] = useState(composeAt)
  if (composeAt !== seenCompose) {
    setSeenCompose(composeAt)
    if (composeAt) setOpenThread(null)
  }

  const close = useCallback(() => {
    setOpenThread(null)
    onComposeDone()
  }, [onComposeDone])

  /* Esc, or a press anywhere outside the popovers, closes them. The press
     is watched in the capture phase: a frame stops it before it would reach
     the Stage, and a click on empty canvas opens a new composer after. */
  const anyOpen = composeAt !== null || openThread !== null
  useEffect(() => {
    if (!anyOpen) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close()
    }
    function onPress(e: PointerEvent) {
      if (rootRef.current?.contains(e.target as Node)) return
      close()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onPress, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onPress, true)
    }
  }, [anyOpen, close])

  function post(text: string) {
    if (!canvasId || !pageId || !composeAt) return
    api
      .addCanvasComment(canvasId, { pageId, x: composeAt.x, y: composeAt.y, text })
      .then(() => posthog.capture('canvas_comment_created'))
      .catch(reportLimit)
    onComposeDone()
  }

  return (
    /* `data-comment-ui`: the Comment tool's cursor is forced over the whole
       stage except inside the comment UI, which keeps its own cursors */
    <div ref={rootRef} data-comment-ui className="pointer-events-none absolute left-0 top-0 z-[6]">
      {roots.map((c) => {
        const replies = all.filter((r) => r.parentId === c.id).sort((a, b) => a.at - b.at)
        const thread: [ElementComment, ...ElementComment[]] = [c, ...replies]
        const open = openThread === c.id
        return (
          <CommentPin
            key={c.id}
            thread={thread}
            open={open}
            left={c.x}
            top={c.y}
            onToggle={() => {
              onComposeDone()
              setOpenThread(open ? null : c.id)
            }}
          >
            <CommentThread
              thread={thread}
              onReply={(text) =>
                api
                  .replyComment(c.id, text)
                  .then(() => posthog.capture('element_comment_replied'))
                  .catch((err) => {
                    /* the wall explains a hit limit; anything else surfaces
                       in the thread so the draft survives */
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
              onRetry={(id) => api.retryComment(id).catch(reportLimit)}
            />
          </CommentPin>
        )
      })}

      {drag && dragRoot && (
        <div
          data-comment-drag
          className={cn(
            'pointer-events-none absolute z-[8] grid h-[26px] w-[26px] place-items-center rounded-[50%_50%_50%_4px] border-2 border-white text-[13px] text-white shadow-pop',
            PIN_SCALE,
          )}
          style={{ left: drag.x, top: drag.y, background: colorFor(dragRoot.from) }}
        >
          <CommentIcon size={14} />
        </div>
      )}

      {composeAt && canvasId && (
        <div
          className={cn('pointer-events-auto absolute z-[7]', ANCHOR_SCALE)}
          style={{ left: composeAt.x, top: composeAt.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {/* the pin this comment will get, so the point reads before it is posted */}
          <div
            className="absolute grid h-[26px] w-[26px] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-[50%_50%_50%_4px] border-2 border-white text-[13px] text-white shadow-card animate-[chip-in_0.25s_ease]"
            style={{ background: colorFor(getIdentity().name) }}
          >
            <CommentIcon size={14} />
          </div>
          <div
            className={cn('absolute -top-[13px]', composeAt.placement.side === 'left' ? 'right-[20px]' : 'left-[20px]')}
            style={composeAt.placement.shift ? { transform: `translateX(${composeAt.placement.shift}px)` } : undefined}
          >
            <CommentComposer placeholder="Leave a comment here…" onSubmit={post} onCancel={close} />
          </div>
        </div>
      )}
    </div>
  )
}
