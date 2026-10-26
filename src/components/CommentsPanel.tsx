import { useMemo, useState } from 'react'
import { colorFor } from '../../shared/types'
import { canCommentOpenCanvas, useStore } from '../lib/store'
import { api } from '../lib/api'
import { posthog } from '../lib/posthog'
import { timeAgo } from '../lib/time'
import { isComposingEnter } from '../lib/keys'
import { isCanvasComment } from '../../shared/comments'
import { pageThreads, threadState, type CommentThreadGroup, type ThreadState } from '../lib/comments'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { PanelBody } from './ui/panel'
import { CheckIcon } from './ui/icons'
import { Disclosure } from './ui/collapsible'
import { isResidentLimit } from './TeamAllowance'

const emptyNote = 'px-4 py-6 text-center text-[12px] leading-[1.45] text-ink-faint'

/** Every comment thread on the current page — pinned to a frame or to the
 *  canvas itself — open ones first. Clicking a thread flies to its pin and
 *  opens it; replying and resolving work from here too, so a review pass
 *  never has to hunt pins across the canvas. */
export function CommentsPanel() {
  const comments = useStore((s) => s.comments)
  const canvas = useStore((s) => s.canvas)
  const activePageId = useStore((s) => s.activePageId)
  const [filter, setFilter] = useState<ThreadState>('open')

  const threads = useMemo(() => pageThreads(comments, canvas, activePageId), [comments, canvas, activePageId])
  const counts = { open: 0, resolved: 0 }
  for (const t of threads) counts[threadState(t)] += 1
  const shown = threads.filter((t) => threadState(t) === filter)

  if (threads.length === 0) {
    return (
      <PanelBody className="py-2">
        <div className={emptyNote}>
          No comments on this page yet. Use the comment tool or right-click an element to leave one.
        </div>
      </PanelBody>
    )
  }

  return (
    <PanelBody className="pb-2">
      {/* the same quiet segmented switch as the panel's own tabs */}
      <div role="group" aria-label="Comment filter" className="flex gap-0.5 px-3 pt-2 pb-1">
        <FilterTab active={filter === 'open'} count={counts.open} onClick={() => setFilter('open')}>
          Open
        </FilterTab>
        <FilterTab active={filter === 'resolved'} count={counts.resolved} onClick={() => setFilter('resolved')}>
          Resolved
        </FilterTab>
      </div>
      {shown.length === 0 ? (
        <div className={emptyNote}>No {filter} threads on this page.</div>
      ) : (
        shown.map((t) => <ThreadRow key={t.root.id} thread={t} />)
      )}
    </PanelBody>
  )
}

function FilterTab({
  active,
  count,
  children,
  onClick,
}: {
  active: boolean
  count: number
  children: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'flex h-[26px] items-center gap-1.5 rounded-[7px] px-2 text-[12px] transition-colors',
        active ? 'bg-paper-deep font-medium text-ink' : 'text-ink-soft hover:bg-sub hover:text-ink',
      )}
    >
      {children}
      <span className={cn('text-[11px] tabular-nums', active ? 'text-ink-soft' : 'text-ink-faint')}>{count}</span>
    </button>
  )
}

/* replies and resolves are metered like any other resident task when they
   @mention an agent — a 403 means the free tier ran out, so raise the wall */
function reportLimit(err: unknown) {
  if (isResidentLimit(err)) useStore.getState().setLimitWall(true)
  else console.error(err)
}

/** One thread, in the same shape as a task row: who and when on the first
 *  line, the comment under it, then where it is pinned and how many replies.
 *  Open threads carry a reply field and a Resolve action. */
function ThreadRow({ thread }: { thread: CommentThreadGroup }) {
  const { root, frame } = thread
  const resolved = threadState(thread) === 'resolved'
  /* a view link reads threads; it neither replies nor resolves */
  const canComment = useStore(canCommentOpenCanvas)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState(false)

  /* fly to the pin (its frame, or its point on the canvas) and pop it — the
     pin shows the whole conversation, this row is the index entry */
  const goToThread = () => {
    const s = useStore.getState()
    if (frame) {
      s.select(frame.id)
      s.requestFlyTo(frame.id)
    } else if (isCanvasComment(root)) {
      s.select(null)
      s.setActivePage(root.pageId)
      s.requestFlyToPoint(root.x, root.y)
    }
    if (!resolved) s.requestOpenThread(root.id)
  }

  async function reply() {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    setFailed(false)
    try {
      await api.replyComment(root.id, text)
      posthog.capture('element_comment_replied')
      setDraft((current) => (current === draft ? '' : current))
    } catch (err) {
      setFailed(true)
      reportLimit(err)
    } finally {
      setSending(false)
    }
  }

  function resolve() {
    api
      .resolveComment(root.id)
      .then(() => posthog.capture('element_comment_resolved'))
      .catch(reportLimit)
  }

  return (
    <div className="mx-1.5 py-1">
      <div
        role="button"
        tabIndex={0}
        title={frame ? `Go to “${frame.name}”` : 'Go to the pin on the canvas'}
        onClick={goToThread}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            goToThread()
          }
        }}
        className="grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-[2px] rounded-[8px] px-1.5 py-2 text-[12px] leading-[18px] hover:bg-sub focus-visible:bg-sub focus-visible:outline-none"
      >
        <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
          <span
            aria-hidden
            className="grid size-4 flex-none place-items-center rounded-full text-[8px] font-medium text-white"
            style={{ background: colorFor(root.from) }}
          >
            {root.from.slice(0, 1).toUpperCase()}
          </span>
          <b className="truncate font-medium text-ink">{root.from}</b>
        </span>
        <span className="text-[11px] text-ink-faint tabular-nums">{timeAgo(root.at)}</span>
        {/* open threads clamp (the pin shows the whole conversation); a
            resolved one has no pin to open, so it reads in full here */}
        <span className={cn('col-span-2 min-w-0 break-words pl-[22px] text-ink-soft', !resolved && 'line-clamp-3')}>
          {root.text}
        </span>
        {(frame || resolved) && (
          <span className="col-span-2 flex min-w-0 items-center gap-[7px] pl-[22px] text-[11px] text-ink-faint">
            {resolved && (
              <span className="grid size-3 flex-none place-items-center rounded-full bg-ink text-paper">
                <CheckIcon className="size-[8px]" strokeWidth={2.4} />
              </span>
            )}
            {frame && (
              <span className="min-w-0 truncate" title={frame.name}>
                {frame.name}
              </span>
            )}
            {resolved && root.resolvedBy && (
              <span className="min-w-0 truncate">
                {frame ? '· ' : ''}resolved by {root.resolvedBy}
              </span>
            )}
          </span>
        )}
      </div>
      {resolved && thread.replies.length > 0 && (
        <Disclosure
          label={`${thread.replies.length} ${thread.replies.length === 1 ? 'reply' : 'replies'}`}
          className="py-1 pr-1.5 pl-[28px] text-label text-ink-soft"
        >
          <ol className="space-y-3" aria-label="Resolved replies">
            {thread.replies.map((reply) => (
              <li key={reply.id}>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium text-ink">{reply.from}</span>
                  <span className="shrink-0 text-caption text-ink-faint">{timeAgo(reply.at)}</span>
                </div>
                <p className="whitespace-pre-wrap break-words">{reply.text}</p>
              </li>
            ))}
          </ol>
        </Disclosure>
      )}
      {!resolved && canComment && (
        <div className="flex items-center gap-1.5 py-1 pr-1.5 pl-[28px]">
          <Input
            variant="bare"
            inputSize="auto"
            className="h-7 min-w-0 flex-1 rounded-[7px] bg-surface px-2.5 shadow-ring focus:shadow-elevation-1-focus md:text-[12px]"
            placeholder="Reply… @doop to ask the agent"
            aria-label={`Reply to ${root.from}`}
            value={draft}
            disabled={sending}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !isComposingEnter(e)) void reply()
            }}
          />
          <Button
            variant="bare"
            className="h-7 flex-none gap-1 rounded-[7px] px-2 text-[12px] font-normal"
            title="Mark this thread as resolved"
            onClick={resolve}
          >
            <CheckIcon className="size-3.5" />
            Resolve
          </Button>
        </div>
      )}
      {failed && (
        <div className="pl-[28px] text-[11px] leading-[1.4] text-accent-ink">
          That reply did not go through — it may be resolved already. Try again.
        </div>
      )}
    </div>
  )
}
