import { useEffect, useState } from 'react'
import type { CanvasMeta } from '../../shared/types'
import { roleById } from '../../shared/agents'
import {
  AUTOMATION_EXAMPLES,
  describeSchedule,
  type Automation,
  type AutomationExample,
  type Step,
} from '../../shared/automations'
import { api } from '../lib/api'
import { navigate } from '../App'
import { posthog } from '../lib/posthog'
import { AccountMenu, IconGrid } from '../components/DashShell'
import {
  CanvasThumb,
  ClockTile,
  MetaTile,
  RunDot,
  StepChain,
  Toggle,
  WorkspaceRail,
  formatRunTime,
} from '../components/AutomateShell'
import { RoleMark } from '../components/RoleMark'
import { Button } from '../components/ui/button'
import { Skeleton } from '../components/ui/skeleton'
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
  const [metaConnected, setMetaConnected] = useState(false)
  const [busy, setBusy] = useState(false)
  const [remove, setRemove] = useState<Automation | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    api.listAutomations().then(setItems).catch(console.error)
    api.listCanvases().then(setCanvases).catch(console.error)
    api
      .integrations()
      .then((s) => setMetaConnected(s.meta.connected))
      .catch(console.error)
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
    <DashLayout>
      <WorkspaceRail
        active="automations"
        canvases={canvases}
        automationCount={items?.length}
        integrationCount={metaConnected ? 1 : 0}
      />
      <DashMain>
        <DashHeader>
          <span className="flex-1" />
          <Button variant="primary" className="min-h-10 md:min-h-0" disabled={busy} onClick={() => create()}>
            + New automation
          </Button>
          <AccountMenu />
        </DashHeader>

        <DashContent>
          <DashTitle className="mb-[26px]">
            Automations<em className="not-italic text-brand">.</em>
          </DashTitle>

          {items === null ? (
            <div className="flex flex-col gap-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} index={i} className="h-14 rounded-[12px]" />
              ))}
            </div>
          ) : empty ? (
            <>
              <div className="flex flex-col items-center gap-2.5 rounded-[18px] border-[1.5px] border-dashed border-line px-6 py-[34px] text-center">
                <div className="mb-2.5 flex items-center gap-2.5">
                  <ClockTile size={36} />
                  <span className="h-px w-[22px] bg-[#b9b5ac]" aria-hidden />
                  <MetaTile size={36} className="border border-line bg-surface" />
                  <span className="h-px w-[22px] bg-[#b9b5ac]" aria-hidden />
                  <span className="grid size-9 place-items-center rounded-[10px] border border-line bg-surface text-ink">
                    <IconGrid />
                  </span>
                </div>
                <h3 className="text-[18px] font-semibold tracking-[-0.015em]">Nothing runs on its own yet</h3>
                <p className="max-w-[420px] text-[13.5px] leading-[1.5] text-ink-soft">
                  Pull designs in on a schedule, or hand a canvas to an agent every week.
                </p>
                <Button variant="primary" className="mt-2.5" disabled={busy} onClick={() => create()}>
                  + New automation
                </Button>
              </div>
              <Examples onUse={create} busy={busy} />
            </>
          ) : (
            <div className="overflow-hidden rounded-[14px] border border-line bg-surface shadow-card">
              <div className="hidden grid-cols-[52px_minmax(0,1.7fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)_36px] items-center gap-3 border-b border-line-soft px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint md:grid">
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
                    role="link"
                    tabIndex={0}
                    className="grid cursor-pointer grid-cols-[52px_minmax(0,1fr)_36px] items-center gap-3 border-b border-line-soft px-4 py-3 transition-colors last:border-b-0 hover:bg-paper md:grid-cols-[52px_minmax(0,1.7fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)_36px]"
                    onClick={() => navigate(`/automations/${a.id}`)}
                    onKeyDown={(e) => e.key === 'Enter' && navigate(`/automations/${a.id}`)}
                  >
                    <Toggle on={a.enabled} onChange={(on) => toggle(a, on)} label={`${a.name} on or off`} />
                    <div className="flex min-w-0 items-center gap-2.5">
                      {first?.type === 'pull' ? (
                        <MetaTile size={24} className="border border-line bg-surface" />
                      ) : first ? (
                        <span className="grid size-6 flex-none place-items-center rounded-[7px] border border-line bg-surface">
                          <RoleMark role={roleById(first.roles[0])} size={14} />
                        </span>
                      ) : (
                        <ClockTile size={24} />
                      )}
                      <span className="min-w-0 truncate text-[13.5px] text-ink-soft">
                        <b className="font-semibold text-ink">{a.name}</b>
                        {first?.type === 'agent' && first.roles.length === 1 && <> · @{first.roles[0]}</>} ·{' '}
                        {everyLine(a)}
                      </span>
                    </div>
                    <span className="hidden min-w-0 items-center gap-2.5 text-[13px] text-ink-soft md:flex">
                      {canvasIds.length ? (
                        <>
                          <CanvasThumb canvas={canvas} className="h-[22px] w-[34px]" />
                          <span className="truncate">
                            {canvas?.name ?? 'Canvas'}
                            {canvasIds.length > 1 ? ` +${canvasIds.length - 1}` : ''}
                          </span>
                        </>
                      ) : (
                        <em className="not-italic text-ink-faint">Pick a canvas</em>
                      )}
                    </span>
                    <span className="hidden min-w-0 items-center gap-2 text-[13px] text-ink-soft md:flex">
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
                      className={cn(
                        'hidden font-mono text-[11px] md:block',
                        a.nextRunAt ? 'text-ink-soft' : 'text-ink-faint',
                      )}
                    >
                      {a.nextRunAt ? formatRunTime(a.nextRunAt) : a.enabled ? 'finish setup' : 'paused'}
                    </span>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          aria-label={`Actions for ${a.name}`}
                          className="grid size-8 place-items-center rounded-full text-ink-faint transition-colors hover:bg-paper-deep hover:text-ink"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MoreHorizontalIcon className="size-4" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent className="w-[170px]" onClick={(e) => e.stopPropagation()}>
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
      <h2 className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">Start from an example</h2>
      <div className="mt-3 grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-3">
        {AUTOMATION_EXAMPLES.map((e) => (
          <div
            key={e.id}
            role="button"
            tabIndex={0}
            className="group flex cursor-pointer flex-col gap-2 rounded-[12px] border border-line bg-surface px-4 pb-3.5 pt-4 shadow-card transition-[translate,border-color] duration-150 hover:-translate-y-[3px] hover:border-ink-faint focus-visible:outline-2 focus-visible:outline-brand"
            onClick={() => !busy && onUse(e)}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault()
                if (!busy) onUse(e)
              }
            }}
          >
            <StepChain steps={e.steps} size={26} />
            <b className="mt-1 text-[14px] font-semibold tracking-[-0.012em]">{e.name}</b>
            <p className="text-[12.5px] leading-[1.5] text-ink-soft">{e.blurb}</p>
            <div className="mt-auto flex items-center pt-1.5 font-mono text-[10.5px] text-ink-faint">
              {describeSchedule({ ...e.schedule, tz: 'UTC' }).replace(' at ', ' ')}
              <b className="ml-auto font-sans text-[12.5px] font-semibold text-ink group-hover:text-accent-ink">
                Use →
              </b>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
