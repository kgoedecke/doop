import { useMemo } from 'react'
import type { Frame } from '../../shared/types'
import { canvasPages, framePageId } from '../../shared/pages'
import {
  DEFAULT_PROTO_DURATION,
  MAX_PROTO_DELAY,
  MAX_PROTO_DURATION,
  type Interaction,
  type ProtoAction,
  type ProtoTransition,
  type ProtoTrigger,
} from '../../shared/prototype'
import { useStore } from '../lib/store'
import { isLayerLocked } from '../lib/layerEdits'
import { elementInteractions, saveInteractions, setFlowStart } from '../lib/prototype'
import { IconButton } from './ui/icon-button'
import { PlusIcon, TrashIcon } from './ui/icons'
import { Switch } from './ui/switch'
import { NumberField, PropertyRow, PropertySection, SelectField, TextField } from './ui/property-field'
import { useT, type PlainMessageKey } from '../lib/i18n'

const TRIGGERS: { value: ProtoTrigger; label: PlainMessageKey }[] = [
  { value: 'click', label: 'inspector.triggerClick' },
  { value: 'hover', label: 'inspector.triggerHover' },
  { value: 'press', label: 'inspector.triggerPress' },
  { value: 'delay', label: 'inspector.triggerDelay' },
  { value: 'key', label: 'inspector.triggerKey' },
]
const ACTIONS: { value: ProtoAction; label: PlainMessageKey }[] = [
  { value: 'navigate', label: 'inspector.actionNavigate' },
  { value: 'overlay', label: 'inspector.actionOverlay' },
  { value: 'back', label: 'inspector.actionBack' },
  { value: 'close-overlay', label: 'inspector.actionCloseOverlay' },
  { value: 'scroll-to', label: 'inspector.actionScrollTo' },
  { value: 'url', label: 'inspector.actionUrl' },
]
const TRANSITIONS: { value: ProtoTransition; label: PlainMessageKey }[] = [
  { value: 'instant', label: 'inspector.transitionInstant' },
  { value: 'dissolve', label: 'inspector.transitionDissolve' },
  { value: 'slide-left', label: 'inspector.transitionSlideLeft' },
  { value: 'slide-right', label: 'inspector.transitionSlideRight' },
  { value: 'slide-up', label: 'inspector.transitionSlideUp' },
  { value: 'slide-down', label: 'inspector.transitionSlideDown' },
  { value: 'push-left', label: 'inspector.transitionPushLeft' },
  { value: 'push-right', label: 'inspector.transitionPushRight' },
]

/** The Prototype tab of the element panel: the element's interactions, and
 *  whether its frame starts the page's flow. Every change rewrites the
 *  element's attributes through the frame save path, one undo step each. */
export function InteractionsPanel({ frame, selector }: { frame: Frame; selector: string }) {
  const t = useT()
  const canvas = useStore((s) => s.canvas)
  const list = useMemo(() => elementInteractions(frame.html, selector), [frame.html, selector])
  const locked = isLayerLocked(frame, selector)
  const pages = canvas ? canvasPages(canvas) : []
  const pageId = canvas ? framePageId(canvas, frame) : null
  const page = pages.find((p) => p.id === pageId)
  const targets = useMemo(() => {
    if (!canvas) return []
    const pageNames = new Map(canvasPages(canvas).map((p) => [p.id, p.name]))
    const multiPage = pageNames.size > 1
    return canvas.frames
      .filter((f) => f.id !== frame.id)
      .map((f) => ({
        value: f.id,
        label: multiPage ? `${f.name} · ${pageNames.get(framePageId(canvas, f)) ?? ''}` : f.name,
      }))
  }, [canvas, frame.id])

  function save(next: Interaction[]) {
    const live = useStore.getState().canvas?.frames.find((f) => f.id === frame.id) ?? frame
    if (!saveInteractions(live, selector, next)) useStore.getState().pushNotice(t('inspector.layerNotEditable'))
  }

  const firstTarget = targets[0]?.value
  function add() {
    if (!list) return
    const action: ProtoAction = firstTarget ? 'navigate' : 'back'
    save([
      ...list,
      {
        trigger: 'click',
        action,
        ...(firstTarget ? { target: firstTarget } : {}),
        transition: 'instant',
        duration: DEFAULT_PROTO_DURATION,
      },
    ])
  }

  return (
    <>
      <PropertySection
        title={t('inspector.interactions')}
        action={
          list &&
          !locked && (
            <IconButton size="sm" aria-label={t('inspector.addInteraction')} onClick={add}>
              <PlusIcon size="rail" />
            </IconButton>
          )
        }
      >
        {!list ? (
          <p className="text-caption text-ink-faint">{t('inspector.scriptMade')}</p>
        ) : list.length === 0 ? (
          <p className="text-caption text-ink-faint">
            {locked ? t('inspector.unlockToAdd') : t('inspector.noInteractions')}
          </p>
        ) : (
          <div className="flex flex-col gap-2.5" data-interactions="">
            {list.map((interaction, index) => (
              <InteractionRow
                key={index}
                index={index}
                interaction={interaction}
                targets={targets}
                disabled={locked}
                onChange={(next) => save(list.map((item, i) => (i === index ? next : item)))}
                onRemove={() => save(list.filter((_, i) => i !== index))}
              />
            ))}
          </div>
        )}
      </PropertySection>
      {canvas && page && (
        <PropertySection title={t('inspector.flow')}>
          <PropertyRow label={t('inspector.flowStartRow')}>
            <span className="flex flex-1 items-center justify-between gap-2 text-caption text-ink-soft">
              {page.startFrameId === frame.id ? t('inspector.startsHere') : t('inspector.startFlowHere')}
              <Switch
                size="sm"
                aria-label={t('inspector.startFlowHere')}
                checked={page.startFrameId === frame.id}
                onCheckedChange={(on) => setFlowStart(canvas.id, page.id, on ? frame.id : null)}
              />
            </span>
          </PropertyRow>
        </PropertySection>
      )}
    </>
  )
}

function InteractionRow({
  index,
  interaction,
  targets,
  disabled,
  onChange,
  onRemove,
}: {
  index: number
  interaction: Interaction
  targets: { value: string; label: string }[]
  disabled: boolean
  onChange: (next: Interaction) => void
  onRemove: () => void
}) {
  const t = useT()
  const i = interaction
  const n = index + 1
  const triggers = TRIGGERS.map(({ value, label }) => ({ value, label: t(label) }))
  const actions = ACTIONS.map(({ value, label }) => ({ value, label: t(label) }))
  const transitions = TRANSITIONS.map(({ value, label }) => ({ value, label: t(label) }))
  const firstTarget = targets[0]?.value

  function setTrigger(trigger: ProtoTrigger) {
    const { delay: _delay, key: _key, ...rest } = i
    onChange({
      ...rest,
      trigger,
      ...(trigger === 'delay' ? { delay: 1000 } : {}),
      ...(trigger === 'key' ? { key: 'ArrowRight' } : {}),
    })
  }

  function setAction(action: ProtoAction) {
    const { target: _target, ...rest } = i
    const target =
      action === 'navigate' || action === 'overlay'
        ? i.action === 'navigate' || i.action === 'overlay'
          ? i.target
          : firstTarget
        : action === 'scroll-to'
          ? 'body'
          : action === 'url'
            ? 'https://example.com'
            : undefined
    if ((action === 'navigate' || action === 'overlay') && !target) return
    onChange({ ...rest, action, ...(target ? { target } : {}) })
  }

  const leavesFrame = i.action === 'navigate' || i.action === 'overlay'
  const targetOptions =
    leavesFrame && i.target && !targets.some((target) => target.value === i.target)
      ? [{ value: i.target, label: t('inspector.missingFrame', { id: i.target }) }, ...targets]
      : targets

  return (
    <fieldset
      disabled={disabled}
      className="flex flex-col rounded-row bg-sub/60 px-2 pt-0.5 pb-2"
      aria-label={t('inspector.interactionN', { n })}
    >
      <PropertyRow label={t('inspector.rowTrigger')}>
        <SelectField
          label={t('inspector.triggerN', { n })}
          value={i.trigger}
          options={triggers}
          onChange={setTrigger}
        />
        <IconButton size="sm" variant="danger" aria-label={t('inspector.removeInteractionN', { n })} onClick={onRemove}>
          <TrashIcon size="rail" />
        </IconButton>
      </PropertyRow>
      {i.trigger === 'delay' && (
        <PropertyRow label={t('inspector.rowAfter')}>
          <NumberField
            label={t('inspector.delayN', { n })}
            value={i.delay ?? 0}
            unit="ms"
            max={MAX_PROTO_DELAY}
            onCommit={(delay) => onChange({ ...i, delay: Math.round(delay) })}
          />
        </PropertyRow>
      )}
      {i.trigger === 'key' && (
        <PropertyRow label={t('inspector.rowKey')}>
          <TextField
            label={t('inspector.keyN', { n })}
            value={i.key === ' ' ? 'Space' : (i.key ?? '')}
            placeholder="ArrowRight"
            onCommit={(key) => key.trim() && onChange({ ...i, key: key.trim() === 'Space' ? ' ' : key.trim() })}
          />
        </PropertyRow>
      )}
      <PropertyRow label={t('inspector.rowAction')}>
        <SelectField label={t('inspector.actionN', { n })} value={i.action} options={actions} onChange={setAction} />
      </PropertyRow>
      {leavesFrame && (
        <PropertyRow label={t('inspector.rowFrame')}>
          {targetOptions.length ? (
            <SelectField
              label={t('inspector.targetFrameN', { n })}
              value={i.target ?? ''}
              options={targetOptions}
              onChange={(target) => onChange({ ...i, target })}
            />
          ) : (
            <span className="text-caption text-ink-faint">{t('inspector.addAnotherFrame')}</span>
          )}
        </PropertyRow>
      )}
      {i.action === 'scroll-to' && (
        <PropertyRow label={t('inspector.rowElement')}>
          <TextField
            label={t('inspector.scrollTargetN', { n })}
            value={i.target ?? ''}
            placeholder="#pricing"
            onCommit={(target) => target.trim() && onChange({ ...i, target: target.trim() })}
          />
        </PropertyRow>
      )}
      {i.action === 'url' && (
        <PropertyRow label={t('inspector.rowUrl')}>
          <TextField
            label={t('inspector.linkN', { n })}
            value={i.target ?? ''}
            placeholder="https://"
            onCommit={(target) => /^https?:\/\/\S+$/i.test(target.trim()) && onChange({ ...i, target: target.trim() })}
          />
        </PropertyRow>
      )}
      {leavesFrame && (
        <PropertyRow label={t('inspector.rowMotion')}>
          <SelectField
            label={t('inspector.transitionN', { n })}
            value={i.transition}
            options={transitions}
            onChange={(transition) => onChange({ ...i, transition })}
          />
          {i.transition !== 'instant' && (
            <NumberField
              label={t('inspector.durationN', { n })}
              className="max-w-[72px]"
              value={i.duration}
              unit="ms"
              max={MAX_PROTO_DURATION}
              onCommit={(duration) => onChange({ ...i, duration: Math.round(duration) })}
            />
          )}
        </PropertyRow>
      )}
    </fieldset>
  )
}
