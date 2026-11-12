import { useState } from 'react'
import type { RegistryPreview } from '../../shared/shadcnRegistry'
import { api, ApiError } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { useStore } from '@/lib/store'
import { ImportStepFooter, ImportStepHeader } from './ImportSources'
import { BlocksIcon } from './ui/icons'
import { Button } from './ui/button'
import { CheckboxCard } from './ui/checkbox'
import { Field } from './ui/field'
import { Input } from './ui/input'

export function RegistryImportSection({
  canvasId,
  busy,
  onBusy,
  onBack,
  onDone,
}: {
  canvasId: string
  busy: 'discovering' | 'importing' | null
  onBusy: (value: 'discovering' | 'importing' | null) => void
  onBack: () => void
  onDone: (frameIds: string[], failedCount: number) => void
}) {
  const t = useT()
  const [url, setUrl] = useState('')
  const [preview, setPreview] = useState<RegistryPreview | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  async function run() {
    if (busy || !url.trim() || (preview && !selected.size)) return
    onBusy(preview ? 'importing' : 'discovering')
    setError(null)
    try {
      if (preview) {
        const result = await api.importRegistry(canvasId, preview.url, [...selected])
        for (const component of result.components) useStore.getState().setComponentLocal(component.id, component)
        useStore.getState().setLayersTab('components')
        onDone(
          result.components.flatMap((component) => (component.mainFrameId ? [component.mainFrameId] : [])),
          result.failures.length,
        )
      } else {
        const found = await api.previewRegistry(canvasId, url.trim())
        setPreview(found)
        setSelected(new Set(found.items.length === 1 ? [found.items[0]!.name] : []))
      }
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? String(caught.body.error ?? t('canvas.registryFailed'))
          : caught instanceof Error
            ? caught.message
            : t('canvas.registryFailed'),
      )
    } finally {
      onBusy(null)
    }
  }

  return (
    <>
      <ImportStepHeader
        icon={<BlocksIcon className="size-10" />}
        title={preview?.name ?? t('panels.importShadcn')}
        lede={t('canvas.registryLede')}
      />
      {preview ? (
        <div className="mt-5 max-h-80 overflow-y-auto" aria-label={t('canvas.registryItems')}>
          {preview.items.map((item) => (
            <CheckboxCard
              key={item.name}
              title={item.title}
              description={item.description || item.type}
              checked={selected.has(item.name)}
              disabled={!!busy || (!selected.has(item.name) && selected.size >= 20)}
              onChange={(checked) =>
                setSelected((current) => {
                  const next = new Set(current)
                  if (checked) next.add(item.name)
                  else next.delete(item.name)
                  return next
                })
              }
            />
          ))}
        </div>
      ) : (
        <Field className="mt-5" label={t('canvas.registryUrl')} labelVariant="form" htmlFor="registry-url">
          <Input
            id="registry-url"
            autoFocus
            variant="well"
            inputSize="lg"
            placeholder="https://example.com/r/registry.json"
            value={url}
            disabled={!!busy}
            onChange={(event) => {
              setUrl(event.target.value)
              setError(null)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void run()
            }}
          />
        </Field>
      )}
      {error && (
        <p className="mt-3 text-body text-destructive" role="alert">
          {error}
        </p>
      )}
      <ImportStepFooter
        note={t('canvas.registryNote')}
        backDisabled={!!busy}
        onBack={() => {
          if (preview) {
            setPreview(null)
            setError(null)
          } else onBack()
        }}
      >
        <Button disabled={!!busy || !url.trim() || (!!preview && !selected.size)} onClick={() => void run()}>
          {busy
            ? t('canvas.importing')
            : preview
              ? t('canvas.registryImport', { count: selected.size })
              : t('canvas.registryReview')}
        </Button>
      </ImportStepFooter>
    </>
  )
}
