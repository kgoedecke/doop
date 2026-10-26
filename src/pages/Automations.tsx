import { useEffect, useState } from 'react'
import type { CanvasMeta } from '../../shared/types'
import { roleById } from '../../shared/agents'
import {
  AUTOMATION_EXAMPLES,
  describeSchedule,
  incompleteReason,
  type Automation,
  type AutomationExample,
  type Step,
} from '../../shared/automations'
import { api } from '../lib/api'
import { navigate } from '../App'
import { posthog } from '../lib/posthog'
import { AppRail, railLayout } from '../components/AppRail'
import { ClockTile, MetaTile, PullMark, RunDot, StepChain, formatRunTime } from '../components/AutomateShell'
import { FrameThumb } from '../components/FramePreview'
import { RoleMark } from '../components/RoleMark'
import { Button } from '../components/ui/button'
import { EmptyState } from '../components/ui/empty-state'
import { IconButton } from '../components/ui/icon-button'
import { GridIcon, PlusIcon } from '../components/ui/icons'
import { Pressable } from '../components/ui/pressable'
import { Skeleton } from '../components/ui/skeleton'
import { Switch } from '../components/ui/switch'
import { Toast } from '../components/ui/toast'
import { ConfirmDialog } from '../components/ui/alert-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu'
import { MoreHorizontalIcon, TrashIcon } from '../components/ui/icons'
import { DashContent, DashHeader, DashLayout, DashMain, DashTitle } from '../components/ui/dash'
import { cn } from '@/lib/utils'

/** The browser's zone — what "Monday 09:00" means to the person setting it up. */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** "every Monday 09:00" — the schedule as the list rows say it */
function everyLine(a: Automation): string {
  if (a.trigger.type === 'approval') return 'when designs are approved'
  return describeSchedule(a.schedule)
    .replace(/^Every /, 'every ')
    .replace(' at ', ' ')
}

/**
 * Automations overview. Every automation the user owns as one row — on/off,
 * what it does, where, when it last ran and when it runs next. With nothing
 * set up yet the page leads with examples, since a blank list says nothing
 * about what the feature is for.
 */
export function Automations() {
  const [items, setItems] = useState<Automation[] | null>(null)
  const [canvases, setCanvases] = useState<CanvasMeta[]>([])
  const [busy, setBusy] = useState(false)
  const [remove, setRemove] = useState<Automation | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    api.listAutomations().then(setItems).catch(console.error)
    api.listCanvases().then(setCanvases).catch(console.error)
  }, [])

  function showToast(message: string) {
    setToast(message)
    window.setTimeout(() => setToast(null), 2400)
  }

  async function create(example?: AutomationExample) {
    if (busy) return
    setBusy(true)
    try {
      const tz = localTimeZone()
      const created = example
        ? await api.createAutomation({
            name: example.name,
            trigger: example.trigger === 'approval' ? { type: 'approval', canvasId: '' } : { type: 'schedule' },
            schedule: { ...example.schedule, tz },
            steps: example.steps.map((s, i) => ({ ...s, id: `s${i + 1}`, canvasId: '' }) as Step),
          })
        : await api.createAutomation({
            name: 'Untitled automation',
            schedule: { kind: 'weekly', weekday: 1, hour: 9, minute: 0, tz },
            steps: [],
          })
      posthog.capture('automation_created', { example: example?.id ?? null })
      navigate(`/automations/${created.id}`)
    } catch (error) {
      console.error(error)
      showToast('Couldn’t create the automation')
    } finally {
      setBusy(false)
    }
  }

  async function toggle(a: Automation, enabled: boolean) {
    setItems((list) => list?.map((x) => (x.id === a.id ? { ...x, enabled } : x)) ?? null)
    try {
      const saved = await api.updateAutomation(a.id, { enabled })
      setItems((list) => list?.map((x) => (x.id === a.id ? saved : x)) ?? null)
    } catch (error) {
      console.error(error)
      setItems((list) => list?.map((x) => (x.id === a.id ? a : x)) ?? null)
      showToast('Couldn’t save')
    }
  }

  async function destroy(a: Automation) {
    try {
      await api.deleteAutomation(a.id)
      posthog.capture('automation_deleted')
      setItems((list) => list?.filter((x) => x.id !== a.id) ?? null)
    } catch (error) {
      console.error(error)
      showToast('Couldn’t delete')
    }
  }

  const canvasById = (id: string) => canvases.find((c) => c.id === id)
  const empty = items !== null && items.length === 0

  return (
    <DashLayout className={railLayout}>
      <AppRail active="automations" canvases={canvases} />
      <DashMain className="[background:var(--paper)]">
        <DashHeader variant="bare">
          <span className="flex-1" />
          <Button variant="primary" size="bar" disabled={busy} onClick={() => create()}>
            <PlusIcon width={15} height={15} strokeWidth={1.75} /> New automation
          </Button>
        </DashHeader>

        <DashContent className="pt-2 md:pt-3">
          <DashTitle className="mb-5">Automations</DashTitle>

          {items === null ? (
            <div className="flex flex-col gap-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} index={i} shape="row" />
              ))}
            </div>
          ) : empty ? (
            <>
              <EmptyState
                variant="dashed"
                illustration={
                  <>
                    <ClockTile size={36} />
                    <span className="h-px w-[22px] bg-ink-ghost" aria-hidden />
                    <MetaTile size={36} className="border border-line bg-surface" />
                    <span className="h-px w-[22px] bg-ink-ghost" aria-hidden />
                    <span className="grid size-9 place-items-center rounded-pill border border-line bg-surface text-ink">
                      <GridIcon />
                    </span>
                  </>
                }
                title="Nothing runs on its own yet"
                description="Run on a schedule or when designs are approved. Create variants, hand off tickets and share updates."
                action={
                  <Button variant="primary" disabled={busy} onClick={() => create()}>
                    + New automation
                  </Button>
                }
              />
              <Examples onUse={create} busy={busy} />
            </>
          ) : (
            <div className="overflow-hidden rounded-panel border border-line bg-surface shadow-card">
              <div className="hidden grid-cols-[52px_minmax(0,1.7fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)_36px] items-center gap-3 border-b border-line-soft px-4 py-2.5 text-caption text-ink-faint md:grid">
                <span />
                <span>Automation</span>
                <span>Canvas</span>
                <span>Last run</span>
                <span>Next run</span>
                <span />
              </div>
              {items.map((a) => {
                const first = a.steps[0]
                const canvasIds = [...new Set(a.steps.map((s) => s.canvasId).filter(Boolean))]
                const canvas = canvasIds[0] ? canvasById(canvasIds[0]) : undefined
                return (
                  <div
                    key={a.id}
                    className="grid cursor-pointer grid-cols-[52px_minmax(0,1fr)_36px] items-center gap-3 border-b border-line-soft px-4 py-3 transition-colors last:border-b-0 hover:bg-paper md:grid-cols-[52px_minmax(0,1.7fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)_36px]"
                    onClick={() => navigate(`/automations/${a.id}`)}
                  >
                    {/* a click anywhere on the row opens the automation, and its name is
                        the keyboard's way in; flipping the switch must not open it */}
                    <Switch
                      checked={a.enabled}
                      onCheckedChange={(on) => toggle(a, on)}
                      aria-label={`${a.name} on or off`}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    />
                    <div className="flex min-w-0 items-center gap-2.5">
                      {first?.type === 'pull' ? (
                        <MetaTile size={24} className="border border-line bg-surface" />
                      ) : first?.type === 'slack' || first?.type === 'linear' ? (
                        <PullMark provider={first.type} size={24} />
                      ) : first?.type === 'agent' ? (
                        <span className="grid size-6 flex-none place-items-center rounded-row border border-line bg-surface">
                          <RoleMark role={roleById(first.roles[0])} size={14} />
                        </span>
                      ) : (
                        <ClockTile size={24} />
                      )}
                      <span className="min-w-0 truncate text-copy text-ink-soft">
                        <Pressable
                          layout="inline"
                          focus="ring"
                          className="inline font-medium text-ink"
                          onClick={(e) => {
                            e.stopPropagation()
                            navigate(`/automations/${a.id}`)
                          }}
                        >
                          {a.name}
                        </Pressable>
                        {first?.type === 'agent' && first.roles.length === 1 && <> · @{first.roles[0]}</>} ·{' '}
                        {everyLine(a)}
                      </span>
                    </div>
                    <span className="hidden min-w-0 items-center gap-2.5 text-body text-ink-soft md:flex">
                      {canvasIds.length ? (
                        <>
                          <FrameThumb size="xs" frameId={canvas?.previewFrameId} />
                          <span className="truncate">
                            {canvas?.name ?? 'Canvas'}
                            {canvasIds.length > 1 ? ` +${canvasIds.length - 1}` : ''}
                          </span>
                        </>
                      ) : (
                        <em className="not-italic text-ink-faint">Pick a canvas</em>
                      )}
                    </span>
                    <span className="hidden min-w-0 items-center gap-2 text-body text-ink-soft md:flex">
                      {a.lastRun ? (
                        <>
                          <RunDot status={a.lastRun.status} />
                          <span className="truncate">
                            {a.lastRun.status === 'running'
                              ? 'Running'
                              : a.lastRun.status === 'failed'
                                ? 'Failed'
                                : formatRunTime(a.lastRun.startedAt)}
                            {a.lastRun.status === 'ok' && a.lastRun.summary ? ` · ${a.lastRun.summary}` : ''}
                          </span>
                          {a.lastRun.status === 'failed' && (
                            <b
                              className="font-semibold text-accent-ink"
                              onClick={(e) => {
                                e.stopPropagation()
                                navigate(a.lastRun?.failure === 'reconnect' ? '/integrations' : `/automations/${a.id}`)
                              }}
                            >
                              {a.lastRun.failure === 'reconnect' ? 'Reconnect' : 'Fix'}
                            </b>
                          )}
                        </>
                      ) : (
                        <span className="text-ink-faint">Never</span>
                      )}
                    </span>
                    <span
                      className={cn('hidden text-caption md:block', a.nextRunAt ? 'text-ink-soft' : 'text-ink-faint')}
                    >
                      {a.nextRunAt
                        ? formatRunTime(a.nextRunAt)
                        : !a.enabled
                          ? 'paused'
                          : a.trigger.type === 'approval' && !incompleteReason(a.steps, a.trigger)
                            ? 'on approval'
                            : 'finish setup'}
                    </span>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <IconButton
                          aria-label={`Actions for ${a.name}`}
                          shape="round"
                          className="text-ink-faint"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MoreHorizontalIcon className="size-4" />
                        </IconButton>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent width="sm" onClick={(e) => e.stopPropagation()}>
                        <DropdownMenuItem tone="danger" onSelect={() => setRemove(a)}>
                          <TrashIcon className="size-4" /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                )
              })}
            </div>
          )}
        </DashContent>
      </DashMain>
      <ConfirmDialog
        open={!!remove}
        onOpenChange={(open) => !open && setRemove(null)}
        title={`Delete “${remove?.name ?? 'automation'}”?`}
        description="It stops running and its run history goes with it. Frames it already created stay on their canvases."
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          if (remove) void destroy(remove)
          setRemove(null)
        }}
      />
      {toast && <Toast>{toast}</Toast>}
    </DashLayout>
  )
}

/** The example cards: a chain of marks, a name, one line, the schedule and
 *  "Use". The editor's empty slot shows the same set as compact rows. */
export function Examples({ onUse, busy }: { onUse: (example: AutomationExample) => void; busy?: boolean }) {
  return (
    <section className="mt-[30px]">
      <h2 className="text-caption text-ink-faint">Start from an example</h2>
      <div className="mt-3 grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-3">
        {AUTOMATION_EXAMPLES.map((e) => (
          <Pressable
            key={e.id}
            focus="ring"
            className="group flex flex-col gap-2 rounded-card border border-line bg-surface px-4 pb-3.5 pt-4 shadow-card transition-[translate,border-color] duration-150 hover:-translate-y-[3px] hover:border-ink-faint"
            onClick={() => !busy && onUse(e)}
          >
            <StepChain steps={e.steps} size={26} approval={e.trigger === 'approval'} />
            <b className="mt-1 text-copy font-semibold">{e.name}</b>
            <span className="text-body text-ink-soft">{e.blurb}</span>
            <div className="mt-auto flex items-center pt-1.5 text-caption text-ink-faint">
              {e.trigger === 'approval'
                ? 'When designs are approved'
                : describeSchedule({ ...e.schedule, tz: 'UTC' }).replace(' at ', ' ')}
              <b className="ml-auto font-sans text-body font-semibold text-ink group-hover:text-accent-ink">Use →</b>
            </div>
          </Pressable>
        ))}
      </div>
    </section>
  )
}
