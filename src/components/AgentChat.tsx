import { useLayoutEffect, useMemo, useRef } from 'react'
import { useStore } from '../lib/store'
import { authClient } from '../lib/auth'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import { AgentIcon } from './AgentIcon'
import { DotMatrix } from './ui/dot-matrix'
import { Markdown } from './Markdown'
import { chatTurns, chatTurnsKey, type ChatTurn } from '../lib/agentChat'

/** How close to the bottom still counts as reading the latest answer. */
const STICK_PX = 48

/* The Agents tab's conversation: each prompt sent from the composer (or
   feedback left on one) and the agent's answer under it, oldest at the top,
   kept scrolled to the newest unless the reader has scrolled up. */
export function AgentChat({ className }: { className?: string }) {
  const tasks = useStore((s) => s.tasks)
  const feedback = useStore((s) => s.feedback)
  const { data: session } = authClient.useSession()
  const userId = session?.user.id
  const turns = useMemo(() => chatTurns(tasks, feedback, userId), [tasks, feedback, userId])
  const key = chatTurnsKey(turns)
  const scroller = useRef<HTMLDivElement>(null)
  const stuck = useRef(true)
  const t = useT()

  /* follow the conversation while the reader is at its end */
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stuck.current) el.scrollTop = el.scrollHeight
  }, [key])

  if (turns.length === 0) return null
  return (
    <section
      ref={scroller}
      aria-label={t('panels.chatLabel')}
      onScroll={(e) => {
        const el = e.currentTarget
        stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX
      }}
      className={cn('flex min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain px-3 py-3', className)}
    >
      {turns.map((turn) => (
        <ChatExchange key={turn.id} turn={turn} />
      ))}
    </section>
  )
}

function ChatExchange({ turn }: { turn: ChatTurn }) {
  const t = useT()
  return (
    <>
      <div className="flex max-w-[85%] flex-col items-end gap-1 self-end">
        {!turn.mine && <span className="text-caption text-ink-faint">{turn.from}</span>}
        <p className="rounded-card bg-sub px-2.5 py-1.5 text-body break-words whitespace-pre-line text-ink">
          {turn.text}
        </p>
      </div>
      {turn.state === 'queued' ? (
        <p className="text-caption text-ink-faint">{t('panels.chatQueued')}</p>
      ) : (
        <div className="flex flex-col gap-1 text-body text-ink-soft">
          <span className="flex items-center gap-1.5 font-medium text-ink">
            <AgentIcon name={turn.agentName} size={14} />
            {turn.agentName}
          </span>
          <AgentAnswer turn={turn} />
        </div>
      )}
    </>
  )
}

function AgentAnswer({ turn }: { turn: ChatTurn }) {
  const t = useT()
  /* a retry or the next stage of a pipeline keeps the last run's answer on
     the card until its own replaces it; while it runs, that one is stale */
  if (turn.state === 'working')
    return (
      <span className="flex items-center gap-2 text-ink-faint">
        <DotMatrix />
        {t('panels.chatWorking')}
      </span>
    )
  const failure = turn.state === 'failed' && (
    <p className="break-words text-accent-ink">{turn.failureReason ?? t('panels.activityTaskUnfinished')}</p>
  )
  if (turn.reply)
    return (
      <>
        <Markdown source={turn.reply} />
        {failure}
      </>
    )
  /* finished before answers were kept */
  return failure || <p className="text-ink-faint">{t('panels.chatDone')}</p>
}
