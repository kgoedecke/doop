import { clientIntegrations } from '../integrations'
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
  type AutomationTrigger,
  type SlackStep,
  type LinearStep,
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
import { FrameThumb } from '../components/FramePreview'
import { BarDivider, TopBar, TopBarHome, TopBarTitle, barGhostBtn, barPrimaryBtn } from '../components/TopBar'
import {
  ApprovalTile,
  PullMark,
  ClockTile,
  MetaTile,
  RunDot,
  StepChain,
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
  PanelIconTab,
  PanelTabPanel,
  PanelTabs,
  PanelTabsRoot,
} from '../components/ui/panel'
import { ListItem, ListMeta, ListSummary, ListTitle } from '../components/ui/list'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { Skeleton } from '../components/ui/skeleton'
import { Switch } from '../components/ui/switch'
import { StatusLabel } from '../components/ui/status-label'
import { Toast } from '../components/ui/toast'
import { Tooltip } from '../components/ui/tooltip'
import { Toolbar, ToolbarControl, ToolbarDot } from '../components/ui/toolbar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu'
import { ChevronDownIcon, PanelCollapseRightIcon, PlayIcon, PulseIcon, XIcon } from '../components/ui/icons'
import { cn } from '@/lib/utils'

/** A draft is the automation minus what the server owns. */
type Draft = Pick<Automation, 'name' | 'schedule' | 'steps' | 'trigger'>

function draftOf(a: Automation): Draft {
  return { name: a.name, trigger: a.trigger, schedule: a.schedule, steps: a.steps }
}

function sameDraft(a: Draft, b: Draft): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function newStepId(steps: Step[]): string {
  let n = steps.length + 1
  while (steps.some((s) => s.id === `s${n}`)) n++
  return `s${n}`
}

/** Drag the empty ground (or scroll over it) to move the chain around, the way
 *  the canvas pans. The offset lives on the DOM, not in state — a pan should
 *  never re-render the nodes. Nodes (`data-pan-node`) and controls keep their
 *  own gestures. */
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
    /* nodes and controls keep their own gestures: a press on a dropdown opens
       it, a two-finger scroll over a node leaves the chain where it is */
    const onNode = (t: EventTarget | null) =>
      t instanceof Element && !!t.closest('[data-pan-node], button, a, input, textarea, select, [role="combobox"]')
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || inPanel(e.target) || onNode(e.target)) return
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
      /* still claimed over a node, so a sideways swipe never turns into browser back */
      e.preventDefault()
      if (onNode(e.target)) return
      if (e.shiftKey && e.deltaX === 0) {
        offset.current = { x: offset.current.x - e.deltaY, y: offset.current.y }
      } else {
        offset.current = { x: offset.current.x - e.deltaX, y: offset.current.y - e.deltaY }
      }
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
      trigger: example.trigger === 'approval' ? { type: 'approval', canvasId: '' } : { type: 'schedule' },
      steps: example.steps.map((s, i) => ({ ...s, id: `s${i + 1}`, canvasId: '' }) as Step),
    })
  }

  function addStep(kind: string) {
    if (!draft || draft.steps.length >= MAX_STEPS) return
    const id = newStepId(draft.steps)
    /* a new step lands on the canvas the previous one worked on */
    const canvasId =
      draft.trigger.type === 'approval' ? draft.trigger.canvasId : (draft.steps[draft.steps.length - 1]?.canvasId ?? '')
    const preset = AUTOMATION_EXAMPLES.find((e) => e.id === kind)?.steps[0]
    const step: Step = preset
      ? ({ ...preset, id, canvasId } as Step)
      : kind === 'slack'
        ? {
            id,
            type: 'slack',
            canvasId,
            channelId: '',
            message: 'Approved designs are ready. Here are the designs and workflow results.',
          }
        : kind === 'linear'
          ? { id, type: 'linear', canvasId, teamId: '', title: 'Follow up on approved designs', description: '' }
          : kind === 'pull'
            ? { id, type: 'pull', provider: 'meta', accountId: '', filter: 'active', canvasId }
            : { id, type: 'agent', title: '', prompt: '', roles: ['doop'], canvasId }
    setDraft({ ...draft, steps: [...draft.steps, step] })
    setAdding(false)
  }

  function patchStep(id: string, patch: Partial<Step>) {
    if (!draft) return
    setDraft({ ...draft, steps: draft.steps.map((s) => (s.id === id ? ({ ...s, ...patch } as Step) : s)) })
  }

  function removeStep(id: string) {
    if (!draft) return
    setDraft({ ...draft, steps: draft.steps.filter((s) => s.id !== id) })
  }

  const approvalCanvasId = draft?.trigger.type === 'approval' ? draft.trigger.canvasId : undefined
  const stepCanvases = approvalCanvasId === undefined ? canvases : canvases.filter((c) => c.id === approvalCanvasId)
  const incomplete = draft ? incompleteReason(draft.steps, draft.trigger) : undefined

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
            <span className="inline-flex items-center gap-2">
              <span className="text-caption text-ink-soft">{automation.enabled ? 'On' : 'Off'}</span>
              <Switch checked={automation.enabled} onCheckedChange={setEnabled} aria-label="Automation on or off" />
            </span>
            <BarDivider />
            <Button
              variant="ghost"
              className={barGhostBtn}
              disabled={runningNow || !!incomplete || !automation.enabled}
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
            <p className="text-copy text-ink-soft">That automation doesn’t exist any more.</p>
            <Button variant="ghost" className="mt-3" onClick={() => navigate('/automations')}>
              Back to automations
            </Button>
          </div>
        ) : !draft || !automation ? (
          <div className="mx-auto flex w-[360px] flex-col gap-11 pt-14">
            <Skeleton shape="card" />
            <Skeleton index={1} shape="card" />
          </div>
        ) : (
          <>
            <div ref={panLayer} className="relative h-full will-change-transform">
              <div className="relative mx-auto flex w-[360px] flex-col pb-24 pt-14">
                <WhenNode
                  schedule={draft.schedule}
                  onChange={(schedule) => setDraft({ ...draft, schedule })}
                  trigger={draft.trigger}
                  canvases={canvases}
                  onTriggerChange={(trigger) =>
                    setDraft({
                      ...draft,
                      trigger,
                      steps:
                        trigger.type === 'approval'
                          ? draft.steps.map((s) => ({ ...s, canvasId: trigger.canvasId }))
                          : draft.steps,
                    })
                  }
                />
                {draft.steps.map((step) => (
                  <div key={step.id} className="flex flex-col">
                    <Edge />
                    {step.type === 'pull' ? (
                      <PullNode
                        step={step}
                        canvases={stepCanvases}
                        integrations={integrations}
                        onChange={(patch) => patchStep(step.id, patch)}
                        onRemove={() => removeStep(step.id)}
                      />
                    ) : step.type === 'slack' || step.type === 'linear' ? (
                      <DeliveryNode
                        step={step}
                        canvases={stepCanvases}
                        integrations={integrations}
                        onChange={(patch) => patchStep(step.id, patch)}
                        onRemove={() => removeStep(step.id)}
                      />
                    ) : (
                      <AgentNode
                        step={step}
                        canvases={stepCanvases}
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
                    className="mt-5 justify-center text-body font-semibold text-ink-faint hover:bg-transparent hover:text-ink"
                    onClick={() => setAdding(true)}
                  >
                    + Add step
                  </Button>
                )}
                {incomplete && draft.steps.length > 0 && (
                  <p className="mt-3 text-center text-label text-ink-faint">{incomplete} to turn it on.</p>
                )}
              </div>
              {draft.steps.length === 0 && (
                <aside data-pan-node className="absolute left-[calc(50%+240px)] top-14 hidden w-[260px] lg:block">
                  <div className="mb-2 text-caption text-ink-faint">Or start from an example</div>
                  {AUTOMATION_EXAMPLES.map((e) => (
                    <button
                      key={e.id}
                      type="button"
                      className="mb-1.5 flex w-full items-center gap-2 rounded-[9px] border border-line bg-surface px-2.5 py-2 text-left text-body font-semibold tracking-[-0.01em] transition-colors hover:border-ink-faint"
                      onClick={() => applyExample(e)}
                    >
                      <StepChain steps={e.steps} size={18} joined={false} approval={e.trigger === 'approval'} />
                      <span className="min-w-0 truncate">{e.name}</span>
                      <small className="ml-auto text-micro font-normal text-ink-faint">
                        {e.trigger === 'approval'
                          ? 'on approval'
                          : e.schedule.kind === 'daily'
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
                  <Toolbar
                    aria-label="Runs"
                    orientation="vertical"
                    className="absolute right-3 top-3 z-[38] max-lg:hidden"
                  >
                    <ToolbarControl
                      label={automation.lastRun ? `Runs · last ${formatRunTime(automation.lastRun.startedAt)}` : 'Runs'}
                      onClick={() => toggleRuns(true)}
                    >
                      <PulseIcon />
                      {automation.lastRun?.status === 'failed' && <ToolbarDot className="bg-accent-ink" />}
                    </ToolbarControl>
                  </Toolbar>
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

const nodeCls = 'relative rounded-pill border border-line bg-surface px-3.5 py-3 shadow-card'
const kCls = 'text-caption text-ink-faint'

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
function WhenNode({
  schedule,
  onChange,
  trigger,
  onTriggerChange,
  canvases,
}: {
  schedule: Schedule
  onChange: (s: Schedule) => void
  trigger: AutomationTrigger
  onTriggerChange: (trigger: AutomationTrigger) => void
  canvases: CanvasMeta[]
}) {
  const dayValue =
    schedule.kind === 'daily' ? 'daily' : schedule.kind === 'weekdays' ? 'weekdays' : String(schedule.weekday)
  const time = `${pad(schedule.hour)}:${pad(schedule.minute)}`
  const times: string[] = []
  for (let h = 0; h < 24; h++) for (const m of [0, 30]) times.push(`${pad(h)}:${pad(m)}`)
  if (!times.includes(time)) times.push(time)
  times.sort()
  return (
    <div data-pan-node className={cn(nodeCls, 'border-ink')}>
      <Port side="out" />
      <div className="flex items-center gap-[9px]">
        {trigger.type === 'approval' ? <ApprovalTile /> : <ClockTile size={24} />}
        <span className={kCls}>When</span>
        <Select
          value={trigger.type}
          onValueChange={(type) => onTriggerChange(type === 'approval' ? { type, canvasId: '' } : { type: 'schedule' })}
        >
          <SelectTrigger size="sm" aria-label="Automation trigger">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="schedule">On a schedule</SelectItem>
            <SelectItem value="approval">Designs are approved</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {trigger.type === 'approval' ? (
        <>
          <CanvasPicker
            word="on"
            value={trigger.canvasId}
            canvases={canvases}
            onChange={(canvasId) => onTriggerChange({ ...trigger, canvasId })}
          />
          <p className="mt-2 text-caption text-ink-faint">
            Runs when frames are marked ready for dev. Nearby approvals are grouped; generated designs stay drafts.
          </p>
        </>
      ) : (
        <div className="mt-2.5 flex items-center gap-2 text-copy">
          <span className="text-ink-soft">Every</span>
          <Select
            value={dayValue}
            onValueChange={(v) => {
              if (v === 'daily' || v === 'weekdays') onChange({ ...schedule, kind: v })
              else onChange({ ...schedule, kind: 'weekly', weekday: Number(v) })
            }}
          >
            <SelectTrigger size="sm" aria-label="Which days">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WEEKDAYS.map((d, i) => (
                <SelectItem key={d} value={String(i)}>
                  {d}
                </SelectItem>
              ))}
              <SelectItem value="weekdays">weekday</SelectItem>
              <SelectItem value="daily">day</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-ink-soft">at</span>
          <Select
            value={time}
            onValueChange={(v) => {
              const [h, m] = v.split(':').map(Number)
              onChange({ ...schedule, hour: h ?? 9, minute: m ?? 0 })
            }}
          >
            <SelectTrigger size="sm" aria-label="Time">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {times.map((t) => (
                <SelectItem key={t} value={t}>
                  {clockLabel(t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
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
    <div className="mt-2.5 flex items-center gap-2 text-body text-ink-soft">
      <span>{word}</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              'flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 text-left text-copy font-semibold tracking-[-0.01em] text-ink transition-colors hover:border-ink-faint focus-visible:outline-2 focus-visible:outline-brand',
              !current && 'font-medium text-ink-faint',
            )}
          >
            {current && <FrameThumb size="xs" frameId={current.previewFrameId} />}
            <span className="min-w-0 flex-1 truncate">{current?.name ?? 'Choose a canvas'}</span>
            <ChevronDownIcon width={12} height={12} className="flex-none text-ink-faint" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" width="lg" className="max-h-[320px] overflow-y-auto">
          {canvases.length === 0 && (
            <DropdownMenuLabel className="text-label font-normal text-ink-faint">No canvases yet</DropdownMenuLabel>
          )}
          {canvases.map((c) => (
            <DropdownMenuItem
              key={c.id}
              onSelect={() => onChange(c.id)}
              className={cn(c.id === value && 'bg-paper-deep')}
            >
              <FrameThumb size="xs" frameId={c.previewFrameId} />
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function DeliveryNode({
  step,
  canvases,
  integrations,
  onChange,
  onRemove,
}: {
  step: SlackStep | LinearStep
  canvases: CanvasMeta[]
  integrations: IntegrationsStatus | null
  onChange: (patch: Partial<Step>) => void
  onRemove: () => void
}) {
  const integration = clientIntegrations.find((i) => i.id === step.type)
  const connected = !!integrations && !!integration?.isConnected(integrations)
  const [teams, setTeams] = useState<{ id: string; name: string; key: string }[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (step.type !== 'linear' || !connected) return
    let canceled = false
    api
      .automationLinearTeams()
      .then((list) => {
        if (!canceled) {
          setTeams(list)
          setError(null)
        }
      })
      .catch(() => {
        if (!canceled) setError('Could not load teams. Check your Linear connection.')
      })
    return () => {
      canceled = true
    }
  }, [step.type, connected])
  return (
    <div data-pan-node className={nodeCls}>
      <Port side="in" />
      <Port side="out" />
      <div className="flex items-center gap-2">
        <PullMark provider={step.type} />
        <span className="text-copy font-semibold">
          {step.type === 'slack' ? 'Post to Slack' : 'Create Linear ticket'}
        </span>
        <RemoveStep onRemove={onRemove} />
      </div>
      {integrations && !connected && (
        <Button className="mt-2" variant="solid" size="sm" onClick={() => navigate('/integrations')}>
          Connect {integration?.name ?? step.type}
        </Button>
      )}
      {step.type === 'slack' ? (
        <>
          <Input
            className="mt-2"
            aria-label="Slack channel ID"
            placeholder="Channel ID, e.g. C012ABCDEF"
            value={step.channelId}
            onChange={(e) => onChange({ channelId: e.target.value.trim() })}
          />
          <p className="mt-1 text-caption text-ink-faint">
            Copy the ID from Slack channel details and invite @Doop to the channel.
          </p>
          <Textarea
            className="mt-2"
            aria-label="Slack message"
            value={step.message}
            maxLength={MAX_PROMPT}
            onChange={(e) => onChange({ message: e.target.value })}
          />
        </>
      ) : (
        <>
          <Select value={step.teamId} onValueChange={(teamId) => onChange({ teamId })}>
            <SelectTrigger className="mt-2 w-full" size="sm" aria-label="Linear team">
              <SelectValue placeholder="Choose a team" />
            </SelectTrigger>
            <SelectContent>
              {teams.map((team) => (
                <SelectItem key={team.id} value={team.id}>
                  {team.name} · {team.key}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {error && (
            <p role="alert" className="mt-1 text-caption text-accent-ink">
              {error}
            </p>
          )}
          <Input
            className="mt-2"
            aria-label="Linear ticket title"
            placeholder="Ticket title"
            value={step.title}
            maxLength={200}
            onChange={(e) => onChange({ title: e.target.value })}
          />
          <Textarea
            className="mt-2"
            aria-label="Linear ticket description"
            placeholder="What needs to happen next?"
            value={step.description}
            maxLength={MAX_PROMPT}
            onChange={(e) => onChange({ description: e.target.value })}
          />
        </>
      )}
      <p className="mt-2 text-caption text-ink-faint">
        Includes design links and results. Waits for earlier design tasks to finish.
      </p>
      <CanvasPicker
        word="for"
        value={step.canvasId}
        canvases={canvases}
        onChange={(canvasId) => onChange({ canvasId })}
      />
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
    <div data-pan-node className={nodeCls}>
      <Port side="in" />
      <Port side="out" />
      <div className="flex items-center gap-[9px]">
        <MetaTile size={24} />
        <div className="min-w-0">
          <div className={kCls}>Pull · Meta Ads</div>
          <div className="text-copy font-semibold tracking-[-0.012em]">Ad creatives</div>
        </div>
        {meta && (
          <StatusLabel tone={meta.connected ? 'done' : 'muted'} className="ml-auto">
            {meta.connected ? 'connected' : 'not connected'}
          </StatusLabel>
        )}
        <RemoveStep onRemove={onRemove} />
      </div>
      {!meta ? (
        <div className="mt-2.5 text-body text-ink-faint">…</div>
      ) : !meta.connected ? (
        <div className="mt-2.5 flex items-center gap-3">
          <span className="text-body text-ink-soft">Not connected yet</span>
          <Button variant="solid" size="sm" className="ml-auto h-8" onClick={() => navigate('/integrations')}>
            Connect Meta
          </Button>
        </div>
      ) : (
        <div className="mt-2.5 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2.5">
          {/* an unset account is '' — Radix shows the placeholder for it */}
          <Select value={step.accountId} onValueChange={(accountId) => onChange({ accountId })}>
            <SelectTrigger size="sm" className="w-full" aria-label="Ad account">
              <SelectValue placeholder="Ad account" />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name} · {a.id.replace(/^act_/, '')}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={step.filter} onValueChange={(filter) => onChange({ filter: filter as PullStep['filter'] })}>
            <SelectTrigger size="sm" className="w-full" aria-label="Which ads">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active ads</SelectItem>
              <SelectItem value="all">All ads</SelectItem>
            </SelectContent>
          </Select>
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
    <div data-pan-node className={nodeCls}>
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
            className="w-full text-copy font-semibold tracking-[-0.012em] md:text-copy"
            onChange={(e) => onChange({ title: e.target.value })}
          />
        </div>
        <RemoveStep onRemove={onRemove} />
      </div>
      <Textarea
        className="mt-2.5 min-h-[74px] w-full rounded-lg px-[11px] py-2.5 text-copy leading-[1.5] md:text-copy"
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
                'gap-1 rounded-full px-2 py-1 text-caption text-ink-soft hover:border-ink-soft hover:bg-transparent',
                on && 'border-ink bg-ink text-paper hover:border-ink hover:bg-ink hover:text-paper',
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
      <p className="mt-2 text-caption text-ink-faint">{roleName(roles[0])} picks it up right away</p>
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
function StepPicker({ onPick, onCancel }: { onPick: (kind: string) => void; onCancel?: () => void }) {
  const tile =
    'flex flex-col items-start gap-2 rounded-[9px] border border-line bg-surface px-3 pb-[11px] pt-3 text-left shadow-card transition-colors hover:border-ink-faint focus-visible:outline-2 focus-visible:outline-brand'
  return (
    <div
      data-pan-node
      className="relative rounded-pill border-[1.5px] border-dashed border-line bg-paper-deep/60 p-3.5"
      onKeyDown={(e) => e.key === 'Escape' && onCancel?.()}
    >
      <Port side="in" dashed />
      <div className="flex items-center">
        <span className="flex-1 text-center text-copy font-semibold tracking-[-0.012em]">What should run?</span>
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
        {AUTOMATION_EXAMPLES.filter((e) => e.trigger === 'approval').map((e) => (
          <button type="button" key={e.id} className={tile} onClick={() => onPick(e.id)}>
            <RoleMark role={roleById('doop')} size={22} />
            <b className="text-body font-medium">{e.name}</b>
            <span className="text-caption text-ink-soft">{e.blurb}</span>
          </button>
        ))}
        {(['linear', 'slack'] as const).map((provider) => (
          <button type="button" key={provider} className={tile} onClick={() => onPick(provider)}>
            <PullMark provider={provider} size={22} />
            <b className="text-body font-medium">{provider === 'linear' ? 'Create Linear ticket' : 'Post to Slack'}</b>
            <span className="text-caption text-ink-soft">Share design links and results from earlier steps.</span>
          </button>
        ))}
        <button type="button" className={tile} autoFocus={!!onCancel} onClick={() => onPick('pull')}>
          <MetaTile size={22} />
          <b className="text-body font-semibold tracking-[-0.012em]">Meta Ads</b>
          <span className="text-caption leading-[1.45] text-ink-soft">Pull Meta ad creatives onto a canvas.</span>
        </button>
        <button type="button" className={tile} onClick={() => onPick('agent')}>
          <span className="flex">
            {AGENT_ROLES.slice(0, 4).map((r, i) => (
              <RoleMark key={r.id} role={r} size={22} className={cn(i > 0 && '-ml-1.5 ring-[1.5px] ring-surface')} />
            ))}
          </span>
          <b className="text-body font-semibold tracking-[-0.012em]">Agent task</b>
          <span className="text-caption leading-[1.45] text-ink-soft">
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
    const timer = window.setInterval(() => {
      api
        .listRuns(automation.id)
        .then((list) => {
          setRuns((current) => {
            if (!current || current.length <= 20) return list
            const fresh = new Set(list.map((run) => run.id))
            return [...list, ...current.filter((run) => !fresh.has(run.id))]
          })
        })
        .catch(console.error)
    }, 5_000)
    return () => window.clearInterval(timer)
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
            <PanelIconTab value="runs" icon={<PulseIcon />} title="Runs">
              Runs
            </PanelIconTab>
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
                {automation.trigger.type === 'approval' ? (
                  <ApprovalTile size={14} />
                ) : (
                  <ClockTile size={14} className={cn(!automation.nextRunAt && 'opacity-40')} />
                )}
                <ListTitle className="text-ink-soft">
                  {automation.nextRunAt && !dirty ? 'Next run' : automation.enabled ? 'Next run' : 'Paused'}
                </ListTitle>
                <ListMeta className="ml-auto">
                  {automation.nextRunAt && !dirty ? formatRunTime(automation.nextRunAt) : ''}
                </ListMeta>
              </span>
              {!automation.nextRunAt && automation.enabled && (
                <ListSummary className="whitespace-normal">
                  {dirty
                    ? 'Save to see when it runs next.'
                    : (incompleteReason(automation.steps, automation.trigger) ??
                      (automation.trigger.type === 'approval'
                        ? 'Waiting for new design approvals.'
                        : 'Not scheduled.'))}
                </ListSummary>
              )}
            </ListItem>
            {runs === null ? (
              <div className="px-4 py-3">
                <Skeleton shape="row" />
              </div>
            ) : runs.length === 0 ? (
              <div className="px-4 py-3 text-xs leading-[1.5] text-ink-faint">
                No runs yet.{' '}
                {automation.trigger.type === 'approval'
                  ? 'Approve designs on the selected canvas to start.'
                  : automation.nextRunAt
                    ? 'The first one is on the schedule.'
                    : 'Finish the setup and turn it on, or run it now.'}
                {!incompleteReason(automation.steps, automation.trigger) && (
                  <Button variant="ghost" size="sm" className="mt-2.5 block" onClick={onRunNow}>
                    Run now
                  </Button>
                )}
              </div>
            ) : (
              runs.map((r) => (
                /* slides in as it arrives, like the Agents panel's rows */
                <ListItem key={r.id} className="animate-[chip-in_0.25s_ease]">
                  <span className="flex items-center gap-2">
                    <RunDot status={r.status} />
                    <ListTitle>{formatRunTime(r.startedAt)}</ListTitle>
                    <ListMeta className="ml-auto">{r.endedAt ? duration(r.endedAt - r.startedAt) : ''}</ListMeta>
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
