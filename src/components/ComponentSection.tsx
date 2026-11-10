import { useMemo, useState } from 'react'
import { BIND_ATTR, SLOT_ATTR, type ComponentProp } from '../../shared/components'
import type { Frame } from '../../shared/types'
import { api } from '../lib/api'
import {
  changeInstance,
  componentContextOf,
  exposeOnMain,
  templateValue,
  type ComponentContext,
} from '../lib/components'
import { useT } from '../lib/i18n'
import { isLayerLocked } from '../lib/layerEdits'
import { useStore } from '../lib/store'
import { Button } from './ui/button'
import { ComponentIcon } from './ui/icons'
import { Input } from './ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Switch } from './ui/switch'
import { Textarea } from './ui/textarea'

/** The Design panel's head when the selection belongs to a component. */
export function ComponentSection({ frame, selector }: { frame: Frame; selector: string }) {
  const t = useT()
  const defs = useStore((s) => s.canvas?.components)
  const context = useMemo(() => componentContextOf(frame.html, selector, defs ?? []), [frame.html, selector, defs])
  if (!context) return null
  return (
    <section
      data-slot="component-section"
      className="mb-3 flex flex-col gap-2.5 border-b border-line-soft px-3.5 pt-1 pb-3.5"
    >
      <header className="flex min-w-0 items-center gap-1.5 text-body font-medium text-ink">
        <ComponentIcon size="rail" className="flex-none text-brand" />
        <span className="truncate">{context.def.name}</span>
        <span className="ml-auto flex-none text-caption font-normal text-ink-faint">
          {context.kind === 'main' ? t('components.main') : t('components.instance')}
        </span>
      </header>
      {context.kind === 'main' ? (
        <MainControls key={context.def.id} frame={frame} context={context} />
      ) : (
        <InstanceControls frame={frame} context={context} />
      )}
    </section>
  )
}

function InstanceControls({
  frame,
  context,
}: {
  frame: Frame
  context: Extract<ComponentContext, { kind: 'instance' }>
}) {
  const { def, instanceId, isRoot, rootSelector, selector } = context
  const locked = isLayerLocked(frame, selector)
  const t = useT()
  return (
    <>
      {!isRoot && (
        <Button
          size="inline"
          variant="link"
          onClick={() => useStore.getState().setSelectedElement({ frameId: frame.id, selector: rootSelector })}
        >
          {t('components.selectInstance')}
        </Button>
      )}
      {def.props.map((prop) => (
        <PropField
          key={`${instanceId}:${prop.name}`}
          prop={prop}
          disabled={locked}
          value={context.props[prop.name]}
          fallback={prop.default ?? (prop.type === 'boolean' ? 'true' : templateValue(def, prop.name))}
          onChange={(value) => void changeInstance(frame, { instanceId, props: { [prop.name]: value } })}
        />
      ))}
    </>
  )
}

function PropField({
  prop,
  value,
  fallback,
  disabled,
  onChange,
}: {
  prop: ComponentProp
  disabled: boolean
  value: string | undefined
  fallback: string
  onChange: (value: string) => void
}) {
  const shown = value ?? fallback
  const [draft, setDraft] = useState(shown)
  const [seen, setSeen] = useState(shown)
  if (seen !== shown) {
    setSeen(shown)
    setDraft(shown)
  }
  const label = <span className="text-caption text-ink-soft">{prop.name}</span>
  if (prop.type === 'boolean') {
    return (
      <label className="flex items-center justify-between gap-2">
        {label}
        <Switch
          size="sm"
          disabled={disabled}
          checked={shown !== 'false'}
          onCheckedChange={(checked) => onChange(checked ? 'true' : 'false')}
          aria-label={prop.name}
        />
      </label>
    )
  }
  if (prop.type === 'enum') {
    return (
      <label className="flex flex-col gap-1">
        {label}
        <Select value={shown} disabled={disabled} onValueChange={onChange}>
          <SelectTrigger size="sm" aria-label={prop.name}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(prop.options ?? []).map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
    )
  }
  const commit = () => {
    if (draft !== shown) onChange(draft)
  }
  return (
    <label className="flex flex-col gap-1">
      {label}
      <Input
        value={draft}
        disabled={disabled}
        aria-label={prop.name}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
        }}
      />
    </label>
  )
}

function MainControls({ frame, context }: { frame: Frame; context: Extract<ComponentContext, { kind: 'main' }> }) {
  const { def, isRoot, selector } = context
  const t = useT()
  const locked = isLayerLocked(frame, selector)
  const [description, setDescription] = useState(def.description)
  /* a collaborator's or agent's change to the description takes the field
     over, so a blur here never writes the older text back over it */
  const [seen, setSeen] = useState(def.description)
  if (seen !== def.description) {
    setSeen(def.description)
    setDescription(def.description)
  }
  const instances = useStore(
    (s) =>
      s.canvas?.frames.reduce((total, f) => total + (f.html.split(` data-doop-instance="${def.id}"`).length - 1), 0) ??
      0,
  )
  const save = () => {
    if (description === def.description) return
    api
      .updateComponent(frame.canvasId, def.id, { description })
      .catch(() => useStore.getState().pushNotice(t('components.descriptionFailed')))
  }
  return (
    <>
      <p className="text-caption text-ink-soft">
        {instances === 0 ? t('components.noInstances') : t('components.reachesInstances', { count: instances })}
      </p>
      <Textarea
        value={description}
        placeholder={t('components.descriptionPlaceholder')}
        aria-label={t('components.descriptionAria')}
        rows={2}
        onChange={(event) => setDescription(event.target.value)}
        onBlur={save}
      />
      {def.props.length > 0 && (
        <p className="text-caption text-ink-soft">
          {t('components.propsLabel')}{' '}
          <span className="font-mono text-ink">{def.props.map((prop) => prop.name).join(', ')}</span>
        </p>
      )}
      {!isRoot && (
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" disabled={locked} onClick={() => exposeOnMain(frame, selector, BIND_ATTR)}>
            {t('components.makeProp')}
          </Button>
          <Button size="sm" disabled={locked} onClick={() => exposeOnMain(frame, selector, SLOT_ATTR)}>
            {t('components.makeSlot')}
          </Button>
        </div>
      )}
    </>
  )
}
