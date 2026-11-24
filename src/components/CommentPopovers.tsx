import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { ElementComment } from '../../shared/types'
import { colorFor } from '../../shared/types'
import { DEFAULT_ROLE_NAME } from '../../shared/agents'
import { useRoster } from '../hooks/use-roster'
import { cn } from '@/lib/utils'
import { canCommentOpenCanvas, canEditOpenCanvas, useStore } from '../lib/store'
import { clientToWorld, dropComment, DRAG_THRESHOLD_PX } from '../lib/commentMove'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'
import { CheckIcon, CommentIcon, LinkIcon, SparkIcon, SyncIcon } from './ui/icons'
import { IconButton } from './ui/icon-button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from './ui/context-menu'
import { MentionText, useAgentMention, useMentionPicker } from './MentionPicker'
import { copyCommentLink } from '../lib/commentLink'
import { RoleMark } from './RoleMark'
import { useSkillMenu } from './SkillMenu'
import { useT, type Translate } from '../lib/i18n'
import { CommentThreadLayer } from './FrameLabelLayer'

/* The comment UI — pins, the composer, an open thread — is shared by the
   frames (element comments, FrameView) and the canvas itself (canvas
   comments, CanvasComments). It is not capped like other counter-scaled
   chrome: it is screen UI the user reads and types in, so it keeps its size
   at every zoom, the way Figma's comment pins do. */
export const PIN_SCALE = '[transform:translate(-50%,-50%)_scale(calc(1/var(--zoom,1)))]'

/** A thread's pin, coloured by its author and reflecting the newest agent
 *  request in the thread (a speech bubble for a note, a spark while an agent is on it, ! when it failed). The
 *  open thread popover renders as its child, so it inherits the pin's
 *  counter-scale. `left`/`top` are in the parent's coordinate space.
 *
 *  Anyone who may comment can drag the pin somewhere else: the pin hides
 *  and a ghost rides the pointer in the world layer (CanvasComments), above
 *  every frame, since this pin may sit inside a frame that clips it. On
 *  release the thread is re-pinned to whatever is under the pointer
 *  (src/lib/commentMove.ts); Esc puts it back. A press that moves less than
 *  the threshold is the click that toggles the thread.
 *
 *  Under a Stage the open thread is portalled into its screen-space layer
 *  (`CommentThreadLayer`), above the frames' size badges, and kept on its
 *  pin as the camera pans and zooms, as Figma's thread is. */
export function CommentPin({
  thread,
  open,
  left,
  top,
  onToggle,
  still = false,
  children,
}: {
  /** root comment first, then its replies oldest → newest */
  thread: [ElementComment, ...ElementComment[]]
  open: boolean
  left: number
  top: number
  onToggle: () => void
  /** a pin off the canvas (the prototype player): no drag to re-pin and no
   *  menu, both of which read the canvas's camera and layers */
  still?: boolean
  children?: ReactNode
}) {
  const [root] = thread
  const agentItem = [...thread].reverse().find((x) => x.forAgent && !x.resolvedAt)
  const working = agentItem?.claimedBy && !agentItem.failedAt
  const movable = useStore(canCommentOpenCanvas) && !still
  const dragged = useStore((s) => s.commentDrag?.id === root.id)
  /* the click after a drag's release must not toggle the thread */
  const suppressClick = useRef(false)
  /* a press under way, dropped if the pin goes away first (resolved by
     someone else, hidden with ⇧C): its listeners would outlive it */
  const abandonPress = useRef<(() => void) | null>(null)
  useEffect(() => () => abandonPress.current?.(), [])
  const t = useT()
  const threadLayer = useContext(CommentThreadLayer)
  const pinRef = useRef<HTMLDivElement>(null)
  const anchorRef = useRef<HTMLDivElement>(null)
  const showThread = open && !dragged
  useLayoutEffect(() => {
    const pin = pinRef.current
    const anchor = anchorRef.current
    if (!showThread || !threadLayer || !pin || !anchor) return
    /* the anchor is the pin's box in the layer, the thread hangs under it */
    const place = () => {
      const p = pin.getBoundingClientRect()
      const l = threadLayer.getBoundingClientRect()
      anchor.style.left = `${p.left - l.left}px`
      anchor.style.top = `${p.top - l.top}px`
      anchor.style.width = `${p.width}px`
      anchor.style.height = `${p.height}px`
    }
    place()
    /* the pin's pop-in animates its transform, which drops its centring
       while it runs: a thread opened mid-pop is placed again once it ends */
    let live = true
    for (const a of pin.getAnimations()) void a.finished.then(() => live && place()).catch(() => {})
    let raf = 0
    const unsub = useStore.subscribe((s, prev) => {
      /* a frame moved or resized (a drag, a peer's edit): measured once the
         pin has been drawn where it now is */
      if (s.canvas !== prev.canvas) {
        cancelAnimationFrame(raf)
        raf = requestAnimationFrame(place)
      }
      const v = s.viewport
      const u = prev.viewport
      /* a still pin is not in the canvas's world: the camera moves nothing */
      if (still || v === u) return
      /* the pin is drawn in the world (screen = world × zoom + offset) at a
         constant screen size, so its centre moves with the camera. Worked
         out here rather than measured: the Stage may not have moved the
         world for this camera yet */
      const cx = parseFloat(anchor.style.left) + anchor.offsetWidth / 2
      const cy = parseFloat(anchor.style.top) + anchor.offsetHeight / 2
      anchor.style.left = `${parseFloat(anchor.style.left) + ((cx - u.x) / u.zoom) * v.zoom + v.x - cx}px`
      anchor.style.top = `${parseFloat(anchor.style.top) + ((cy - u.y) / u.zoom) * v.zoom + v.y - cy}px`
    })
    return () => {
      live = false
      unsub()
      cancelAnimationFrame(raf)
    }
  }, [showThread, threadLayer, left, top, still])

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.stopPropagation()
    /* a press inside the open thread (its reply field, its buttons) is the
       thread's own: capturing it here would retarget the click at the pin */
    if (!movable || e.button !== 0 || (e.target as Element).closest('[data-comment-popover]')) return
    const pin = e.currentTarget
    const origin = { x: e.clientX, y: e.clientY }
    let moving = false
    pin.setPointerCapture(e.pointerId)
    const stop = () => {
      pin.removeEventListener('pointermove', onMove)
      pin.removeEventListener('pointerup', onUp)
      pin.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onKey, true)
      document.body.style.cursor = ''
      abandonPress.current = null
    }
    const onMove = (ev: PointerEvent) => {
      if (!moving) {
        if (Math.abs(ev.clientX - origin.x) + Math.abs(ev.clientY - origin.y) <= DRAG_THRESHOLD_PX) return
        moving = true
        document.body.style.cursor = 'grabbing'
      }
      useStore.getState().setCommentDrag({ id: root.id, ...clientToWorld(ev.clientX, ev.clientY) })
    }
    const onUp = (ev: PointerEvent) => {
      stop()
      if (!moving) return
      suppressClick.current = true
      window.setTimeout(() => (suppressClick.current = false), 0)
      /* the ghost stays until the move has landed (or was refused), so the
         pin never flashes back to its old place first */
      void dropComment(root, clientToWorld(ev.clientX, ev.clientY)).finally(() =>
        useStore.getState().setCommentDrag(null),
      )
    }
    const onCancel = () => {
      stop()
      if (moving) {
        /* the pointer is still down: the click its release fires must not
           toggle the thread, and the flag must not outlive that release */
        suppressClick.current = true
        pin.addEventListener('pointerup', () => window.setTimeout(() => (suppressClick.current = false), 0), {
          once: true,
        })
      }
      useStore.getState().setCommentDrag(null)
    }
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return
      ev.stopPropagation()
      onCancel()
    }
    pin.addEventListener('pointermove', onMove)
    pin.addEventListener('pointerup', onUp)
    pin.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKey, true)
    abandonPress.current = () => {
      stop()
      if (moving) useStore.getState().setCommentDrag(null)
    }
  }

  const pin = (
    <div
      className={cn(
        'pointer-events-auto absolute z-[4] grid h-[26px] w-[26px] cursor-pointer place-items-center rounded-[50%_50%_50%_4px] border-2 border-white text-[13px] text-white animate-[chip-in_0.25s_ease]',
        PIN_SCALE,
        dragged && 'opacity-0',
        agentItem?.failedAt
          ? 'bg-accent-ink! font-extrabold shadow-[0_0_0_3px_rgba(208,52,31,0.2),var(--shadow-card)]'
          : 'shadow-card',
        working &&
          "after:absolute after:-inset-1.5 after:rounded-[inherit] after:border-2 after:border-current after:opacity-50 after:content-[''] after:[animation:stream-pulse_1.1s_ease-in-out_infinite]",
      )}
      ref={pinRef}
      style={{ left, top, background: colorFor(root.from) }}
      onPointerDown={onPointerDown}
      /* the pin's own menu: stopped here so the frame's or the canvas's
         menu, whose triggers wrap this one, does not open behind it */
      onContextMenu={(e) => e.stopPropagation()}
      onClick={() => {
        if (suppressClick.current) {
          suppressClick.current = false
          return
        }
        onToggle()
      }}
      title={`${root.from}: ${root.text}${thread.length > 1 ? t('stage.pinReplies', { count: thread.length - 1 }) : ''}`}
    >
      {agentItem?.failedAt ? '!' : working ? <SparkIcon size={14} /> : <CommentIcon size={14} />}
      {showThread &&
        (threadLayer
          ? createPortal(
              <div
                ref={anchorRef}
                data-comment-thread-anchor
                className="pointer-events-none absolute *:pointer-events-auto"
              >
                {children}
              </div>,
              threadLayer,
            )
          : children)}
    </div>
  )
  if (still) return pin
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{pin}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => void copyCommentLink(root)}>
          <LinkIcon size="rail" />
          {t('stage.copyCommentLink')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

export function CommentComposer({
  onSubmit,
  onCancel,
  initialText = '',
  placeholder,
}: {
  /** `mentions`: the people picked from the @ list (server/canvasPeople.ts) */
  onSubmit: (text: string, mentions: string[]) => void
  onCancel: () => void
  initialText?: string
  placeholder?: string
}) {
  const t = useT()
  const [text, setText] = useState(initialText)
  const taRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => taRef.current?.focus(), [])
  const mentions = useMentionPicker({ value: text, onChange: setText, fieldRef: taRef })
  const send = () => text.trim() && onSubmit(text, mentions.picked(text))
  const canvasId = useStore((s) => s.canvas?.id)
  const skillMenu = useSkillMenu({ from: canvasId ? { canvasId } : undefined, text, setText, inputRef: taRef })
  /* @mention a resident agent to route the comment to it; without one the
     comment is a note for the humans in the room. Asking one takes edit. */
  const roster = useRoster()
  const canAskAgents = useStore(canEditOpenCanvas)
  const mentioned = useAgentMention(text, mentions.picked(text))
  return (
    <div className="w-[240px] rounded-[10px] border border-line bg-surface p-2 shadow-pop animate-[chip-in_0.18s_ease]">
      <div className="relative">
        {skillMenu.menu}
        <Textarea
          ref={taRef}
          variant="bare"
          className="min-h-[58px] md:text-[13px]"
          value={text}
          placeholder={placeholder ?? t('stage.commentOnElement')}
          {...skillMenu.inputProps}
          {...mentions.fieldProps}
          onChange={(e) => {
            skillMenu.inputProps.onChange(e)
            mentions.onCaret(e)
          }}
          onSelect={(e) => {
            skillMenu.inputProps.onSelect(e)
            mentions.onCaret(e)
          }}
          onKeyDown={(e) => {
            if (skillMenu.onKeyDown(e) || mentions.onKeyDown(e)) return
            /* keys that finish an IME composition belong to it */
            if (e.nativeEvent.isComposing || e.keyCode === 229) return
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send()
            if (e.key === 'Escape') onCancel()
          }}
        />
        {mentions.list}
      </div>
      {!mentioned && canAskAgents && (
        /* Leave room inside the scrollport for the pills' shadow outlines and focus rings. */
        <div className="-mx-1 mb-2 flex max-h-[124px] flex-wrap gap-1 overflow-y-auto p-1">
          {roster.map((role) => (
            <Button
              key={role.id}
              variant="ghost"
              size="pill"
              className="border-dashed px-2 text-[11px] font-semibold text-ink-soft hover:border-brand hover:bg-transparent hover:text-brand"
              title={`${role.name} — ${role.blurb}`}
              onClick={() => setText((current) => (current ? current.replace(/\s*$/, ' ') : '') + `@${role.id} `)}
            >
              <RoleMark role={role} size={13} /> @{role.id}
            </Button>
          ))}
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        {mentioned && (
          <span className="mr-auto inline-flex items-center gap-1 text-[11px] font-semibold text-brand">
            <RoleMark role={mentioned} size={13} />
            {t('stage.willPickUp', { name: mentioned.name })}
          </span>
        )}
        <Button variant="solid" size="pill" className="px-3.5 py-[5px] text-xs" disabled={!text.trim()} onClick={send}>
          {t('stage.post')}
        </Button>
      </div>
    </div>
  )
}

/** Where an @agent request in the thread stands, or null for a human note. */
function agentStatus(c: ElementComment, t: Translate): ReactNode {
  const target = c.targetAgent ?? DEFAULT_ROLE_NAME
  if (c.failedAt) return t('stage.agentStopped', { name: target })
  if (c.resolvedAt)
    return c.forAgent ? (
      <>
        <CheckIcon size={12} />
        {c.resolvedBy ?? target}
      </>
    ) : null
  if (c.claimedBy)
    return (
      <>
        <SparkIcon size={12} />
        {t('stage.isOnIt', { name: c.claimedBy })}
      </>
    )
  return c.forAgent ? (
    <>
      <SparkIcon size={12} />
      {t('stage.waitingFor', { name: target })}
    </>
  ) : null
}

export function CommentThread({
  thread,
  onReply,
  onResolve,
  onRetry,
}: {
  /** root comment first, then its replies oldest → newest */
  thread: ElementComment[]
  /** rejects when the reply did not land — the draft is kept for a retry */
  /** `mentions`: the people picked from the @ list (server/canvasPeople.ts) */
  onReply: (text: string, mentions: string[]) => Promise<unknown>
  onResolve: () => void
  onRetry: (commentId: string) => void
}) {
  const t = useT()
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState(false)
  /* a view link reads the thread; replying and resolving need comment
     access, and re-running an agent needs edit (the server holds both) */
  const canComment = useStore(canCommentOpenCanvas)
  const canEdit = useStore(canEditOpenCanvas)
  const listRef = useRef<HTMLDivElement>(null)
  /* a long conversation opens (and grows) scrolled to its newest message */
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [thread.length])
  const send = (mentions: string[]) => {
    if (!reply.trim() || sending) return
    const submitted = reply
    setSending(true)
    setFailed(false)
    onReply(submitted, mentions)
      /* only clear what was sent — text typed meanwhile is a new draft */
      .then(() => setReply((current) => (current === submitted ? '' : current)))
      .catch(() => setFailed(true))
      .finally(() => setSending(false))
  }
  return (
    <div
      data-comment-popover
      className="absolute top-[calc(100%_+_8px)] left-1/2 w-[250px] -translate-x-1/2 cursor-default rounded-[10px] border border-line bg-surface p-2.5 text-left shadow-pop animate-[chip-in_0.18s_ease]"
      onClick={(e) => e.stopPropagation()}
      /* inside the thread the browser's own menu (copy, paste) stays */
      onContextMenu={(e) => e.stopPropagation()}
      /* nor the pin's touch long-press: the pin's menu trigger is this
         thread's parent in React, portal or not */
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div ref={listRef} className="-mx-1 max-h-[240px] overflow-y-auto px-1">
        {thread.map((c, i) => {
          const status = agentStatus(c, t)
          return (
            <div key={c.id} className={cn(i > 0 && 'mt-2 border-t border-line-soft pt-2')}>
              <div className="flex items-center justify-between gap-2 text-[12px]">
                <b style={{ color: colorFor(c.from) }}>{c.from}</b>
                <span className="flex min-w-0 items-center gap-1">
                  {status && (
                    <span className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] font-semibold text-brand">
                      {status}
                    </span>
                  )}
                  {i === 0 && (
                    <IconButton
                      size="sm"
                      className="-my-1 size-[22px] text-ink-faint hover:text-ink"
                      aria-label={t('stage.copyCommentLink')}
                      title={t('stage.copyCommentLink')}
                      onClick={() => void copyCommentLink(c)}
                    >
                      <LinkIcon size={13} />
                    </IconButton>
                  )}
                </span>
              </div>
              <div className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-[1.45] text-ink">
                <MentionText text={c.text} />
              </div>
              {c.failedAt ? (
                <div className="mt-1 flex items-center gap-2 text-[11px] leading-[1.4] text-accent-ink">
                  <span>{c.failureReason ?? t('stage.agentDidNotFinish')}</span>
                  {canEdit && (
                    <Button
                      variant="danger-solid"
                      size="pill"
                      className="shrink-0 px-[9px] py-[3px] text-[11px]"
                      onClick={() => onRetry(c.id)}
                    >
                      <SyncIcon size={12} />
                      {t('stage.retry')}
                    </Button>
                  )}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
      {canComment && (
        <ThreadReply
          reply={reply}
          placeholder={canEdit ? t('stage.replyAskAgent') : t('stage.replyEllipsis')}
          failed={failed}
          sending={sending}
          onChange={setReply}
          onSend={send}
          onResolve={onResolve}
        />
      )}
    </div>
  )
}

/** The reply field and Resolve / Reply actions under an open thread. */
function ThreadReply({
  reply,
  placeholder,
  failed,
  sending,
  onChange,
  onSend,
  onResolve,
}: {
  reply: string
  placeholder: string
  failed: boolean
  sending: boolean
  onChange: (text: string) => void
  onSend: (mentions: string[]) => void
  onResolve: () => void
}) {
  const t = useT()
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  const mentions = useMentionPicker({ value: reply, onChange, fieldRef })
  const mentioned = useAgentMention(reply, mentions.picked(reply))
  const canvasId = useStore((s) => s.canvas?.id)
  const skillMenu = useSkillMenu({
    from: canvasId ? { canvasId } : undefined,
    text: reply,
    setText: onChange,
    inputRef: fieldRef,
  })
  return (
    <>
      <div className="relative mt-2">
        {skillMenu.menu}
        <Textarea
          ref={fieldRef}
          variant="bare"
          className="min-h-[38px] md:text-[13px]"
          value={reply}
          placeholder={placeholder}
          {...skillMenu.inputProps}
          {...mentions.fieldProps}
          onChange={(e) => {
            skillMenu.inputProps.onChange(e)
            mentions.onCaret(e)
          }}
          onSelect={(e) => {
            skillMenu.inputProps.onSelect(e)
            mentions.onCaret(e)
          }}
          onKeyDown={(e) => {
            if (skillMenu.onKeyDown(e) || mentions.onKeyDown(e)) return
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing)
              onSend(mentions.picked(reply))
          }}
        />
        {mentions.list}
      </div>
      {failed && <div className="mt-1 text-[11px] leading-[1.4] text-accent-ink">{t('stage.replyFailed')}</div>}
      <div className="mt-1.5 flex items-center gap-1.5">
        <Button
          variant="ghost"
          size="pill"
          className="px-2.5 text-ink-soft hover:border-ink-soft hover:bg-transparent hover:text-ink"
          onClick={onResolve}
        >
          <CheckIcon size={12} />
          {t('stage.resolve')}
        </Button>
        {mentioned && (
          <span
            className="ml-auto inline-flex min-w-0 items-center gap-1 truncate text-[11px] font-semibold text-brand"
            title={t('stage.willPickUp', { name: mentioned.name })}
          >
            <RoleMark role={mentioned} size={13} />
            <span className="truncate">{mentioned.name}</span>
          </span>
        )}
        <Button
          variant="solid"
          size="pill"
          className={cn('px-3 py-[4px] text-xs', !mentioned && 'ml-auto')}
          disabled={!reply.trim() || sending}
          onClick={() => onSend(mentions.picked(reply))}
        >
          {sending ? t('stage.posting') : t('stage.reply')}
        </Button>
      </div>
    </>
  )
}
