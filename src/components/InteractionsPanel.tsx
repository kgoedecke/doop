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

const TRIGGERS: { value: ProtoTrigger; label: string }[] = [
  { value: 'click', label: 'On click' },
  { value: 'hover', label: 'On hover' },
  { value: 'press', label: 'While pressing' },
  { value: 'delay', label: 'After delay' },
  { value: 'key', label: 'On key' },
]
const ACTIONS: { value: ProtoAction; label: string }[] = [
  { value: 'navigate', label: 'Navigate to' },
  { value: 'overlay', label: 'Open overlay' },
  { value: 'back', label: 'Back' },
  { value: 'close-overlay', label: 'Close overlay' },
  { value: 'scroll-to', label: 'Scroll to' },
  { value: 'url', label: 'Open link' },
]
const TRANSITIONS: { value: ProtoTransition; label: string }[] = [
  { value: 'instant', label: 'Instant' },
  { value: 'dissolve', label: 'Dissolve' },
  { value: 'slide-left', label: 'Slide left' },
  { value: 'slide-right', label: 'Slide right' },
  { value: 'slide-up', label: 'Slide up' },
  { value: 'slide-down', label: 'Slide down' },
  { value: 'push-left', label: 'Push left' },
  { value: 'push-right', label: 'Push right' },
]

/** The Prototype tab of the element panel: the element's interactions, and
 *  whether its frame starts the page's flow. Every change rewrites the
 *  element's attributes through the frame save path, one undo step each. */
export function InteractionsPanel({ frame, selector }: { frame: Frame; selector: string }) {
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
    if (!saveInteractions(live, selector, next)) useStore.getState().pushNotice('This layer can’t be edited right now')
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
        title="Interactions"
        action={
          list &&
          !locked && (
            <IconButton size="sm" aria-label="Add interaction" onClick={add}>
              <PlusIcon size="rail" />
            </IconButton>
          )
        }
      >
        {!list ? (
          <p className="text-caption text-ink-faint">
            A script creates this element, so it has no markup to hold interactions. Add them in the frame’s HTML.
          </p>
        ) : list.length === 0 ? (
          <p className="text-caption text-ink-faint">
            {locked ? 'Unlock the layer to add interactions.' : 'Nothing happens when this is clicked yet.'}
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
        <PropertySection title="Flow">
          <PropertyRow label="Start">
            <span className="flex flex-1 items-center justify-between gap-2 text-caption text-ink-soft">
              {page.startFrameId === frame.id ? 'Starts here' : 'Start the flow on this frame'}
              <Switch
                size="sm"
                aria-label="Start the flow on this frame"
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
  const i = interaction
  const n = index + 1
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
    leavesFrame && i.target && !targets.some((t) => t.value === i.target)
      ? [{ value: i.target, label: `Missing frame (${i.target})` }, ...targets]
      : targets

  return (
    <fieldset
      disabled={disabled}
      className="flex flex-col rounded-row bg-sub/60 px-2 pt-0.5 pb-2"
      aria-label={`Interaction ${n}`}
    >
      <PropertyRow label="Trigger">
        <SelectField label={`Trigger ${n}`} value={i.trigger} options={TRIGGERS} onChange={setTrigger} />
        <IconButton size="sm" variant="danger" aria-label={`Remove interaction ${n}`} onClick={onRemove}>
          <TrashIcon size="rail" />
        </IconButton>
      </PropertyRow>
      {i.trigger === 'delay' && (
        <PropertyRow label="After">
          <NumberField
            label={`Delay ${n}`}
            value={i.delay ?? 0}
            unit="ms"
            max={MAX_PROTO_DELAY}
            onCommit={(delay) => onChange({ ...i, delay: Math.round(delay) })}
          />
        </PropertyRow>
      )}
      {i.trigger === 'key' && (
        <PropertyRow label="Key">
          <TextField
            label={`Key ${n}`}
            value={i.key === ' ' ? 'Space' : (i.key ?? '')}
            placeholder="ArrowRight"
            onCommit={(key) => key.trim() && onChange({ ...i, key: key.trim() === 'Space' ? ' ' : key.trim() })}
          />
        </PropertyRow>
      )}
      <PropertyRow label="Action">
        <SelectField label={`Action ${n}`} value={i.action} options={ACTIONS} onChange={setAction} />
      </PropertyRow>
      {leavesFrame && (
        <PropertyRow label="Frame">
          {targetOptions.length ? (
            <SelectField
              label={`Target frame ${n}`}
              value={i.target ?? ''}
              options={targetOptions}
              onChange={(target) => onChange({ ...i, target })}
            />
          ) : (
            <span className="text-caption text-ink-faint">Add another frame first</span>
          )}
        </PropertyRow>
      )}
      {i.action === 'scroll-to' && (
        <PropertyRow label="Element">
          <TextField
            label={`Scroll target ${n}`}
            value={i.target ?? ''}
            placeholder="#pricing"
            onCommit={(target) => target.trim() && onChange({ ...i, target: target.trim() })}
          />
        </PropertyRow>
      )}
      {i.action === 'url' && (
        <PropertyRow label="URL">
          <TextField
            label={`Link ${n}`}
            value={i.target ?? ''}
            placeholder="https://"
            onCommit={(target) => /^https?:\/\/\S+$/i.test(target.trim()) && onChange({ ...i, target: target.trim() })}
          />
        </PropertyRow>
      )}
      {leavesFrame && (
        <PropertyRow label="Motion">
          <SelectField
            label={`Transition ${n}`}
            value={i.transition}
            options={TRANSITIONS}
            onChange={(transition) => onChange({ ...i, transition })}
          />
          {i.transition !== 'instant' && (
            <NumberField
              label={`Duration ${n}`}
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
