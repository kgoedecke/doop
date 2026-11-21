import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { AgentTask } from '../../shared/types'
import { canEditOpenCanvas, useStore } from '../lib/store'
import { api } from '../lib/api'
import { timeAgo } from '../lib/time'
import { cn } from '@/lib/utils'
import { AgentIcon } from './AgentIcon'
import { MemoryPanel } from './MemoryPanel'
import {
  Panel,
  type PanelResize,
  type PanelSurface,
  PanelBody,
  PanelClose,
  PanelHeader,
  PanelIconTab,
  PanelTabPanel,
  PanelTabs,
  PanelTabsRoot,
} from './ui/panel'
import { Button } from './ui/button'
import { BookOpenIcon, CheckIcon, ChevronDownIcon, CommentIcon, PulseIcon, SparkIcon } from './ui/icons'
import { DotMatrix } from './ui/dot-matrix'
import { Dot } from './ui/dot'
import { isResidentLimit } from './TeamAllowance'
import { CommentsPanel } from './CommentsPanel'
import { PromptBar } from './PromptBar'
import { AgentChat } from './AgentChat'
import { isChatCard } from '../lib/agentChat'
import { clampRecentHeight, MIN_CHAT_PX, MIN_RECENT_PX, readRecentHeight, writeRecentHeight } from '../lib/agentsSplit'
import { taskFrameId } from '../lib/taskFrame'
import { useOpenThreadCount } from '../lib/comments'
import { useT } from '@/lib/i18n'

const emptyNote = 'px-4 py-6 text-center text-[12px] text-ink-faint'

/* Radix mounts a tab's content on switch, so this plays once per switch */
const tabEnter =
  'data-[state=active]:animate-in data-[state=active]:fade-in-0 data-[state=active]:slide-in-from-right-1 data-[state=active]:duration-200 motion-reduce:animate-none'

/* feedback and retries are metered like any other resident task — a 403
   here means the free tier ran out, so raise the connect wall */
function reportLimit(err: unknown) {
  if (isResidentLimit(err)) useStore.getState().setLimitWall(true)
  else console.error(err)
}

function duration(t: AgentTask): string {
  const end = t.endedAt ?? Date.now()
  const s = Math.max(1, Math.round((end - t.startedAt) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60 ? `${s % 60}s` : ''}`.trim()
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export function ActivityPanel({
  canvasId,
  onClose,
  surface = 'floating',
  className,
  style,
  resize,
}: {
  canvasId: string
  onClose: () => void
  /* 'inline' when the panel is filling a mobile Sheet rather than floating */
  surface?: PanelSurface
  className?: string
  /** carries `right` while floating — the panel always hugs the right edge */
  style?: CSSProperties
  resize?: PanelResize
}) {
  const setTab = useStore((s) => s.setPanelTab)
  const canEdit = useStore(canEditOpenCanvas)
  /* someone who cannot edit sees the comments only (PanelTabButtons) */
  const tab = useStore((s) => (canEdit ? s.panelTab : 'comments'))
  const [, tick] = useState(0)
  const openThreads = useOpenThreadCount()
  const working = useStore((s) => s.tasks.filter((t) => t.agentName && !t.endedAt && !t.failedAt).length)
  const hasChat = useStore((s) => s.tasks.some(isChatCard))
  const t = useT()

  /* refresh relative timestamps and running durations */
  useEffect(() => {
    const timer = window.setInterval(() => tick((n) => n + 1), 5000)
    return () => window.clearInterval(timer)
  }, [])

  return (
    <Panel
      surface={surface}
      resize={resize}
      className={cn(
        surface === 'floating' && 'top-2.5 bottom-3.5 w-[280px] transition-[right] duration-150',
        surface === 'docked' && 'w-[280px] border-l',
        className,
      )}
      style={style}
    >
      <PanelTabsRoot value={tab} onValueChange={(next) => setTab(next as typeof tab)}>
        <PanelHeader className="pl-2">
          <PanelTabs aria-label={t('panels.activityPanelAria')}>
            {canEdit && (
              <PanelIconTab value="tasks" icon={<SparkIcon />} title={t('panels.activityAgents')}>
                {t('panels.activityAgents')}
                {working > 0 && (
                  <em className="ml-[7px] text-[11px] font-normal not-italic text-ink-faint">{working}</em>
                )}
              </PanelIconTab>
            )}
            <PanelIconTab
              value="comments"
              icon={<CommentIcon />}
              title={
                openThreads
                  ? t('panels.activityCommentsOpen', { count: openThreads })
                  : t('panels.activityCommentsTitle')
              }
              /* open threads on this page: a count on the tab itself */
              badge={
                openThreads > 0 && (
                  <span className="absolute -top-1 -right-1 grid h-[14px] min-w-[14px] place-items-center rounded-lg bg-brand px-[3px] font-mono text-[8px] font-medium text-white">
                    {openThreads > 99 ? '99+' : openThreads}
                  </span>
                )
              }
            >
              {t('panels.activityComments')}
            </PanelIconTab>
            {canEdit && (
              <>
                <PanelIconTab value="activity" icon={<PulseIcon />} title={t('panels.activityActivity')}>
                  {t('panels.activityActivity')}
                </PanelIconTab>
                <PanelIconTab value="memory" icon={<BookOpenIcon />} title={t('panels.activityMemoryTitle')}>
                  {t('panels.activityMemory')}
                </PanelIconTab>
              </>
            )}
          </PanelTabs>
          <PanelClose label={t('panels.activityClosePanel')} onClick={onClose} />
        </PanelHeader>
        {/* the Agents tab is a column: what the agents are doing on top, the
            conversation with them under it, the prompt composer docked below */}
        <PanelTabPanel value="tasks" className={tabEnter}>
          {hasChat ? (
            <AgentsSplit />
          ) : (
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
              <RecentTasks />
            </div>
          )}
          {/* the composer briefs agents to change frames: editors only */}
          {canEdit && <PromptBar canvasId={canvasId} />}
        </PanelTabPanel>
        <PanelTabPanel value="comments" className={tabEnter}>
          <CommentsPanel />
        </PanelTabPanel>
        <PanelTabPanel value="activity" className={tabEnter}>
          <ActivityList />
        </PanelTabPanel>
        <PanelTabPanel value="memory" className={tabEnter}>
          <MemoryPanel />
        </PanelTabPanel>
      </PanelTabsRoot>
    </Panel>
  )
}

/** How far one arrow key moves the line between Recent tasks and the chat. */
const SPLIT_STEP_PX = 16

/* Recent tasks over the chat, with a line between them to drag: up gives the
   chat more room, down gives it to the tasks. Until someone drags it, Recent
   tasks takes what it needs up to 45%; a double-click goes back to that. */
function AgentsSplit() {
  const column = useRef<HTMLDivElement>(null)
  const recent = useRef<HTMLDivElement>(null)
  /* where the line started, and where the latest move put it: a release can
     land before React renders that move, so it saves this, not the state */
  const drag = useRef<{ y: number; height: number; placed?: number } | null>(null)
  const [height, setHeight] = useState<number | null>(readRecentHeight)
  /* the rendered sizes, for the separator's value and range: the line also
     moves when the panel or Recent tasks changes height, not only on a drag */
  const [sizes, setSizes] = useState({ recent: 0, column: 0 })
  const t = useT()

  useEffect(() => {
    const col = column.current
    const top = recent.current
    if (!col || !top) return
    const measure = () => setSizes({ recent: top.offsetHeight, column: col.clientHeight })
    const observer = new ResizeObserver(measure)
    observer.observe(col)
    observer.observe(top)
    return () => observer.disconnect()
  }, [])

  const place = (next: number) => {
    const placed = clampRecentHeight(next, column.current?.clientHeight ?? 0)
    setHeight(placed)
    if (drag.current) drag.current.placed = placed
    return placed
  }
  const endDrag = () => {
    if (drag.current?.placed !== undefined) writeRecentHeight(drag.current.placed)
    drag.current = null
  }

  return (
    <div ref={column} className="flex min-h-0 flex-1 flex-col">
      <div
        ref={recent}
        className={cn(
          'flex min-h-0 flex-none flex-col overflow-y-auto overscroll-contain',
          height === null && 'max-h-[45%]',
        )}
        style={height === null ? undefined : { height, maxHeight: `calc(100% - ${MIN_CHAT_PX}px)` }}
      >
        <RecentTasks />
      </div>
      <div
        role="separator"
        tabIndex={0}
        aria-label={t('panels.chatResize')}
        title={t('panels.chatResize')}
        aria-orientation="horizontal"
        aria-valuemin={MIN_RECENT_PX}
        aria-valuemax={Math.max(MIN_RECENT_PX, sizes.column - MIN_CHAT_PX)}
        aria-valuenow={sizes.recent}
        className="group relative z-[1] -my-[3px] flex h-[7px] flex-none touch-none cursor-row-resize items-center focus-visible:outline-none"
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.preventDefault()
          drag.current = { y: e.clientY, height: recent.current?.offsetHeight ?? 0 }
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          if (drag.current) place(drag.current.height + e.clientY - drag.current.y)
        }}
        onPointerUp={(e) => {
          endDrag()
          if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
        }}
        onLostPointerCapture={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => {
          setHeight(null)
          writeRecentHeight(null)
        }}
        onKeyDown={(e) => {
          const current = height ?? recent.current?.offsetHeight ?? 0
          let next: number
          if (e.key === 'ArrowUp') next = current - SPLIT_STEP_PX
          else if (e.key === 'ArrowDown') next = current + SPLIT_STEP_PX
          else if (e.key === 'Home') next = MIN_RECENT_PX
          else if (e.key === 'End') next = Number.MAX_SAFE_INTEGER
          else return
          e.preventDefault()
          writeRecentHeight(place(next))
        }}
      >
        {/* the hairline, which thickens while hovered, dragged or focused */}
        <span className="h-px w-full bg-line-soft transition-[height,background-color] group-hover:h-[3px] group-hover:bg-line group-focus-visible:h-[3px] group-focus-visible:bg-brand group-active:h-[3px] group-active:bg-brand" />
      </div>
      <AgentChat className="flex-1" />
    </div>
  )
}

/** How many tasks the strip shows before "Show all". */
const RECENT_SHOWN = 3

/* The "Recent tasks" strip at the top of the Agents tab: what each agent is
   working on or just finished, and for whom. "Show all" opens the whole
   history in the same rows, split into what is running and what is done. */
function RecentTasks() {
  const tasks = useStore((s) => s.tasks)
  const [all, setAll] = useState(false)
  /* unclaimed board cards have no agent yet, so they are not activity */
  const claimed = useMemo(() => tasks.filter((t) => t.agentName), [tasks])
  const working = useMemo(() => claimed.filter((t) => !t.endedAt && !t.failedAt), [claimed])
  const finished = useMemo(() => claimed.filter((t) => t.endedAt || t.failedAt), [claimed])
  const t = useT()

  return (
    <section aria-label={t('panels.activityRecentTasks')} className="flex flex-none flex-col pt-1.5 pb-1">
      <h3 className="flex h-7 flex-none items-center px-3 text-[11.5px] font-normal text-ink-faint">
        {t('panels.activityRecentTasks')}
      </h3>
      {claimed.length === 0 ? (
        <p className="px-3 pb-2 text-[12px] leading-[1.45] text-ink-faint">{t('panels.activityNoTasks')}</p>
      ) : all ? (
        <>
          {working.length > 0 && <TaskGroup label={t('panels.activityWorkingOn')} tasks={working} />}
          {finished.length > 0 && <TaskGroup label={t('panels.activityWorkedOn')} tasks={finished} />}
        </>
      ) : (
        claimed.slice(0, RECENT_SHOWN).map((task) => <RecentTaskRow key={task.id} task={task} />)
      )}
      {claimed.length > RECENT_SHOWN && (
        <Button
          variant="bare"
          className="mx-1.5 mt-0.5 h-[26px] flex-none justify-start gap-1.5 self-start rounded-[7px] px-1.5 text-[11.5px] font-normal text-ink-soft"
          aria-expanded={all}
          onClick={() => setAll((v) => !v)}
        >
          {all ? t('panels.activityShowLess') : t('panels.activityShowAll')}
          <ChevronDownIcon className={cn('size-3 text-ink-faint transition-transform', all && 'rotate-180')} />
        </Button>
      )}
    </section>
  )
}

/** A labelled run of rows in the expanded list. */
function TaskGroup({ label, tasks }: { label: string; tasks: AgentTask[] }) {
  return (
    <>
      <h4 className="flex h-6 flex-none items-center px-3 pt-1 text-[11px] font-normal text-ink-faint">{label}</h4>
      {tasks.map((t) => (
        <RecentTaskRow key={t.id} task={t} />
      ))}
    </>
  )
}

/** The one figure a row shows at its right end: how far a job has got, how
 *  long a running task has been at it, or how long ago a finished one ended. */
function taskTime(task: AgentTask): string {
  if (task.failedAt) return timeAgo(task.failedAt)
  if (task.endedAt) return timeAgo(task.endedAt)
  return duration(task)
}

/** One task: who, for whom, one time figure; then its mark and what it is doing.
 *  Clicking it selects the frame where the agent is (or was) working and flies
 *  the camera there, so the click shows even when the frame is already in view. */
function RecentTaskRow({ task }: { task: AgentTask }) {
  const canvasId = useStore((s) => s.canvas?.id)
  const canEdit = useStore(canEditOpenCanvas)
  const frameId = useStore((s) => taskFrameId(task, s))
  const frameName = useStore((s) => s.canvas?.frames.find((f) => f.id === frameId)?.name)
  const goToFrame = () => {
    if (!frameId) return
    const s = useStore.getState()
    s.select(frameId)
    s.requestFlyTo(frameId)
  }
  const t = useT()
  const running = !task.endedAt && !task.failedAt
  const failed = !!task.failedAt
  const reason = task.failureReason ?? t('panels.activityTaskUnfinished')
  /* a job's status already is its reason; a card's status is its brief */
  const separateReason = failed && reason !== task.status
  return (
    <div
      role={frameId ? 'button' : undefined}
      tabIndex={frameId ? 0 : undefined}
      title={frameName ? t('panels.activityGoTo', { name: frameName }) : undefined}
      onClick={goToFrame}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          goToFrame()
        }
      }}
      className={cn(
        'mx-1.5 grid animate-[chip-in_0.25s_ease] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-[2px] rounded-[8px] px-1.5 py-2 text-[12px] leading-[18px]',
        frameId && 'cursor-pointer hover:bg-sub focus-visible:bg-sub focus-visible:outline-none',
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
        <span className="grid size-4 flex-none place-items-center">
          <AgentIcon name={task.agentName} size={14} />
        </span>
        <b className="truncate font-medium text-ink">{task.agentName}</b>
        {task.owner && (
          <em className="truncate not-italic text-ink-faint">{t('panels.activityFor', { name: task.owner })}</em>
        )}
      </span>
      <span className="text-[11px] text-ink-faint tabular-nums">{taskTime(task)}</span>
      <span className="col-span-2 flex min-w-0 items-center gap-[7px] pl-[22px] text-ink-soft">
        <TaskMark task={task} />
        {/* one line, with the whole text on hover: a card's status is its
            whole brief, which must never crowd out why it failed */}
        <span
          title={task.status}
          className={cn('min-w-0 truncate', failed && !separateReason && 'text-accent-ink', task.auto && 'italic')}
        >
          {task.status}
        </span>
        {running && task.queuedBy && canvasId && canEdit && (
          <Button
            variant="ghost"
            size="pill"
            className="ml-auto flex-none"
            title={t('panels.activityStopTitle')}
            onClick={(e) => {
              e.stopPropagation()
              api.stopCard(canvasId, task.id).catch(console.error)
            }}
          >
            {t('panels.activityStop')}
          </Button>
        )}
      </span>
      {failed && (
        <span className="col-span-2 flex min-w-0 items-start gap-2 pl-[22px]">
          {separateReason && (
            <span title={reason} className="line-clamp-3 min-w-0 break-words text-accent-ink">
              {reason}
            </span>
          )}
          {task.queuedBy && canvasId && canEdit && (
            <Button
              variant="danger-solid"
              size="pill"
              className="ml-auto flex-none"
              onClick={(e) => {
                e.stopPropagation()
                api.retryCard(canvasId, task.id).catch(reportLimit)
              }}
            >
              {t('panels.activityRetry')}
            </Button>
          )}
        </span>
      )}
    </div>
  )
}

/** Where a task stands, as one 12px glyph: the working matrix, a done check,
 *  or the failure mark. */
function TaskMark({ task }: { task: AgentTask }) {
  if (task.failedAt)
    return (
      <span className="flex size-3 flex-none flex-col items-center justify-center gap-[1px] rounded-full bg-accent-ink">
        {/* drawn, not typed: a text "!" sits on the font's baseline, off centre */}
        <span className="h-[4px] w-[1.5px] rounded-full bg-white" />
        <span className="size-[1.5px] rounded-full bg-white" />
      </span>
    )
  if (task.endedAt)
    return (
      <span className="grid size-3 flex-none place-items-center rounded-full bg-ink text-paper">
        <CheckIcon className="size-[8px]" strokeWidth={2.4} />
      </span>
    )
  return <DotMatrix />
}

function ActivityList() {
  const activity = useStore((s) => s.activity)
  const t = useT()
  return (
    <PanelBody className="py-2">
      {activity.length === 0 && <div className={emptyNote}>{t('panels.activityEmpty')}</div>}
      {activity.map((a) => (
        <div key={a.id} className="flex animate-[chip-in_0.25s_ease] gap-2.5 px-3.5 py-2 text-[12px] leading-[1.45]">
          <Dot className="mt-[5px]" style={{ background: a.actorColor }} />
          <div className="min-w-0">
            <div>
              <span className="font-medium">
                {a.actorName}
                <span className="ml-[5px] text-[11px] font-normal text-ink-faint">{a.actorKind}</span>
              </span>{' '}
              <span className="text-ink-soft">{a.message}</span>
            </div>
            <div className="mt-0.5 text-[11px] text-ink-faint">{timeAgo(a.at)}</div>
          </div>
        </div>
      ))}
    </PanelBody>
  )
}
