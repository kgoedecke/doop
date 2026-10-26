import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ElementComment } from '../../shared/types'
import { colorFor } from '../../shared/types'
import { AGENT_ROLES, DEFAULT_ROLE_ID, mentionedRole, roleName } from '../../shared/agents'
import { cn } from '@/lib/utils'
import { canCommentOpenCanvas, canEditOpenCanvas, useStore } from '../lib/store'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'
import { RoleMark } from './RoleMark'

/* The comment UI — pins, the composer, an open thread — is shared by the
   frames (element comments, FrameView) and the canvas itself (canvas
   comments, CanvasComments). It is not capped like other counter-scaled
   chrome: it is screen UI the user reads and types in, so it keeps its size
   at every zoom, the way Figma's comment pins do. */
export const PIN_SCALE = '[transform:translate(-50%,-50%)_scale(calc(1/var(--zoom,1)))]'

/** A thread's pin, coloured by its author and reflecting the newest agent
 *  request in the thread (💬 a note, ✦ an agent is on it, ! it failed). The
 *  open thread popover renders as its child, so it inherits the pin's
 *  counter-scale. `left`/`top` are in the parent's coordinate space. */
export function CommentPin({
  thread,
  open,
  left,
  top,
  onToggle,
  children,
}: {
  /** root comment first, then its replies oldest → newest */
  thread: [ElementComment, ...ElementComment[]]
  open: boolean
  left: number
  top: number
  onToggle: () => void
  children?: ReactNode
}) {
  const [root] = thread
  const agentItem = [...thread].reverse().find((x) => x.forAgent && !x.resolvedAt)
  const working = agentItem?.claimedBy && !agentItem.failedAt
  return (
    <div
      className={cn(
        'pointer-events-auto absolute z-[4] grid h-[26px] w-[26px] cursor-pointer place-items-center rounded-[50%_50%_50%_4px] border-2 border-white text-[13px] text-white animate-[chip-in_0.25s_ease]',
        PIN_SCALE,
        agentItem?.failedAt
          ? 'bg-accent-ink! font-extrabold shadow-[0_0_0_3px_rgba(208,52,31,0.2),var(--shadow-card)]'
          : 'shadow-card',
        working &&
          "after:absolute after:-inset-1.5 after:rounded-[inherit] after:border-2 after:border-current after:opacity-50 after:content-[''] after:[animation:stream-pulse_1.1s_ease-in-out_infinite]",
      )}
      style={{ left, top, background: colorFor(root.from) }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onToggle}
      title={`${root.from}: ${root.text}${thread.length > 1 ? ` (${thread.length - 1} replies)` : ''}`}
    >
      {agentItem?.failedAt ? '!' : working ? '✦' : '💬'}
      {open && children}
    </div>
  )
}

export function CommentComposer({
  onSubmit,
  onCancel,
  initialText = '',
  placeholder = 'Leave a comment on this element…',
}: {
  onSubmit: (text: string) => void
  onCancel: () => void
  initialText?: string
  placeholder?: string
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
        placeholder={placeholder}
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
              <RoleMark role={role} size={13} /> @{role.id}
            </Button>
          ))}
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        {mentioned && (
          <span className="mr-auto inline-flex items-center gap-1 text-[11px] font-semibold text-brand">
            <RoleMark role={mentioned} size={13} />
            {mentioned.name} will pick this up
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

export function CommentThread({
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
  /* a view link reads the thread; replying and resolving need comment
     access, and re-running an agent needs edit (the server holds both) */
  const canComment = useStore(canCommentOpenCanvas)
  const canEdit = useStore(canEditOpenCanvas)
  const listRef = useRef<HTMLDivElement>(null)
  /* a long conversation opens (and grows) scrolled to its newest message */
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [thread.length])
  const send = () => {
    if (!reply.trim() || sending) return
    const submitted = reply
    setSending(true)
    setFailed(false)
    onReply(submitted)
      /* only clear what was sent — text typed meanwhile is a new draft */
      .then(() => setReply((current) => (current === submitted ? '' : current)))
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
                  {canEdit && (
                    <Button
                      variant="danger-solid"
                      size="pill"
                      className="shrink-0 px-[9px] py-[3px] text-[11px]"
                      onClick={() => onRetry(c.id)}
                    >
                      ↻ Retry
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
          placeholder={canEdit ? 'Reply… (@doop to ask the agent)' : 'Reply…'}
          failed={failed}
          sending={sending}
          mentioned={mentioned}
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
  mentioned,
  onChange,
  onSend,
  onResolve,
}: {
  reply: string
  placeholder: string
  failed: boolean
  sending: boolean
  mentioned: ReturnType<typeof mentionedRole>
  onChange: (text: string) => void
  onSend: () => void
  onResolve: () => void
}) {
  return (
    <>
      <Textarea
        variant="bare"
        className="mt-2 min-h-[38px] md:text-[13px]"
        value={reply}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSend()
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
            className="ml-auto inline-flex min-w-0 items-center gap-1 truncate text-[11px] font-semibold text-brand"
            title={`${mentioned.name} will pick this up`}
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
          onClick={onSend}
        >
          {sending ? 'Posting…' : 'Reply'}
        </Button>
      </div>
    </>
  )
}
