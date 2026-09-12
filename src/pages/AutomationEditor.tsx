import { useEffect, useRef, useState } from 'react'
import type { CanvasMeta } from '../../shared/types'
import { AGENT_ROLES, roleById, roleName } from '../../shared/agents'
import {
  AUTOMATION_EXAMPLES,
  MAX_NAME,
  MAX_PROMPT,
  MAX_STEPS,
  WEEKDAYS,
  WEEKDAYS_SHORT,
  incompleteReason,
  type AgentStep,
  type Automation,
  type AutomationExample,
  type AutomationRun,
  type PullStep,
  type Schedule,
  type Step,
} from '../../shared/automations'
import { api, ApiError, type IntegrationsStatus } from '../lib/api'
import { navigate } from '../App'
import { posthog } from '../lib/posthog'
import { BarDivider, TopBar, TopBarHome, TopBarTitle, barGhostBtn, barPrimaryBtn } from '../components/TopBar'
import {
  CanvasThumb,
  Chevron,
  ClockTile,
  MetaTile,
  RunDot,
  Sel,
  StepChain,
  Toggle,
  formatRunTime,
} from '../components/AutomateShell'
import { RoleMark } from '../components/RoleMark'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Textarea } from '../components/ui/textarea'
import {
  Panel,
  PanelBody,
  PanelHeader,
  PanelTab,
  PanelTabPanel,
  PanelTabs,
  PanelTabsRoot,
} from '../components/ui/panel'
import { ListItem, ListMeta, ListSummary, ListTitle } from '../components/ui/list'
import { Skeleton } from '../components/ui/skeleton'
import { Toast } from '../components/ui/toast'
import { Tooltip } from '../components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu'
import { PanelCollapseRightIcon, PanelExpandRightIcon, PlayIcon, PulseIcon, XIcon } from '../components/ui/icons'
import { cn } from '@/lib/utils'

/** A draft is the automation minus what the server owns. */
type Draft = Pick<Automation, 'name' | 'schedule' | 'steps'>

function draftOf(a: Automation): Draft {
  return { name: a.name, schedule: a.schedule, steps: a.steps }
}

function sameDraft(a: Draft, b: Draft): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function newStepId(steps: Step[]): string {
  let n = steps.length + 1
  while (steps.some((s) => s.id === `s${n}`)) n++
  return `s${n}`
}

/** Drag the empty ground (or scroll) to move the chain around, the way the
 *  canvas pans. The offset lives on the DOM, not in state — a pan should
 *  never re-render the nodes. Interactive children keep their own gestures. */
function usePan() {
  const ground = useRef<HTMLDivElement>(null)
  const layer = useRef<HTMLDivElement>(null)
  const offset = useRef({ x: 0, y: 0 })
  /* a press becomes a pan once it has moved a few pixels — until then a
     button under the pointer still gets its click */
  const press = useRef<{ id: number; startX: number; startY: number; x: number; y: number; live: boolean } | null>(null)
  /* set while the click that ends a pan is still on its way */
  const swallow = useRef(false)

  useEffect(() => {
    const el = ground.current
    if (!el) return
    const apply = () => {
      if (layer.current) layer.current.style.transform = `translate(${offset.current.x}px, ${offset.current.y}px)`
    }
    /* the runs panel scrolls itself; text fields keep selection and caret */
    const inPanel = (t: EventTarget | null) => t instanceof Element && !!t.closest('[data-pan-stop]')
    const textField = (t: EventTarget | null) => t instanceof Element && !!t.closest('input, textarea, select')
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || inPanel(e.target) || textField(e.target)) return
      press.current = {
        id: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        x: e.clientX - offset.current.x,
        y: e.clientY - offset.current.y,
        live: false,
      }
    }
    const onMove = (e: PointerEvent) => {
      const p = press.current
      if (!p || p.id !== e.pointerId) return
      if (!p.live) {
        if (Math.hypot(e.clientX - p.startX, e.clientY - p.startY) < 4) return
        p.live = true
        el.setPointerCapture(e.pointerId)
        el.style.cursor = 'grabbing'
      }
      offset.current = { x: e.clientX - p.x, y: e.clientY - p.y }
      apply()
    }
    const onUp = (e: PointerEvent) => {
      const p = press.current
      if (p?.id !== e.pointerId) return
      press.current = null
      el.style.cursor = ''
      if (p.live) {
        swallow.current = true
        setTimeout(() => (swallow.current = false), 0)
      }
    }
    /* a pan that happened must not end as a click on whatever is under the pointer */
    const onClick = (e: MouseEvent) => {
      if (!swallow.current) return
      swallow.current = false
      e.stopPropagation()
      e.preventDefault()
    }
    const onWheel = (e: WheelEvent) => {
      if (inPanel(e.target)) return
      /* a text field with more lines than it shows scrolls itself first */
      const field = e.target instanceof Element ? e.target.closest('textarea') : null
      if (field && field.scrollHeight > field.clientHeight) {
        const atTop = field.scrollTop <= 0 && e.deltaY < 0
        const atBottom = field.scrollTop + field.clientHeight >= field.scrollHeight - 1 && e.deltaY > 0
        if (!atTop && !atBottom) return
      }
      e.preventDefault()
      offset.current = { x: offset.current.x - e.deltaX, y: offset.current.y - e.deltaY }
      apply()
    }
    el.addEventListener('click', onClick, true)
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('click', onClick, true)
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      el.removeEventListener('wheel', onWheel)
    }
  }, [])

  return { ground, layer }
}

/**
 * One automation, in the canvas screen's chrome rather than the dashboard's:
 * a top bar with the name, a Setup | Runs switch and the run controls, then
 * the full-width dot grid. Setup draws the schedule and steps as a short
 * vertical chain of nodes; Runs is the slim log. Every step names its
 * canvas — the canvas is where the work lands, not a step of its own.
 */
export function AutomationEditor({ automationId }: { automationId: string }) {
  const [automation, setAutomation] = useState<Automation | null>(null)
  const [missing, setMissing] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [canvases, setCanvases] = useState<CanvasMeta[]>([])
  const [integrations, setIntegrations] = useState<IntegrationsStatus | null>(null)
  const [saving, setSaving] = useState(false)
  const [runningNow, setRunningNow] = useState(false)
  /* the step picker is open below the chain (always, while there are no steps) */
  const [adding, setAdding] = useState(false)
  const { ground: panGround, layer: panLayer } = usePan()
  /* the runs panel remembers whether it was open, like the canvas side panel */
  const [runsOpen, setRunsOpen] = useState(() => {
    try {
      return localStorage.getItem('doop.automations.runs') !== 'closed'
    } catch {
      return true
    }
  })
  function toggleRuns(open: boolean) {
    setRunsOpen(open)
    try {
      localStorage.setItem('doop.automations.runs', open ? 'open' : 'closed')
    } catch {
      /* private mode */
    }
  }
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    api
      .getAutomation(automationId)
      .then((a) => {
        setAutomation(a)
        setDraft(draftOf(a))
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) setMissing(true)
        else console.error(err)
      })
    api.listCanvases().then(setCanvases).catch(console.error)
    api.integrations().then(setIntegrations).catch(console.error)
  }, [automationId])

  function showToast(message: string) {
    setToast(message)
    window.setTimeout(() => setToast(null), 2400)
  }

  const dirty = !!automation && !!draft && !sameDraft(draftOf(automation), draft)

  async function save(): Promise<Automation | undefined> {
    if (!draft || !automation || saving) return automation ?? undefined
    setSaving(true)
    try {
      const saved = await api.updateAutomation(automation.id, draft)
      setAutomation(saved)
      setDraft(draftOf(saved))
      posthog.capture('automation_saved', { steps: saved.steps.length })
      return saved
    } catch (err) {
      showToast(err instanceof ApiError && typeof err.body.error === 'string' ? err.body.error : 'Couldn’t save')
      return undefined
    } finally {
      setSaving(false)
    }
  }

  /* ⌘S saves — the editor is a form people will expect it from */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  /* the name saves on its own, like a canvas rename — it is not part of the
     draft people expect to confirm with Save */
  async function rename(name: string) {
    if (!automation || !draft) return
    setDraft({ ...draft, name })
    try {
      const saved = await api.updateAutomation(automation.id, { name })
      setAutomation((cur) => (cur ? { ...cur, name: saved.name, updatedAt: saved.updatedAt } : cur))
    } catch (err) {
      console.error(err)
      showToast('Couldn’t rename')
    }
  }

  async function setEnabled(enabled: boolean) {
    if (!automation) return
    setAutomation({ ...automation, enabled })
    try {
      setAutomation(await api.updateAutomation(automation.id, { enabled }))
    } catch (err) {
      console.error(err)
      setAutomation(automation)
      showToast('Couldn’t save')
    }
  }

  async function runNow() {
    if (!automation || runningNow) return
    const saved = dirty ? await save() : automation
    if (!saved) return
    setRunningNow(true)
    try {
      const run = await api.runAutomation(saved.id)
      posthog.capture('automation_run_now', { status: run.status })
      setAutomation({ ...saved, lastRun: run })
    } catch (err) {
      showToast(err instanceof ApiError && typeof err.body.error === 'string' ? err.body.error : 'Couldn’t run')
    } finally {
      setRunningNow(false)
    }
  }

  function applyExample(example: AutomationExample) {
    if (!draft) return
    setDraft({
      name: draft.name === 'Untitled automation' ? example.name : draft.name,
      schedule: { ...example.schedule, tz: draft.schedule.tz },
      steps: example.steps.map((s, i) => ({ ...s, id: `s${i + 1}`, canvasId: '' }) as Step),
    })
  }

  function addStep(type: Step['type']) {
    if (!draft || draft.steps.length >= MAX_STEPS) return
    const id = newStepId(draft.steps)
    /* a new step lands on the canvas the previous one worked on */
    const canvasId = draft.steps[draft.steps.length - 1]?.canvasId ?? ''
    const step: Step =
      type === 'pull'
        ? { id, type: 'pull', provider: 'meta', accountId: '', filter: 'active', canvasId }
        : { id, type: 'agent', title: '', prompt: '', roles: ['doop'], canvasId }
    setDraft({ ...draft, steps: [...draft.steps, step] })
    setAdding(false)
  }

  function patchStep(id: string, patch: Partial<PullStep> | Partial<AgentStep>) {
    if (!draft) return
    setDraft({ ...draft, steps: draft.steps.map((s) => (s.id === id ? ({ ...s, ...patch } as Step) : s)) })
  }

  function removeStep(id: string) {
    if (!draft) return
    setDraft({ ...draft, steps: draft.steps.filter((s) => s.id !== id) })
  }

  const incomplete = draft ? incompleteReason(draft.steps) : undefined

  return (
    <div className="fixed inset-x-0 bottom-0 top-[var(--app-inset,0px)] flex flex-col">
      <TopBar>
        <div className="flex min-w-0 items-center gap-1.5 max-xs:basis-full">
          <TopBarHome label="Automations" to="/automations" />
          <TopBarTitle
            loading={!draft}
            value={draft?.name ?? ''}
            placeholder="Untitled automation"
            onCommit={(name) => void rename(name)}
          />
        </div>
        {automation && (
          <div className="ml-auto flex items-center gap-2.5">
            <Toggle caption on={automation.enabled} onChange={setEnabled} label="Automation on or off" />
            <BarDivider />
            <Button
              variant="ghost"
              className={barGhostBtn}
              disabled={runningNow || !!incomplete}
              onClick={runNow}
              title={incomplete ? `${incomplete} first` : 'Run the automation now'}
            >
              <PlayIcon className="size-3.5" />
              {runningNow ? 'Running…' : 'Run now'}
            </Button>
            <Button variant="primary" className={barPrimaryBtn} disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        )}
      </TopBar>

      <div
        ref={panGround}
        className="relative flex-1 touch-none overflow-hidden [background:radial-gradient(circle,var(--dot)_1.2px,transparent_1.2px)_0_0/26px_26px,var(--paper)]"
      >
        {missing ? (
          <div className="mx-auto max-w-[360px] pt-14 text-center">
            <p className="text-[13.5px] text-ink-soft">That automation doesn’t exist any more.</p>
            <Button variant="ghost" className="mt-3" onClick={() => navigate('/automations')}>
              Back to automations
            </Button>
          </div>
        ) : !draft || !automation ? (
          <div className="mx-auto flex w-[360px] flex-col gap-11 pt-14">
            <Skeleton className="h-[94px] rounded-[10px]" />
            <Skeleton index={1} className="h-[240px] rounded-[10px]" />
          </div>
        ) : (
          <>
            <div ref={panLayer} className="relative h-full will-change-transform">
              <div className="relative mx-auto flex w-[360px] flex-col pb-24 pt-14">
                <WhenNode schedule={draft.schedule} onChange={(schedule) => setDraft({ ...draft, schedule })} />
                {draft.steps.map((step) => (
                  <div key={step.id} className="flex flex-col">
                    <Edge />
                    {step.type === 'pull' ? (
                      <PullNode
                        step={step}
                        canvases={canvases}
                        integrations={integrations}
                        onChange={(patch) => patchStep(step.id, patch)}
                        onRemove={() => removeStep(step.id)}
                      />
                    ) : (
                      <AgentNode
                        step={step}
                        canvases={canvases}
                        onChange={(patch) => patchStep(step.id, patch)}
                        onRemove={() => removeStep(step.id)}
                      />
                    )}
                  </div>
                ))}
                {draft.steps.length === 0 || adding ? (
                  <>
                    <Edge />
                    <StepPicker
                      onPick={addStep}
                      onCancel={draft.steps.length > 0 ? () => setAdding(false) : undefined}
                    />
                  </>
                ) : (
                  <Button
                    variant="bare"
                    disabled={draft.steps.length >= MAX_STEPS}
                    className="mt-5 justify-center text-[12.5px] font-semibold text-ink-faint hover:bg-transparent hover:text-ink"
                    onClick={() => setAdding(true)}
                  >
                    + Add step
                  </Button>
                )}
                {incomplete && draft.steps.length > 0 && (
                  <p className="mt-3 text-center text-[12px] text-ink-faint">{incomplete} to turn it on.</p>
                )}
              </div>
              {draft.steps.length === 0 && (
                <aside className="absolute left-[calc(50%+240px)] top-14 hidden w-[260px] lg:block">
                  <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
                    Or start from an example
                  </div>
                  {AUTOMATION_EXAMPLES.map((e) => (
                    <button
                      key={e.id}
                      type="button"
                      className="mb-1.5 flex w-full items-center gap-2 rounded-[9px] border border-line bg-surface px-2.5 py-2 text-left text-[12.5px] font-semibold tracking-[-0.01em] transition-colors hover:border-ink-faint"
                      onClick={() => applyExample(e)}
                    >
                      <StepChain steps={e.steps} size={18} joined={false} />
                      <span className="min-w-0 truncate">{e.name}</span>
                      <small className="ml-auto font-mono text-[9.5px] font-normal text-ink-faint">
                        {e.schedule.kind === 'daily'
                          ? 'daily'
                          : e.schedule.kind === 'weekdays'
                            ? 'weekdays'
                            : WEEKDAYS_SHORT[e.schedule.weekday]}
                      </small>
                    </button>
                  ))}
                </aside>
              )}
            </div>
            {draft.steps.length > 0 && (
              <div data-pan-stop className="contents">
                {runsOpen ? (
                  <RunsPanel
                    automation={automation}
                    canvases={canvases}
                    dirty={dirty}
                    onRunNow={runNow}
                    onClose={() => toggleRuns(false)}
                  />
                ) : (
                  <nav
                    aria-label="Runs"
                    className="absolute right-3 top-3 z-[38] flex w-12 flex-col items-center gap-1.5 rounded-[14px] border border-line bg-surface p-1.5 shadow-card max-lg:hidden"
                  >
                    <Tooltip label="Expand panel" side="left">
                      <Button
                        variant="bare"
                        size="icon"
                        aria-label="Expand panel"
                        className="relative size-[34px] rounded-lg text-ink-soft hover:bg-paper-deep hover:text-ink"
                        onClick={() => toggleRuns(true)}
                      >
                        <PanelExpandRightIcon />
                      </Button>
                    </Tooltip>
                    <span aria-hidden className="my-0.5 h-px w-6 bg-line-soft" />
                    <Tooltip
                      label={automation.lastRun ? `Runs · last ${formatRunTime(automation.lastRun.startedAt)}` : 'Runs'}
                      side="left"
                    >
                      <Button
                        variant="bare"
                        size="icon"
                        aria-label="Runs"
                        className="relative size-[34px] rounded-lg text-ink-soft hover:bg-paper-deep hover:text-ink"
                        onClick={() => toggleRuns(true)}
                      >
                        <PulseIcon />
                        {automation.lastRun?.status === 'failed' && (
                          <span className="absolute right-[5px] top-[5px] size-1.5 rounded-full bg-accent-ink shadow-[0_0_0_2px_var(--surface)]" />
                        )}
                      </Button>
                    </Tooltip>
                  </nav>
                )}
              </div>
            )}
          </>
        )}
      </div>
      {toast && <Toast>{toast}</Toast>}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Nodes                                                               */

const nodeCls = 'relative rounded-[10px] border border-line bg-surface px-3.5 py-3 shadow-card'
const kCls = 'font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint'

/** A port: the small circle where an edge meets a node. */
function Port({ side, dashed }: { side: 'in' | 'out'; dashed?: boolean }) {
  return (
    <span
      className={cn(
        'absolute left-1/2 z-10 size-3 -translate-x-1/2 rounded-full border-[1.5px] bg-surface',
        side === 'in' ? '-top-[7px]' : '-bottom-[7px]',
        dashed ? 'border-dashed border-ink-faint' : 'border-ink',
      )}
      aria-hidden
    />
  )
}

/** The connector between nodes. */
function Edge() {
  return <div className="mx-auto h-11 w-px bg-[#b9b5ac]" aria-hidden />
}

function pad(n: number) {
  return String(n).padStart(2, '0')
}

/** "09:00" → the viewer's own clock format ("9:00 AM" or "09:00"). */
function clockLabel(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  return new Date(2000, 0, 1, h ?? 0, m ?? 0).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/** "Every [Monday ▾] at [09:00 ▾]" */
function WhenNode({ schedule, onChange }: { schedule: Schedule; onChange: (s: Schedule) => void }) {
  const dayValue =
    schedule.kind === 'daily' ? 'daily' : schedule.kind === 'weekdays' ? 'weekdays' : String(schedule.weekday)
  const time = `${pad(schedule.hour)}:${pad(schedule.minute)}`
  const times: string[] = []
  for (let h = 0; h < 24; h++) for (const m of [0, 30]) times.push(`${pad(h)}:${pad(m)}`)
  if (!times.includes(time)) times.push(time)
  times.sort()
  return (
    <div className={cn(nodeCls, 'border-ink')}>
      <Port side="out" />
      <div className="flex items-center gap-[9px]">
        <ClockTile size={24} />
        <span className={kCls}>When</span>
        <span className="ml-auto text-[10.5px] text-ink-faint">{schedule.tz.replace(/_/g, ' ')}</span>
      </div>
      <div className="mt-2.5 flex items-center gap-2 text-[14px]">
        <span className="text-ink-soft">Every</span>
        <Sel
          aria-label="Which days"
          value={dayValue}
          onChange={(e) => {
            const v = e.target.value
            if (v === 'daily' || v === 'weekdays') onChange({ ...schedule, kind: v })
            else onChange({ ...schedule, kind: 'weekly', weekday: Number(v) })
          }}
        >
          {WEEKDAYS.map((d, i) => (
            <option key={d} value={i}>
              {d}
            </option>
          ))}
          <option value="weekdays">weekday</option>
          <option value="daily">day</option>
        </Sel>
        <span className="text-ink-soft">at</span>
        <Sel
          aria-label="Time"
          value={time}
          onChange={(e) => {
            const [h, m] = e.target.value.split(':').map(Number)
            onChange({ ...schedule, hour: h ?? 9, minute: m ?? 0 })
          }}
        >
          {times.map((t) => (
            <option key={t} value={t}>
              {clockLabel(t)}
            </option>
          ))}
        </Sel>
      </div>
    </div>
  )
}

/** "into ▾ Canvas" / "on ▾ Canvas": a menu of the user's canvases with
 *  their previews, in the same bordered control as the other pickers. */
function CanvasPicker({
  word,
  value,
  canvases,
  onChange,
}: {
  word: string
  value: string
  canvases: CanvasMeta[]
  onChange: (id: string) => void
}) {
  const current = canvases.find((c) => c.id === value)
  return (
    <div className="mt-2.5 flex items-center gap-2 text-[12.5px] text-ink-soft">
      <span>{word}</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              'flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 text-left text-[13.5px] font-semibold tracking-[-0.01em] text-ink transition-colors hover:border-ink-faint focus-visible:outline-2 focus-visible:outline-brand',
              !current && 'font-medium text-ink-faint',
            )}
          >
            {current && <CanvasThumb canvas={current} />}
            <span className="min-w-0 flex-1 truncate">{current?.name ?? 'Choose a canvas'}</span>
            <Chevron className="text-ink-faint" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-[320px] w-[300px] overflow-y-auto">
          {canvases.length === 0 && (
            <DropdownMenuLabel className="text-[12px] font-normal text-ink-faint">No canvases yet</DropdownMenuLabel>
          )}
          {canvases.map((c) => (
            <DropdownMenuItem
              key={c.id}
              onSelect={() => onChange(c.id)}
              className={cn(c.id === value && 'bg-paper-deep')}
            >
              <CanvasThumb canvas={c} />
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function RemoveStep({ onRemove }: { onRemove: () => void }) {
  return (
    <Tooltip label="Remove step" side="left">
      <Button
        variant="bare"
        size="icon-sm"
        className="ml-auto size-6 text-ink-faint hover:text-accent-ink"
        aria-label="Remove step"
        onClick={onRemove}
      >
        <XIcon className="size-3.5" />
      </Button>
    </Tooltip>
  )
}

function PullNode({
  step,
  canvases,
  integrations,
  onChange,
  onRemove,
}: {
  step: PullStep
  canvases: CanvasMeta[]
  integrations: IntegrationsStatus | null
  onChange: (patch: Partial<PullStep>) => void
  onRemove: () => void
}) {
  const meta = integrations?.meta
  const accounts = meta?.accounts ?? []
  return (
    <div className={nodeCls}>
      <Port side="in" />
      <Port side="out" />
      <div className="flex items-center gap-[9px]">
        <MetaTile size={24} />
        <div className="min-w-0">
          <div className={kCls}>Pull · Meta Ads</div>
          <div className="text-[13.5px] font-semibold tracking-[-0.012em]">Ad creatives</div>
        </div>
        {meta && (
          <span
            className={cn(
              'ml-auto inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.06em]',
              meta.connected ? 'text-ink-soft' : 'text-ink-faint',
            )}
          >
            <span className={cn('size-[6px] rounded-full', meta.connected ? 'bg-[#3f9c52]' : 'bg-line')} />
            {meta.connected ? 'connected' : 'not connected'}
          </span>
        )}
        <RemoveStep onRemove={onRemove} />
      </div>
      {!meta ? (
        <div className="mt-2.5 text-[12.5px] text-ink-faint">…</div>
      ) : !meta.connected ? (
        <div className="mt-2.5 flex items-center gap-3">
          <span className="text-[13px] text-ink-soft">Not connected yet</span>
          <Button variant="solid" size="sm" className="ml-auto h-8" onClick={() => navigate('/integrations')}>
            Connect Meta
          </Button>
        </div>
      ) : (
        <div className="mt-2.5 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2.5">
          <Sel
            aria-label="Ad account"
            className={cn(!step.accountId && '[&>select]:text-ink-faint')}
            value={step.accountId}
            onChange={(e) => onChange({ accountId: e.target.value })}
          >
            <option value="">Ad account</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · {a.id.replace(/^act_/, '')}
              </option>
            ))}
          </Sel>
          <Sel
            aria-label="Which ads"
            value={step.filter}
            onChange={(e) => onChange({ filter: e.target.value as PullStep['filter'] })}
          >
            <option value="active">Active ads</option>
            <option value="all">All ads</option>
          </Sel>
        </div>
      )}
      <CanvasPicker
        word="into"
        value={step.canvasId}
        canvases={canvases}
        onChange={(canvasId) => onChange({ canvasId })}
      />
    </div>
  )
}

function AgentNode({
  step,
  canvases,
  onChange,
  onRemove,
}: {
  step: AgentStep
  canvases: CanvasMeta[]
  onChange: (patch: Partial<AgentStep>) => void
  onRemove: () => void
}) {
  /* one agent per task: a pill picks that role, nothing to un-pick */
  const roles = step.roles
  return (
    <div className={nodeCls}>
      <Port side="in" />
      <Port side="out" />
      <div className="flex items-center gap-[9px]">
        <RoleMark role={roleById(roles[0])} size={24} />
        <div className="min-w-0 flex-1">
          <div className={kCls}>Agent task</div>
          <Input
            value={step.title}
            maxLength={MAX_NAME}
            aria-label="Task title"
            variant="bare"
            inputSize="auto"
            placeholder="Untitled task"
            className="w-full text-[13.5px] font-semibold tracking-[-0.012em] md:text-[13.5px]"
            onChange={(e) => onChange({ title: e.target.value })}
          />
        </div>
        <RemoveStep onRemove={onRemove} />
      </div>
      <Textarea
        className="mt-2.5 min-h-[74px] w-full rounded-lg px-[11px] py-2.5 text-[13.5px] leading-[1.5] md:text-[13.5px]"
        value={step.prompt}
        maxLength={MAX_PROMPT}
        placeholder="What should the agent do on this canvas?"
        onChange={(e) => onChange({ prompt: e.target.value })}
      />
      <div className="mt-2.5 flex flex-wrap gap-1">
        {AGENT_ROLES.map((role) => {
          const on = roles[0] === role.id
          return (
            <Button
              key={role.id}
              variant="ghost"
              size="sm"
              role="radio"
              aria-checked={on}
              className={cn(
                'gap-1 rounded-full px-2 py-1 text-[11.5px] text-ink-soft hover:border-ink-soft hover:bg-transparent',
                on && 'border-ink bg-ink text-white hover:border-ink hover:bg-ink hover:text-white',
              )}
              title={role.blurb}
              onClick={() => onChange({ roles: [role.id] })}
            >
              <RoleMark role={role} size={13} />
              {role.name}
            </Button>
          )
        })}
      </div>
      <p className="mt-2 text-[11.5px] text-ink-faint">{roleName(roles[0])} picks it up right away</p>
      <CanvasPicker
        word="on"
        value={step.canvasId}
        canvases={canvases}
        onChange={(canvasId) => onChange({ canvasId })}
      />
    </div>
  )
}

/** The step slot: the two things a step can be, as tiles. It is the empty
 *  automation's first slot and, later, what "+ Add step" opens in place. */
function StepPicker({ onPick, onCancel }: { onPick: (type: Step['type']) => void; onCancel?: () => void }) {
  const tile =
    'flex flex-col items-start gap-2 rounded-[9px] border border-line bg-surface px-3 pb-[11px] pt-3 text-left shadow-card transition-colors hover:border-ink-faint focus-visible:outline-2 focus-visible:outline-brand'
  return (
    <div
      className="relative rounded-[10px] border-[1.5px] border-dashed border-line bg-white/60 p-3.5"
      onKeyDown={(e) => e.key === 'Escape' && onCancel?.()}
    >
      <Port side="in" dashed />
      <div className="flex items-center">
        <span className="flex-1 text-center text-[13.5px] font-semibold tracking-[-0.012em]">What should run?</span>
        {onCancel && (
          <Button
            variant="bare"
            size="icon-sm"
            className="absolute right-2 top-2 size-6 text-ink-faint hover:text-ink"
            aria-label="Cancel"
            onClick={onCancel}
          >
            <XIcon className="size-3.5" />
          </Button>
        )}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button type="button" className={tile} autoFocus={!!onCancel} onClick={() => onPick('pull')}>
          <MetaTile size={22} />
          <b className="text-[13px] font-semibold tracking-[-0.012em]">Integrations</b>
          <span className="text-[11.5px] leading-[1.45] text-ink-soft">Pull Meta ad creatives onto a canvas.</span>
        </button>
        <button type="button" className={tile} onClick={() => onPick('agent')}>
          <span className="flex">
            {AGENT_ROLES.slice(0, 4).map((r, i) => (
              <RoleMark key={r.id} role={r} size={22} className={cn(i > 0 && '-ml-1.5 ring-[1.5px] ring-white')} />
            ))}
          </span>
          <b className="text-[13px] font-semibold tracking-[-0.012em]">Agent task</b>
          <span className="text-[11.5px] leading-[1.45] text-ink-soft">
            Give Doop, UX Lead or another role a brief on a canvas.
          </span>
        </button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Runs                                                                */

/** Every run of this automation, newest first, in the same floating panel
 *  the canvas screen uses for its activity feed. */
function RunsPanel({
  automation,
  canvases,
  dirty,
  onRunNow,
  onClose,
}: {
  automation: Automation
  canvases: CanvasMeta[]
  dirty: boolean
  onRunNow: () => void
  onClose: () => void
}) {
  const [runs, setRuns] = useState<AutomationRun[] | null>(null)
  const [more, setMore] = useState(false)
  const lastRunId = automation.lastRun?.id

  useEffect(() => {
    api
      .listRuns(automation.id)
      .then((list) => {
        setRuns(list)
        setMore(list.length >= 20)
      })
      .catch(console.error)
  }, [automation.id, lastRunId])

  async function older() {
    const last = runs?.[runs.length - 1]
    if (!last) return
    const list = await api.listRuns(automation.id, last.startedAt).catch(() => [])
    setRuns((cur) => [...(cur ?? []), ...list])
    setMore(list.length >= 20)
  }

  const canvasName = (id: string | null) => (id ? canvases.find((c) => c.id === id)?.name : undefined)

  return (
    <Panel className="inset-y-3 right-3 w-[300px] max-lg:hidden">
      <PanelTabsRoot value="runs">
        <PanelHeader>
          <PanelTabs>
            <PanelTab value="runs">Runs</PanelTab>
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
        <PanelTabPanel value="runs">
          <PanelBody className="py-2">
            <ListItem className="bg-paper/60">
              <span className="flex items-center gap-2">
                <ClockTile size={14} className={cn(!automation.nextRunAt && 'opacity-40')} />
                <ListTitle className="text-ink-soft">
                  {automation.nextRunAt && !dirty ? 'Next run' : automation.enabled ? 'Next run' : 'Paused'}
                </ListTitle>
                <ListMeta className="ml-auto font-mono">
                  {automation.nextRunAt && !dirty ? formatRunTime(automation.nextRunAt) : ''}
                </ListMeta>
              </span>
              {!automation.nextRunAt && automation.enabled && (
                <ListSummary className="whitespace-normal">
                  {dirty ? 'Save to see when it runs next.' : (incompleteReason(automation.steps) ?? 'Not scheduled.')}
                </ListSummary>
              )}
            </ListItem>
            {runs === null ? (
              <div className="px-4 py-3">
                <Skeleton className="h-10 rounded-md" />
              </div>
            ) : runs.length === 0 ? (
              <div className="px-4 py-3 text-xs leading-[1.5] text-ink-faint">
                No runs yet.{' '}
                {automation.nextRunAt
                  ? 'The first one is on the schedule.'
                  : 'Finish the setup and turn it on, or run it now.'}
                {!incompleteReason(automation.steps) && (
                  <Button variant="ghost" size="sm" className="mt-2.5 block" onClick={onRunNow}>
                    Run now
                  </Button>
                )}
              </div>
            ) : (
              runs.map((r) => (
                <ListItem key={r.id}>
                  <span className="flex items-center gap-2">
                    <RunDot status={r.status} />
                    <ListTitle>{formatRunTime(r.startedAt)}</ListTitle>
                    <ListMeta className="ml-auto font-mono">
                      {r.endedAt ? duration(r.endedAt - r.startedAt) : ''}
                    </ListMeta>
                  </span>
                  <ListSummary
                    className={cn('whitespace-normal', r.status === 'failed' && 'text-accent-ink')}
                    title={r.error ?? r.summary ?? undefined}
                  >
                    {r.status === 'running'
                      ? 'Running…'
                      : r.status === 'failed'
                        ? (r.error ?? 'Failed')
                        : (r.summary ?? 'Nothing new')}
                  </ListSummary>
                  {r.failure === 'reconnect' ? (
                    <button
                      type="button"
                      className="self-start text-xs font-semibold text-accent-ink hover:underline"
                      onClick={() => navigate('/integrations')}
                    >
                      Reconnect Meta
                    </button>
                  ) : r.canvasId && r.status === 'ok' ? (
                    <button
                      type="button"
                      className="self-start text-xs font-semibold text-accent-ink hover:underline"
                      onClick={() => navigate(`/c/${r.canvasId}`)}
                    >
                      Open {canvasName(r.canvasId) ?? 'canvas'} →
                    </button>
                  ) : null}
                </ListItem>
              ))
            )}
            {more && (
              <button
                type="button"
                className="w-full px-4 py-2.5 text-left text-xs text-ink-soft transition-colors hover:bg-paper hover:text-ink"
                onClick={older}
              >
                Show older
              </button>
            )}
          </PanelBody>
        </PanelTabPanel>
      </PanelTabsRoot>
    </Panel>
  )
}

function duration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}
