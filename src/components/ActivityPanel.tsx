import { useEffect, useMemo, useState } from 'react'
import type { AgentTask } from '../../shared/types'
import { useStore } from '../lib/store'
import { api } from '../lib/api'
import { timeAgo } from '../lib/time'
import { cn } from '@/lib/utils'
import { AgentIcon } from './AgentIcon'
import { MemoryPanel } from './MemoryPanel'
import { Panel, PanelBody, PanelHeader, PanelTab, PanelTabPanel, PanelTabs, PanelTabsRoot } from './ui/panel'
import { Button } from './ui/button'
import { Tooltip } from './ui/tooltip'
import { PanelCollapseRightIcon } from './ui/icons'
import { Input } from './ui/input'
import { Dot } from './ui/dot'
import { isResidentLimit } from './TeamAllowance'

const emptyNote = 'px-4 py-6 text-center text-[13px] text-ink-faint'

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
  onClose,
  surface = 'floating',
}: {
  onClose: () => void
  /* 'inline' when the panel is filling a mobile Sheet rather than floating */
  surface?: 'floating' | 'inline'
}) {
  const tab = useStore((s) => s.panelTab)
  const setTab = useStore((s) => s.setPanelTab)
  const [, tick] = useState(0)

  /* refresh relative timestamps and running durations */
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 5000)
    return () => window.clearInterval(t)
  }, [])

  return (
    <Panel surface={surface} className={cn(surface === 'floating' && 'inset-y-3 right-3 w-[300px]')}>
      <PanelTabsRoot value={tab} onValueChange={(next) => setTab(next as typeof tab)}>
        <PanelHeader>
          <PanelTabs>
            <PanelTab value="tasks">Agents</PanelTab>
            <PanelTab value="activity">Activity</PanelTab>
            <PanelTab
              value="memory"
              title="Design memory — references, rules and decisions every agent on this canvas designs with"
            >
              Memory
            </PanelTab>
          </PanelTabs>
          <Tooltip label="Collapse panel" side="bottom" align="end">
            <Button
              variant="bare"
              size="icon-sm"
              className="shrink-0 text-ink-faint hover:bg-paper-deep hover:text-ink"
              aria-label="Collapse panel"
              onClick={onClose}
            >
              <PanelCollapseRightIcon width={13} height={13} />
            </Button>
          </Tooltip>
        </PanelHeader>
        <PanelTabPanel value="tasks">
          <TaskList />
        </PanelTabPanel>
        <PanelTabPanel value="activity">
          <ActivityList />
        </PanelTabPanel>
        <PanelTabPanel value="memory">
          <MemoryPanel />
        </PanelTabPanel>
      </PanelTabsRoot>
    </Panel>
  )
}

/* Task history grouped by agent, à la Cursor's agent panel: the active task
   pulses at the top of each group, finished ones are checked off below. */
function TaskList() {
  const tasks = useStore((s) => s.tasks)

  const groups = useMemo(() => {
    const byAgent = new Map<string, AgentTask[]>()
    for (const t of tasks) {
      // Unclaimed board cards belong in the Board's Queued column. They have
      // no agent identity yet, so rendering them here creates a blank group.
      if (!t.agentName) continue
      const key = t.agentName
      const list = byAgent.get(key) ?? []
      list.push(t) // tasks arrive newest first, so groups stay newest first too
      byAgent.set(key, list)
    }
    /* agents ordered by their most recent task */
    return [...byAgent.entries()]
  }, [tasks])

  if (groups.length === 0) {
    return (
      <PanelBody className="py-2">
        <div className={emptyNote}>
          No tasks yet. Agents announce what they're working on here — the history sticks around after they finish.
        </div>
      </PanelBody>
    )
  }

  return (
    <PanelBody className="pt-1 pb-3">
      {groups.map(([key, list]) => (
        <TaskGroup key={key} list={list} />
      ))}
    </PanelBody>
  )
}

/* Long histories collapse to the latest few per agent — the panel is a
   "what's happening" surface, not an archive. */
const TASKS_SHOWN_INITIALLY = 5
const TASKS_SHOWN_STEP = 15

const agentTag =
  'ml-[7px] rounded-full border border-current px-[7px] py-px align-[1px] font-mono text-[9px] uppercase text-accent-ink'

function TaskGroup({ list }: { list: AgentTask[] }) {
  const [shown, setShown] = useState(TASKS_SHOWN_INITIALLY)
  const hidden = list.length - shown
  const latest = list[0]
  if (!latest) return null

  return (
    <div className="border-t border-line-soft pt-2.5 pb-0.5 first:border-t-0">
      <div className="flex items-center gap-2 px-4 pt-1 pb-1.5 text-[12.5px] font-bold">
        <Dot shape="square" style={{ background: latest.color }} />
        <span>
          <AgentIcon name={latest.agentName} /> {latest.agentName}
          {latest.owner && <span className="ml-1.5 text-[11px] font-medium text-ink-faint">for {latest.owner}</span>}
          {latest.failedAt ? (
            <span className={cn(agentTag, 'font-semibold tracking-[0.08em]')}>needs retry</span>
          ) : !latest.endedAt ? (
            <span className={cn(agentTag, 'font-medium tracking-[0.1em]')}>working</span>
          ) : null}
        </span>
      </div>
      {list.slice(0, shown).map((t) => (
        <TaskRow key={t.id} task={t} />
      ))}
      {hidden > 0 && (
        <Button
          variant="link"
          size="sm"
          className="mx-4 mt-0.5 mb-2 px-0 py-0.5 text-[11.5px] text-ink-faint hover:text-ink"
          onClick={() => setShown((n) => n + TASKS_SHOWN_STEP)}
        >
          Show {Math.min(hidden, TASKS_SHOWN_STEP)} more ({hidden} older)
        </Button>
      )}
    </div>
  )
}

/* One task, with its human-feedback thread and a reply box. Feedback is
   delivered to the agent inside its next MCP tool result; the entry flips
   from "sending to agent…" to "seen" once that delivery happens. */
function TaskRow({ task }: { task: AgentTask }) {
  const canvasId = useStore((s) => s.canvas?.id)
  const feedback = useStore((s) => s.feedback.filter((f) => f.taskId === task.id))
  const [replying, setReplying] = useState(false)
  const [draft, setDraft] = useState('')

  async function submit() {
    const text = draft.trim()
    if (!text) return setReplying(false)
    setDraft('')
    setReplying(false)
    try {
      await api.sendTaskFeedback(task.id, text)
    } catch (e) {
      reportLimit(e)
    }
  }

  const state = task.endedAt ? 'done' : task.failedAt ? 'failed' : 'active'

  return (
    <div className="group">
      <div className="flex animate-[chip-in_0.25s_ease] items-baseline gap-2 py-[5px] pr-4 pl-5 text-[12.5px] leading-[1.4]">
        {task.failedAt ? (
          <span className="grid size-[15px] flex-none place-items-center self-center rounded-full bg-accent-ink text-[10px] font-extrabold text-white">
            !
          </span>
        ) : task.endedAt ? (
          <span className="flex-none text-[11px] text-ink-faint">✓</span>
        ) : (
          <Dot
            size="sm"
            className="animate-[status-pulse_1.6s_ease-in-out_infinite] self-center"
            style={{ background: task.color }}
          />
        )}
        <span
          className={cn(
            'min-w-0 flex-1',
            state === 'active' && 'font-semibold',
            state === 'done' && 'text-ink-soft',
            state === 'failed' && 'font-[650] text-accent-ink',
            /* server-inferred tasks (agent never announced) read as provisional */
            task.auto && 'italic text-ink-soft',
          )}
        >
          {task.status}
        </span>
        <span className="flex-none font-mono text-[10.5px] text-ink-faint">
          {task.failedAt
            ? timeAgo(task.failedAt)
            : task.endedAt
              ? `${duration(task)} · ${timeAgo(task.endedAt)}`
              : duration(task)}
        </span>
        {task.failedAt && task.queuedBy && canvasId ? (
          <Button
            variant="danger-solid"
            size="pill"
            onClick={() => api.retryCard(canvasId, task.id).catch(reportLimit)}
          >
            ↻ Retry
          </Button>
        ) : null}
        {!replying && (
          <Button
            variant="bare"
            size="sm"
            className="flex-none px-1 py-0 text-xs opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            title="Give the agent feedback on this task"
            onClick={() => setReplying(true)}
          >
            ↩
          </Button>
        )}
      </div>
      {feedback
        .slice()
        .reverse()
        .map((f) => (
          <div
            key={f.id}
            className="mt-px mr-4 mb-1 ml-[34px] animate-[chip-in_0.2s_ease] rounded-[8px] bg-paper-deep px-[9px] py-[5px] text-[12px] leading-[1.4]"
          >
            <span className="font-bold">{f.from}:</span> <span className="text-ink-soft">{f.text}</span>
            {f.failedAt ? (
              <span className="mt-[5px] flex items-center justify-between gap-2 text-[10.5px] text-accent-ink">
                {f.failureReason ?? 'The agent did not finish.'}
                <Button
                  variant="danger-solid"
                  size="pill"
                  onClick={() => api.retryTaskFeedback(f.id).catch(reportLimit)}
                >
                  ↻ Retry
                </Button>
              </span>
            ) : (
              <span
                className={cn(
                  'mt-0.5 block font-mono text-[9.5px] tracking-[0.06em]',
                  f.deliveredAt ? 'text-ink-faint' : 'text-accent-ink',
                )}
              >
                {f.completedAt
                  ? `✓ handled by ${f.claimedBy ?? 'an agent'}`
                  : f.deliveredAt
                    ? `↗ picked up by ${f.claimedBy ?? 'an agent'}`
                    : '→ waiting for an agent…'}
              </span>
            )}
          </div>
        ))}
      {replying && (
        <div className="mt-0.5 mr-4 mb-1.5 ml-[34px]">
          <Input
            inputSize="sm"
            className="rounded-lg px-[9px] focus:border-ink-soft focus:ring-0 md:text-xs"
            autoFocus
            placeholder="Feedback — any agent will pick this up…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
              if (e.key === 'Escape') setReplying(false)
            }}
            onBlur={() => (draft.trim() ? submit() : setReplying(false))}
          />
        </div>
      )}
    </div>
  )
}

function ActivityList() {
  const activity = useStore((s) => s.activity)
  return (
    <PanelBody className="py-2">
      {activity.length === 0 && <div className={emptyNote}>No activity yet. Add a frame, or connect an agent.</div>}
      {activity.map((a) => (
        <div
          key={a.id}
          className="flex animate-[chip-in_0.25s_ease] gap-2.5 px-4 py-[9px] text-[12.5px] leading-[1.45]"
        >
          <Dot className="mt-[5px]" style={{ background: a.actorColor }} />
          <div>
            <div>
              <span className="font-bold">
                {a.actorName}
                <span className="ml-[5px] font-mono text-[9.5px] font-medium uppercase tracking-[0.08em] text-ink-faint">
                  {a.actorKind}
                </span>
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
