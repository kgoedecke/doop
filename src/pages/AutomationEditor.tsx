import { clientIntegrations } from '../integrations'
import { useEffect, useRef, useState } from 'react'
import type { CanvasMeta } from '../../shared/types'
import { AGENT_ROLES, roleById, roleName } from '../../shared/agents'
import {
  AUTOMATION_EXAMPLES,
  MAX_NAME,
  MAX_PROMPT,
  MAX_STEPS,
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
  exampleBlurb,
  exampleName,
  formatRunTime,
  clockText,
  incompleteText,
  weekdayShort,
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
import {
  ArrowRightIcon,
  ChevronDownIcon,
  PanelCollapseRightIcon,
  PlayIcon,
  PulseIcon,
  XIcon,
} from '../components/ui/icons'
import { cn } from '@/lib/utils'
import { useT, type PlainMessageKey, type Translate } from '@/lib/i18n'

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
  const t = useT()
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
      showToast(
        err instanceof ApiError && typeof err.body.error === 'string' ? err.body.error : t('automations.saveFailed'),
      )
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
      showToast(t('automations.renameFailed'))
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
      showToast(t('automations.saveFailed'))
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
      showToast(
        err instanceof ApiError && typeof err.body.error === 'string' ? err.body.error : t('automations.runFailed'),
      )
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
  const incompleteRaw = draft ? incompleteReason(draft.steps, draft.trigger) : undefined
  const incomplete = incompleteRaw && incompleteText(t, incompleteRaw)

  return (
    <div className="fixed inset-x-0 bottom-0 top-[var(--app-inset,0px)] flex flex-col">
      <TopBar>
        <div className="flex min-w-0 items-center gap-1.5 max-xs:basis-full">
          <TopBarHome label={t('rail.automations')} to="/automations" />
          <TopBarTitle
            loading={!draft}
            value={draft?.name ?? ''}
            placeholder={t('automations.untitledAutomation')}
            onCommit={(name) => void rename(name)}
          />
        </div>
        {automation && (
          <div className="ml-auto flex items-center gap-2.5">
            <span className="inline-flex items-center gap-2">
              <span className="text-caption text-ink-soft">
                {automation.enabled ? t('automations.on') : t('automations.off')}
              </span>
              <Switch
                checked={automation.enabled}
                onCheckedChange={setEnabled}
                aria-label={t('automations.automationToggle')}
              />
            </span>
            <BarDivider />
            <Button
              variant="ghost"
              className={barGhostBtn}
              disabled={runningNow || !!incomplete || !automation.enabled}
              onClick={runNow}
              title={incomplete ? t('automations.reasonFirst', { reason: incomplete }) : t('automations.runNowTitle')}
            >
              <PlayIcon className="size-3.5" />
              {runningNow ? t('automations.runningEllipsis') : t('automations.runNow')}
            </Button>
            <Button variant="primary" className={barPrimaryBtn} disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? t('automations.saving') : t('common.save')}
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
            <p className="text-copy text-ink-soft">{t('automations.missing')}</p>
            <Button variant="ghost" className="mt-3" onClick={() => navigate('/automations')}>
              {t('automations.backToAutomations')}
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
                    {t('automations.addStep')}
                  </Button>
                )}
                {incomplete && draft.steps.length > 0 && (
                  <p className="mt-3 text-center text-label text-ink-faint">
                    {t('automations.reasonToTurnOn', { reason: incomplete })}
                  </p>
                )}
              </div>
              {draft.steps.length === 0 && (
                <aside data-pan-node className="absolute left-[calc(50%+240px)] top-14 hidden w-[260px] lg:block">
                  <div className="mb-2 text-caption text-ink-faint">{t('automations.orStartFromExample')}</div>
                  {AUTOMATION_EXAMPLES.map((e) => (
                    <button
                      key={e.id}
                      type="button"
                      className="mb-1.5 flex w-full items-center gap-2 rounded-[9px] border border-line bg-surface px-2.5 py-2 text-left text-body font-semibold tracking-[-0.01em] transition-colors hover:border-ink-faint"
                      onClick={() => applyExample(e)}
                    >
                      <StepChain steps={e.steps} size={18} joined={false} approval={e.trigger === 'approval'} />
                      <span className="min-w-0 truncate">{exampleName(t, e)}</span>
                      <small className="ml-auto text-micro font-normal text-ink-faint">
                        {e.trigger === 'approval'
                          ? t('automations.onApproval')
                          : e.schedule.kind === 'daily'
                            ? t('automations.daily')
                            : e.schedule.kind === 'weekdays'
                              ? t('automations.weekdays')
                              : weekdayShort(e.schedule.weekday)}
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
                    aria-label={t('automations.runs')}
                    orientation="vertical"
                    className="absolute right-3 top-3 z-[38] max-lg:hidden"
                  >
                    <ToolbarControl
                      label={
                        automation.lastRun
                          ? t('automations.runsLast', { time: formatRunTime(automation.lastRun.startedAt) })
                          : t('automations.runs')
                      }
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
  return clockText(h ?? 0, m ?? 0)
}

/* the day picker's options, Sunday first like Date.getDay() */
const DAY_OPTIONS = [
  'automations.dayOption0',
  'automations.dayOption1',
  'automations.dayOption2',
  'automations.dayOption3',
  'automations.dayOption4',
  'automations.dayOption5',
  'automations.dayOption6',
] as const satisfies readonly PlainMessageKey[]

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
  const t = useT()
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
        <span className={kCls}>{t('automations.when')}</span>
        <Select
          value={trigger.type}
          onValueChange={(type) => onTriggerChange(type === 'approval' ? { type, canvasId: '' } : { type: 'schedule' })}
        >
          <SelectTrigger size="sm" aria-label={t('automations.triggerLabel')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="schedule">{t('automations.triggerSchedule')}</SelectItem>
            <SelectItem value="approval">{t('automations.triggerApproval')}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {trigger.type === 'approval' ? (
        <>
          <CanvasPicker
            word={t('automations.canvasOn')}
            value={trigger.canvasId}
            canvases={canvases}
            onChange={(canvasId) => onTriggerChange({ ...trigger, canvasId })}
          />
          <p className="mt-2 text-caption text-ink-faint">{t('automations.approvalHint')}</p>
        </>
      ) : (
        <div className="mt-2.5 flex items-center gap-2 text-copy">
          <span className="text-ink-soft">{t('automations.every')}</span>
          <Select
            value={dayValue}
            onValueChange={(v) => {
              if (v === 'daily' || v === 'weekdays') onChange({ ...schedule, kind: v })
              else onChange({ ...schedule, kind: 'weekly', weekday: Number(v) })
            }}
          >
            <SelectTrigger size="sm" aria-label={t('automations.whichDays')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DAY_OPTIONS.map((label, i) => (
                <SelectItem key={label} value={String(i)}>
                  {t(label)}
                </SelectItem>
              ))}
              <SelectItem value="weekdays">{t('automations.dayOptionWeekdays')}</SelectItem>
              <SelectItem value="daily">{t('automations.dayOptionDaily')}</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-ink-soft">{t('automations.at')}</span>
          <Select
            value={time}
            onValueChange={(v) => {
              const [h, m] = v.split(':').map(Number)
              onChange({ ...schedule, hour: h ?? 9, minute: m ?? 0 })
            }}
          >
            <SelectTrigger size="sm" aria-label={t('automations.time')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {times.map((hhmm) => (
                <SelectItem key={hhmm} value={hhmm}>
                  {clockLabel(hhmm)}
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
  const t = useT()
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
            <span className="min-w-0 flex-1 truncate">{current?.name ?? t('automations.chooseCanvas')}</span>
            <ChevronDownIcon width={12} height={12} className="flex-none text-ink-faint" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" width="lg" className="max-h-[320px] overflow-y-auto">
          {canvases.length === 0 && (
            <DropdownMenuLabel className="text-label font-normal text-ink-faint">
              {t('automations.noCanvases')}
            </DropdownMenuLabel>
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
  const t = useT()
  const integration = clientIntegrations.find((i) => i.id === step.type)
  const connected = !!integrations && !!integration?.isConnected(integrations)
  const [teams, setTeams] = useState<{ id: string; name: string; key: string }[]>([])
  const [teamsFailed, setTeamsFailed] = useState(false)
  useEffect(() => {
    if (step.type !== 'linear' || !connected) return
    let canceled = false
    api
      .automationLinearTeams()
      .then((list) => {
        if (!canceled) {
          setTeams(list)
          setTeamsFailed(false)
        }
      })
      .catch(() => {
        if (!canceled) setTeamsFailed(true)
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
          {step.type === 'slack' ? t('automations.postToSlack') : t('automations.createLinearTicket')}
        </span>
        <RemoveStep onRemove={onRemove} />
      </div>
      {integrations && !connected && (
        <Button className="mt-2" variant="solid" size="sm" onClick={() => navigate('/integrations')}>
          {t('automations.connectProvider', { name: integration?.name ?? step.type })}
        </Button>
      )}
      {step.type === 'slack' ? (
        <>
          <Input
            className="mt-2"
            aria-label={t('automations.slackChannelLabel')}
            placeholder={t('automations.slackChannelPlaceholder')}
            value={step.channelId}
            onChange={(e) => onChange({ channelId: e.target.value.trim() })}
          />
          <p className="mt-1 text-caption text-ink-faint">{t('automations.slackChannelHint')}</p>
          <Textarea
            className="mt-2"
            aria-label={t('automations.slackMessageLabel')}
            value={step.message}
            maxLength={MAX_PROMPT}
            onChange={(e) => onChange({ message: e.target.value })}
          />
        </>
      ) : (
        <>
          <Select value={step.teamId} onValueChange={(teamId) => onChange({ teamId })}>
            <SelectTrigger className="mt-2 w-full" size="sm" aria-label={t('automations.linearTeamLabel')}>
              <SelectValue placeholder={t('automations.chooseTeam')} />
            </SelectTrigger>
            <SelectContent>
              {teams.map((team) => (
                <SelectItem key={team.id} value={team.id}>
                  {team.name} · {team.key}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {teamsFailed && (
            <p role="alert" className="mt-1 text-caption text-accent-ink">
              {t('automations.loadTeamsFailed')}
            </p>
          )}
          <Input
            className="mt-2"
            aria-label={t('automations.ticketTitleLabel')}
            placeholder={t('automations.ticketTitlePlaceholder')}
            value={step.title}
            maxLength={200}
            onChange={(e) => onChange({ title: e.target.value })}
          />
          <Textarea
            className="mt-2"
            aria-label={t('automations.ticketDescriptionLabel')}
            placeholder={t('automations.ticketDescriptionPlaceholder')}
            value={step.description}
            maxLength={MAX_PROMPT}
            onChange={(e) => onChange({ description: e.target.value })}
          />
        </>
      )}
      <p className="mt-2 text-caption text-ink-faint">{t('automations.deliveryHint')}</p>
      <CanvasPicker
        word={t('automations.canvasFor')}
        value={step.canvasId}
        canvases={canvases}
        onChange={(canvasId) => onChange({ canvasId })}
      />
    </div>
  )
}

function RemoveStep({ onRemove }: { onRemove: () => void }) {
  const t = useT()
  return (
    <Tooltip label={t('automations.removeStep')} side="left">
      <Button
        variant="bare"
        size="icon-sm"
        className="ml-auto size-6 text-ink-faint hover:text-accent-ink"
        aria-label={t('automations.removeStep')}
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
  const t = useT()
  const meta = integrations?.meta
  const accounts = meta?.accounts ?? []
  return (
    <div data-pan-node className={nodeCls}>
      <Port side="in" />
      <Port side="out" />
      <div className="flex items-center gap-[9px]">
        <MetaTile size={24} />
        <div className="min-w-0">
          <div className={kCls}>{t('automations.pullMeta')}</div>
          <div className="text-copy font-semibold tracking-[-0.012em]">{t('automations.adCreatives')}</div>
        </div>
        {meta && (
          <StatusLabel tone={meta.connected ? 'done' : 'muted'} className="ml-auto">
            {meta.connected ? t('automations.connected') : t('automations.notConnected')}
          </StatusLabel>
        )}
        <RemoveStep onRemove={onRemove} />
      </div>
      {!meta ? (
        <div className="mt-2.5 text-body text-ink-faint">…</div>
      ) : !meta.connected ? (
        <div className="mt-2.5 flex items-center gap-3">
          <span className="text-body text-ink-soft">{t('automations.notConnectedYet')}</span>
          <Button variant="solid" size="sm" className="ml-auto h-8" onClick={() => navigate('/integrations')}>
            {t('automations.connectMeta')}
          </Button>
        </div>
      ) : (
        <div className="mt-2.5 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2.5">
          {/* an unset account is '' — Radix shows the placeholder for it */}
          <Select value={step.accountId} onValueChange={(accountId) => onChange({ accountId })}>
            <SelectTrigger size="sm" className="w-full" aria-label={t('automations.adAccount')}>
              <SelectValue placeholder={t('automations.adAccount')} />
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
            <SelectTrigger size="sm" className="w-full" aria-label={t('automations.whichAds')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">{t('automations.activeAds')}</SelectItem>
              <SelectItem value="all">{t('automations.allAds')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
      <CanvasPicker
        word={t('automations.canvasInto')}
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
  const t = useT()
  /* one agent per task: a pill picks that role, nothing to un-pick */
  const roles = step.roles
  return (
    <div data-pan-node className={nodeCls}>
      <Port side="in" />
      <Port side="out" />
      <div className="flex items-center gap-[9px]">
        <RoleMark role={roleById(roles[0])} size={24} />
        <div className="min-w-0 flex-1">
          <div className={kCls}>{t('automations.agentTask')}</div>
          <Input
            value={step.title}
            maxLength={MAX_NAME}
            aria-label={t('automations.taskTitle')}
            variant="bare"
            inputSize="auto"
            placeholder={t('automations.untitledTask')}
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
        placeholder={t('automations.agentPromptPlaceholder')}
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
              title={roleBlurb(t, role.id, role.blurb)}
              onClick={() => onChange({ roles: [role.id] })}
            >
              <RoleMark role={role} size={13} />
              {role.name}
            </Button>
          )
        })}
      </div>
      <p className="mt-2 text-caption text-ink-faint">{t('automations.picksUp', { role: roleName(roles[0]) })}</p>
      <CanvasPicker
        word={t('automations.canvasOn')}
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
  const t = useT()
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
        <span className="flex-1 text-center text-copy font-semibold tracking-[-0.012em]">
          {t('automations.whatShouldRun')}
        </span>
        {onCancel && (
          <Button
            variant="bare"
            size="icon-sm"
            className="absolute right-2 top-2 size-6 text-ink-faint hover:text-ink"
            aria-label={t('common.cancel')}
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
            <b className="text-body font-medium">{exampleName(t, e)}</b>
            <span className="text-caption text-ink-soft">{exampleBlurb(t, e)}</span>
          </button>
        ))}
        {(['linear', 'slack'] as const).map((provider) => (
          <button type="button" key={provider} className={tile} onClick={() => onPick(provider)}>
            <PullMark provider={provider} size={22} />
            <b className="text-body font-medium">
              {provider === 'linear' ? t('automations.createLinearTicket') : t('automations.postToSlack')}
            </b>
            <span className="text-caption text-ink-soft">{t('automations.shareResults')}</span>
          </button>
        ))}
        <button type="button" className={tile} autoFocus={!!onCancel} onClick={() => onPick('pull')}>
          <MetaTile size={22} />
          <b className="text-body font-semibold tracking-[-0.012em]">Meta Ads</b>
          <span className="text-caption leading-[1.45] text-ink-soft">{t('automations.metaPullBlurb')}</span>
        </button>
        <button type="button" className={tile} onClick={() => onPick('agent')}>
          <span className="flex">
            {AGENT_ROLES.slice(0, 4).map((r, i) => (
              <RoleMark key={r.id} role={r} size={22} className={cn(i > 0 && '-ml-1.5 ring-[1.5px] ring-surface')} />
            ))}
          </span>
          <b className="text-body font-semibold tracking-[-0.012em]">{t('automations.agentTask')}</b>
          <span className="text-caption leading-[1.45] text-ink-soft">{t('automations.agentTaskBlurb')}</span>
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
  const t = useT()
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
  const savedIncompleteRaw = incompleteReason(automation.steps, automation.trigger)
  const savedIncomplete = savedIncompleteRaw && incompleteText(t, savedIncompleteRaw)

  return (
    <Panel className="inset-y-3 right-3 w-[300px] max-lg:hidden">
      <PanelTabsRoot value="runs">
        <PanelHeader>
          <PanelTabs>
            <PanelIconTab value="runs" icon={<PulseIcon />} title={t('automations.runs')}>
              {t('automations.runs')}
            </PanelIconTab>
          </PanelTabs>
          <Tooltip label={t('automations.collapsePanel')} side="bottom" align="end">
            <Button
              variant="bare"
              size="icon-sm"
              className="shrink-0 text-ink-faint hover:bg-paper-deep hover:text-ink"
              aria-label={t('automations.collapsePanel')}
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
                  {automation.nextRunAt && !dirty
                    ? t('automations.nextRun')
                    : automation.enabled
                      ? t('automations.nextRun')
                      : t('automations.pausedTitle')}
                </ListTitle>
                <ListMeta className="ml-auto">
                  {automation.nextRunAt && !dirty ? formatRunTime(automation.nextRunAt) : ''}
                </ListMeta>
              </span>
              {!automation.nextRunAt && automation.enabled && (
                <ListSummary className="whitespace-normal">
                  {dirty
                    ? t('automations.saveToSee')
                    : (savedIncomplete ??
                      (automation.trigger.type === 'approval'
                        ? t('automations.waitingApprovals')
                        : t('automations.notScheduled')))}
                </ListSummary>
              )}
            </ListItem>
            {runs === null ? (
              <div className="px-4 py-3">
                <Skeleton shape="row" />
              </div>
            ) : runs.length === 0 ? (
              <div className="px-4 py-3 text-xs leading-[1.5] text-ink-faint">
                {t('automations.noRunsYet')}{' '}
                {automation.trigger.type === 'approval'
                  ? t('automations.noRunsApproval')
                  : automation.nextRunAt
                    ? t('automations.noRunsScheduled')
                    : t('automations.noRunsFinish')}
                {!savedIncompleteRaw && (
                  <Button variant="ghost" size="sm" className="mt-2.5 block" onClick={onRunNow}>
                    {t('automations.runNow')}
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
                    <ListMeta className="ml-auto">{r.endedAt ? duration(t, r.endedAt - r.startedAt) : ''}</ListMeta>
                  </span>
                  <ListSummary
                    className={cn('whitespace-normal', r.status === 'failed' && 'text-accent-ink')}
                    title={r.error ?? r.summary ?? undefined}
                  >
                    {r.status === 'running'
                      ? t('automations.runningEllipsis')
                      : r.status === 'failed'
                        ? (r.error ?? t('automations.failed'))
                        : (r.summary ?? t('automations.nothingNew'))}
                  </ListSummary>
                  {r.failure === 'reconnect' ? (
                    <button
                      type="button"
                      className="self-start text-xs font-semibold text-accent-ink hover:underline"
                      onClick={() => navigate('/integrations')}
                    >
                      {t('automations.reconnectMeta')}
                    </button>
                  ) : r.canvasId && r.status === 'ok' ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 self-start text-xs font-semibold text-accent-ink hover:underline"
                      onClick={() => navigate(`/c/${r.canvasId}`)}
                    >
                      {t('automations.openCanvas', { name: canvasName(r.canvasId) ?? t('automations.canvasLower') })}
                      <ArrowRightIcon size={12} />
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
                {t('automations.showOlder')}
              </button>
            )}
          </PanelBody>
        </PanelTabPanel>
      </PanelTabsRoot>
    </Panel>
  )
}

function duration(t: Translate, ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  if (s < 60) return t('automations.durationSeconds', { s })
  const m = Math.floor(s / 60)
  return t('automations.durationMinutes', { m, s: s % 60 })
}

/* a role's one-liner in the app's language; the role's name is its identity */
const ROLE_BLURB: Record<string, PlainMessageKey> = {
  doop: 'automations.roleBlurbDoop',
  ux: 'automations.roleBlurbUx',
  copy: 'automations.roleBlurbCopy',
  brand: 'automations.roleBlurbBrand',
  a11y: 'automations.roleBlurbA11y',
  polish: 'automations.roleBlurbPolish',
}

function roleBlurb(t: Translate, id: string, fallback: string): string {
  const key = ROLE_BLURB[id]
  return key ? t(key) : fallback
}
