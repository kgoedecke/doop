import { useMemo, useState } from 'react'
import { BIND_ATTR, SLOT_ATTR, isDeleted, type ComponentProp } from '../../shared/components'
import type { Frame } from '../../shared/types'
import { api } from '../lib/api'
import {
  changeInstance,
  componentContextOf,
  exposeOnMain,
  restoreDeletedComponent,
  templateValue,
  type ComponentContext,
} from '../lib/components'
import { useT } from '../lib/i18n'
import { isLayerLocked } from '../lib/layerEdits'
import { canEditOpenCanvas, useStore } from '../lib/store'
import { Button } from './ui/button'
import { ComponentIcon, InstanceIcon } from './ui/icons'
import { ImagePicker } from './ImageFill'
import { PropertyRow, SelectField, TextField } from './ui/property-field'
import { Switch } from './ui/switch'
import { Textarea } from './ui/textarea'

/** The Design panel's head when the selection belongs to a component. */
export function ComponentSection({ frame, selector }: { frame: Frame; selector: string }) {
  const t = useT()
  const defs = useStore((s) => s.canvas?.components)
  const context = useMemo(() => componentContextOf(frame.html, selector, defs ?? []), [frame.html, selector, defs])
  if (!context) return null
  return (
    <section data-slot="component-section" className="flex flex-col border-b border-line-soft px-3 pt-3 pb-2.5">
      <header className="mb-[5px] flex min-h-5 min-w-0 items-center gap-1.5 text-body font-medium text-ink">
        {context.kind === 'main' ? (
          <ComponentIcon size="rail" className="flex-none text-brand" data-component-icon="main" />
        ) : (
          <InstanceIcon size="rail" className="flex-none text-brand" data-component-icon="instance" />
        )}
        <span className="truncate">{context.def.name}</span>
        <span className="ml-auto flex-none text-caption font-normal text-ink-faint">
          {context.kind === 'main' ? t('components.main') : t('components.instance')}
        </span>
      </header>
      {context.kind === 'main' ? (
        <MainControls key={context.def.id} frame={frame} context={context} />
      ) : isDeleted(context.def) ? (
        <DeletedInstanceControls frame={frame} context={context} />
      ) : (
        <InstanceControls frame={frame} context={context} />
      )}
    </section>
  )
}

/** An instance whose component was deleted: it keeps its look and follows nothing, until the
 *  component is restored (every instance is linked again) or this one is detached. */
function DeletedInstanceControls({
  frame,
  context,
}: {
  frame: Frame
  context: Extract<ComponentContext, { kind: 'instance' }>
}) {
  const { def, instanceId, rootSelector } = context
  const t = useT()
  const canEdit = useStore(canEditOpenCanvas)
  const locked = isLayerLocked(frame, rootSelector)
  return (
    <div data-slot="deleted-component" className="flex flex-col gap-2">
      <p className="text-caption font-medium text-ink">{t('components.mainDeleted')}</p>
      <p className="text-caption text-ink-soft">{t('components.mainDeletedHint')}</p>
      {canEdit && (
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" onClick={() => void restoreDeletedComponent(def)}>
            {t('components.restoreComponent')}
          </Button>
          <Button
            size="sm"
            disabled={locked}
            onClick={() => {
              const current = useStore.getState().canvas?.frames.find((f) => f.id === frame.id)
              if (current) void changeInstance(current, { instanceId, detach: true })
            }}
          >
            {t('components.detach')}
          </Button>
        </div>
      )}
    </div>
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
          className="self-start"
          onClick={() => useStore.getState().setSelectedElement({ frameId: frame.id, selector: rootSelector })}
        >
          {t('components.selectInstance')}
        </Button>
      )}
      {def.props.map((prop) => (
        <PropField
          key={`${instanceId}:${prop.name}`}
          canvasId={frame.canvasId}
          prop={prop}
          disabled={locked}
          value={context.props[prop.name]}
          fallback={prop.default ?? (prop.type === 'boolean' ? 'true' : templateValue(def, prop.name))}
          onChange={(value) => {
            /* the frame as it is now: an image pick waits on an upload, and undo's baseline
               and the lock check must not be the design from before it */
            const current = useStore.getState().canvas?.frames.find((f) => f.id === frame.id)
            if (!current || isLayerLocked(current, selector)) return
            void changeInstance(current, { instanceId, props: { [prop.name]: value } })
          }}
        />
      ))}
    </>
  )
}

function PropField({
  canvasId,
  prop,
  value,
  fallback,
  disabled,
  onChange,
}: {
  canvasId: string
  prop: ComponentProp
  disabled: boolean
  value: string | undefined
  fallback: string
  onChange: (value: string) => void
}) {
  const shown = value ?? fallback
  return <PropertyRow label={prop.name}>{propControl()}</PropertyRow>

  function propControl() {
    switch (prop.type) {
      case 'boolean':
        return (
          <Switch
            size="sm"
            className="my-auto"
            disabled={disabled}
            checked={shown !== 'false'}
            onCheckedChange={(checked) => onChange(checked ? 'true' : 'false')}
            aria-label={prop.name}
          />
        )
      case 'enum':
        return (
          <SelectField
            label={prop.name}
            value={shown}
            disabled={disabled}
            options={(prop.options ?? []).map((option) => ({ value: option, label: option }))}
            onChange={onChange}
          />
        )
      case 'image':
        return (
          <ImagePicker
            canvasId={canvasId}
            src={shown}
            label={prop.name}
            disabled={disabled}
            className="h-[26px] min-w-0 flex-1 gap-1.5 rounded-row px-[3px] text-caption"
            onPick={async (resolve) => {
              const url = await resolve()
              if (url !== shown) onChange(url)
            }}
            onClear={() => onChange('')}
          />
        )
      case 'text':
      case 'link':
        return (
          <TextField
            label={prop.name}
            value={shown}
            disabled={disabled}
            className={prop.type === 'text' ? 'font-sans' : undefined}
            placeholder={prop.type === 'link' ? 'https://…' : undefined}
            onCommit={onChange}
          />
        )
    }
  }
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
    <div className="flex flex-col gap-2.5">
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
    </div>
  )
}
