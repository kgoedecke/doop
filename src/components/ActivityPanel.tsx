import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import type { AgentTask } from '../../shared/types'
import { useStore } from '../lib/store'
import { api } from '../lib/api'
import { timeAgo } from '../lib/time'
import { cn } from '@/lib/utils'
import { AgentIcon } from './AgentIcon'
import { MemoryPanel } from './MemoryPanel'
import {
  Panel,
  type PanelResize,
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
import { taskFrameId } from '../lib/taskFrame'
import { useOpenThreadCount } from '../lib/comments'

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
  surface?: 'floating' | 'inline'
  className?: string
  /** carries `right` while floating — the panel always hugs the right edge */
  style?: CSSProperties
  resize?: PanelResize
}) {
  const tab = useStore((s) => s.panelTab)
  const setTab = useStore((s) => s.setPanelTab)
  const [, tick] = useState(0)
  const openThreads = useOpenThreadCount()
  const working = useStore((s) => s.tasks.filter((t) => t.agentName && !t.endedAt && !t.failedAt).length)

  /* refresh relative timestamps and running durations */
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 5000)
    return () => window.clearInterval(t)
  }, [])

  return (
    <Panel
      surface={surface}
      resize={resize}
      className={cn(
        surface === 'floating' && 'top-2.5 bottom-3.5 w-[280px] transition-[right] duration-150',
        className,
      )}
      style={style}
    >
      <PanelTabsRoot value={tab} onValueChange={(next) => setTab(next as typeof tab)}>
        <PanelHeader className="pl-2">
          <PanelTabs aria-label="Agents panel">
            <PanelIconTab value="tasks" icon={<SparkIcon />} title="Agents">
              Agents
              {working > 0 && <em className="ml-[7px] text-[11px] font-normal not-italic text-ink-faint">{working}</em>}
            </PanelIconTab>
            <PanelIconTab
              value="comments"
              icon={<CommentIcon />}
              title={openThreads ? `Comments · ${openThreads} open` : 'Comments — every thread pinned on this page'}
              /* open threads on this page: a count on the tab itself */
              badge={
                openThreads > 0 && (
                  <span className="absolute -top-1 -right-1 grid h-[14px] min-w-[14px] place-items-center rounded-lg bg-brand px-[3px] font-mono text-[8px] font-medium text-white">
                    {openThreads > 99 ? '99+' : openThreads}
                  </span>
                )
              }
            >
              Comments
            </PanelIconTab>
            <PanelIconTab value="activity" icon={<PulseIcon />} title="Activity">
              Activity
            </PanelIconTab>
            <PanelIconTab
              value="memory"
              icon={<BookOpenIcon />}
              title="Design memory — references, rules and decisions every agent on this canvas designs with"
            >
              Memory
            </PanelIconTab>
          </PanelTabs>
          <PanelClose label="Close panel" onClick={onClose} />
        </PanelHeader>
        {/* the Agents tab is a column: what the agents are doing scrolls above,
            the prompt composer is docked underneath */}
        <PanelTabPanel value="tasks" className={tabEnter}>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
            <RecentTasks />
          </div>
          <PromptBar canvasId={canvasId} />
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

/** How many tasks the strip shows before "Show all". */
const RECENT_SHOWN = 3

/* The "Recent tasks" strip at the top of the Agents tab: what each agent is
   working on or just finished, and for whom. "Show all" opens the whole
   history in the same rows, split into what is running and what is done. */
function RecentTasks() {
  const tasks = useStore((s) => s.tasks)
  const [all, setAll] = useState(false)
  /* unclaimed board cards have no agent yet — they belong to the Board */
  const claimed = useMemo(() => tasks.filter((t) => t.agentName), [tasks])
  const working = useMemo(() => claimed.filter((t) => !t.endedAt && !t.failedAt), [claimed])
  const finished = useMemo(() => claimed.filter((t) => t.endedAt || t.failedAt), [claimed])

  return (
    <section aria-label="Recent tasks" className="flex flex-none flex-col pt-1.5 pb-1">
      <h3 className="flex h-7 flex-none items-center px-3 text-[11.5px] font-normal text-ink-faint">Recent tasks</h3>
      {claimed.length === 0 ? (
        <p className="px-3 pb-2 text-[12px] leading-[1.45] text-ink-faint">
          No tasks yet. Ask the Doop Agent below, or connect your own — what agents work on shows up here.
        </p>
      ) : all ? (
        <>
          {working.length > 0 && <TaskGroup label="Working on" tasks={working} />}
          {finished.length > 0 && <TaskGroup label="Worked on" tasks={finished} />}
        </>
      ) : (
        claimed.slice(0, RECENT_SHOWN).map((t) => <RecentTaskRow key={t.id} task={t} />)
      )}
      {claimed.length > RECENT_SHOWN && (
        <Button
          variant="bare"
          className="mx-1.5 mt-0.5 h-[26px] flex-none justify-start gap-1.5 self-start rounded-[7px] px-1.5 text-[11.5px] font-normal text-ink-soft"
          aria-expanded={all}
          onClick={() => setAll((v) => !v)}
        >
          {all ? 'Show less' : 'Show all'}
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
 *  Clicking it flies the camera to where the agent is (or was) working. */
function RecentTaskRow({ task }: { task: AgentTask }) {
  const canvasId = useStore((s) => s.canvas?.id)
  const frameId = useStore((s) => taskFrameId(task, s))
  const frameName = useStore((s) => s.canvas?.frames.find((f) => f.id === frameId)?.name)
  const goToFrame = () => {
    if (frameId) useStore.getState().requestFlyTo(frameId)
  }
  return (
    <div
      role={frameId ? 'button' : undefined}
      tabIndex={frameId ? 0 : undefined}
      title={frameName ? `Go to “${frameName}”` : undefined}
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
        {task.owner && <em className="truncate not-italic text-ink-faint">for {task.owner}</em>}
      </span>
      <span className="text-[11px] text-ink-faint tabular-nums">{taskTime(task)}</span>
      <span className="col-span-2 flex min-w-0 items-center gap-[7px] pl-[22px] text-ink-soft">
        <TaskMark task={task} />
        {/* one line, with the whole text on hover; a failure wraps, since
            its reason is the point */}
        <span
          title={task.status}
          className={cn(
            'min-w-0',
            task.failedAt ? 'whitespace-normal break-words text-accent-ink' : 'truncate',
            task.auto && 'italic',
          )}
        >
          {task.status}
        </span>
        {task.failedAt && task.queuedBy && canvasId && (
          <Button
            variant="danger-solid"
            size="pill"
            className="ml-auto"
            onClick={(e) => {
              e.stopPropagation()
              api.retryCard(canvasId, task.id).catch(reportLimit)
            }}
          >
            Retry
          </Button>
        )}
      </span>
    </div>
  )
}

/** Where a task stands, as one 12px glyph: the working matrix, a done check,
 *  or the failure mark. */
function TaskMark({ task }: { task: AgentTask }) {
  if (task.failedAt)
    return (
      <span className="grid size-3 flex-none place-items-center rounded-full bg-accent-ink text-[8px] font-bold text-white">
        !
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
  return (
    <PanelBody className="py-2">
      {activity.length === 0 && <div className={emptyNote}>No activity yet. Add a frame, or connect an agent.</div>}
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
