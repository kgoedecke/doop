import { useId, useRef, useState, type ReactNode } from 'react'
import type { Frame } from '../../shared/types'
import { PRO_UPLOAD_BYTES } from '../../shared/billing'
import { api, errorMessage } from '../lib/api'
import { replaceElementImage, type ElementInfo, type StylePatch } from '../lib/frameBridge'
import { isLayerLocked } from '../lib/layerEdits'
import { useStore } from '../lib/store'
import { Button } from './ui/button'
import { ArrowRightIcon, UploadIcon, XIcon } from './ui/icons'
import { Input } from './ui/input'
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from './ui/popover'
import { PropertyRow, SelectField } from './ui/property-field'
import { useT, type PlainMessageKey, type Translate } from '../lib/i18n'
import { cn } from '../lib/utils'

type ImageInfo = NonNullable<ElementInfo['image']>

const SIZES: { value: string; label: PlainMessageKey }[] = [
  { value: 'cover', label: 'inspector.imageSizeFill' },
  { value: 'contain', label: 'inspector.imageSizeFit' },
  { value: 'fill', label: 'inspector.imageSizeStretch' },
  { value: 'none', label: 'inspector.imageSizeOriginal' },
]

function sizeMode(image: ImageInfo) {
  if (image.kind === 'img') return image.size
  if (image.repeat !== 'no-repeat') return 'tile'
  if (image.size === '100% 100%') return 'fill'
  if (image.size === 'auto' || image.size === 'auto auto') return 'none'
  if (image.size === 'cover' || image.size === 'contain') return image.size
  return 'custom'
}

/** Verify pasted URLs before replacing the current, working image. */
async function checkImageUrl(value: string, t: Translate): Promise<string> {
  let url: URL
  try {
    url = new URL(value, location.origin)
  } catch {
    throw new Error(t('inspector.imageUrlInvalid'))
  }
  if (!['https:', 'http:'].includes(url.protocol) && !/^data:image\//i.test(url.href)) {
    throw new Error(t('inspector.imageUrlProtocol'))
  }
  await new Promise<void>((resolve, reject) => {
    const preview = new Image()
    const finish = (error?: Error) => {
      window.clearTimeout(timer)
      preview.onload = null
      preview.onerror = null
      if (error) reject(error)
      else resolve()
    }
    const timer = window.setTimeout(() => finish(new Error(t('inspector.imageUrlTimeout'))), 10000)
    preview.onload = () => finish()
    preview.onerror = () => finish(new Error(t('inspector.imageUrlLoadFailed')))
    preview.src = url.href
  })
  return url.href
}

export function ImageFill({
  frame,
  selector,
  image,
  apply,
}: {
  frame: Frame
  selector: string
  image: ImageInfo
  apply: (styles: StylePatch) => void
}) {
  const t = useT()
  const locked = isLayerLocked(frame, selector)
  const mode = sizeMode(image)
  const sizes = [
    ...SIZES,
    image.kind === 'img'
      ? { value: 'scale-down', label: 'inspector.imageSizeScaleDown' as const }
      : { value: 'tile', label: 'inspector.imageSizeTile' as const },
    ...(mode === 'custom' ? [{ value: 'custom', label: 'inspector.imageSizeCustom' as const }] : []),
  ].map(({ value, label }) => ({ value, label: t(label) }))

  async function replace(resolve: () => Promise<string>) {
    const original = useStore.getState().canvas?.frames.find((f) => f.id === frame.id)
    if (!original || isLayerLocked(original, selector)) return
    const url = await resolve()
    const current = useStore.getState().canvas?.frames.find((f) => f.id === frame.id)
    // A path selector can point to a different layer after a remote edit.
    if (!current || current.html !== original.html || isLayerLocked(current, selector)) {
      throw new Error(t('inspector.imageDesignChanged'))
    }
    if (!(await replaceElementImage(frame.id, selector, image, url))) {
      throw new Error(t('inspector.imageNotEditable'))
    }
  }

  function setSize(value: string) {
    if (value === 'custom' || locked) return
    if (image.kind === 'img') apply({ 'object-fit': value })
    else
      apply({
        'background-size': value === 'fill' ? '100% 100%' : value === 'none' || value === 'tile' ? 'auto' : value,
        'background-repeat': value === 'tile' ? 'repeat' : 'no-repeat',
        'background-position': 'center',
      })
  }

  return (
    <div className="mb-1.5">
      <ImagePicker canvasId={frame.canvasId} src={image.src} disabled={locked} onPick={replace}>
        <PropertyRow label={t('inspector.sizing')}>
          <SelectField label={t('inspector.imageSizing')} value={mode} options={sizes} onChange={setSize} />
        </PropertyRow>
      </ImagePicker>
    </div>
  )
}

/** The image popover: a URL field, a preview that uploads on click, and the caller's own settings
 *  under it. `onPick` gets a resolver that uploads or checks the source, so the caller can note
 *  what the design looked like before the slow part starts; whatever it throws is shown. */
export function ImagePicker({
  canvasId,
  src,
  label,
  disabled = false,
  className,
  onPick,
  onClear,
  children,
}: {
  canvasId: string
  src: string
  /** the popover's title and the trigger's name, "Image" by default */
  label?: string
  disabled?: boolean
  className?: string
  onPick: (resolve: () => Promise<string>) => Promise<void>
  /** offers Remove image while there is one */
  onClear?: () => void
  children?: ReactNode
}) {
  const t = useT()
  const title = label ?? t('inspector.image')
  const input = useRef<HTMLInputElement>(null)
  const urlId = useId()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<'upload' | 'url' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState(src)
  const [seen, setSeen] = useState(src)
  if (seen !== src) {
    setSeen(src)
    setDraft(src)
  }

  async function pick(source: File | string) {
    if (busy || disabled) return
    setError(null)
    if (typeof source !== 'string' && source.size > PRO_UPLOAD_BYTES) {
      setError(t('inspector.imageTooLarge'))
      return
    }
    setBusy(typeof source === 'string' ? 'url' : 'upload')
    try {
      let url = ''
      await onPick(async () => {
        url =
          typeof source === 'string' ? await checkImageUrl(source, t) : (await api.uploadAsset(canvasId, source)).url
        return url
      })
      if (url) setDraft(url)
    } catch (err) {
      const message = errorMessage(err, err instanceof Error ? err.message : t('inspector.imageReplaceFailed'))
      setError(message)
      useStore.getState().pushNotice(message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <Input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
        aria-label={t('inspector.chooseReplacementImage')}
        className="hidden"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ''
          if (file) void pick(file)
        }}
      />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="bare"
            className={cn(
              'h-8 w-full justify-start gap-2 rounded-row bg-sub px-1.5 text-label font-normal text-ink hover:bg-paper-deep data-[state=open]:bg-paper-deep',
              className,
            )}
            aria-label={label ?? t('inspector.imageFill')}
            title={t('inspector.editImageFill')}
            disabled={disabled}
          >
            <span className="size-5 flex-none overflow-hidden rounded-tag bg-surface">
              {src && <img src={src} alt="" className="size-full object-cover" />}
            </span>
            <span className="truncate">{t('inspector.image')}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent
          side="left"
          align="end"
          sideOffset={24}
          aria-label={t('inspector.imageFillSettings')}
          onEscapeKeyDown={(event) => event.stopPropagation()}
        >
          <div className="flex h-10 items-center justify-between border-b border-line-soft px-3">
            <span className="truncate text-body font-medium">{title}</span>
            <PopoverClose asChild>
              <Button
                variant="bare"
                size="icon-sm"
                className="size-6 text-ink-faint"
                aria-label={t('inspector.closeImageSettings')}
              >
                <XIcon size="rail" />
              </Button>
            </PopoverClose>
          </div>
          <div className="space-y-3 p-3">
            <form
              onSubmit={(event) => {
                event.preventDefault()
                if (draft.trim() && draft.trim() !== src) void pick(draft.trim())
              }}
            >
              <label htmlFor={urlId} className="mb-1.5 block text-caption text-ink-soft">
                {t('inspector.imageUrl')}
              </label>
              <div className="flex items-center gap-1.5">
                <Input
                  id={urlId}
                  inputSize="sm"
                  aria-label={t('inspector.imageUrl')}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  disabled={!!busy || disabled}
                  spellCheck={false}
                  placeholder="https://…"
                />
                <Button
                  type="submit"
                  variant="bare"
                  size="icon-sm"
                  className="size-8 flex-none rounded-row bg-sub"
                  aria-label={t('inspector.applyImageUrl')}
                  title={t('inspector.applyImageUrl')}
                  disabled={!!busy || disabled || !draft.trim() || draft.trim() === src}
                >
                  <ArrowRightIcon size="rail" />
                </Button>
              </div>
            </form>
            <Button
              variant="bare"
              className="group relative flex h-44 w-full overflow-hidden rounded-control bg-sub p-0"
              style={{
                backgroundImage:
                  'conic-gradient(var(--sub) 25%, var(--surface) 0 50%, var(--sub) 0 75%, var(--surface) 0)',
                backgroundSize: '16px 16px',
              }}
              aria-label={t('inspector.uploadImage')}
              aria-busy={!!busy || undefined}
              disabled={!!busy || disabled}
              onClick={() => input.current?.click()}
            >
              {src && <img src={src} alt={t('inspector.currentImage')} className="size-full object-contain" />}
              <span
                className={`absolute inset-0 flex items-center justify-center bg-ink/15 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 [@media(hover:none)]:opacity-100 ${busy ? 'opacity-100' : 'opacity-0'}`}
              >
                <span className="flex items-center gap-1.5 rounded-row bg-surface px-3 py-2 text-label font-medium text-ink shadow-pop">
                  <UploadIcon size="rail" />
                  {busy === 'upload'
                    ? t('inspector.uploading')
                    : busy === 'url'
                      ? t('inspector.loading')
                      : t('inspector.uploadImage')}
                </span>
              </span>
            </Button>
            {onClear && src && (
              <Button
                variant="bare"
                className="h-7 w-full rounded-row bg-sub text-label font-normal text-ink hover:bg-paper-deep"
                disabled={!!busy || disabled}
                onClick={() => {
                  onClear()
                  setOpen(false)
                }}
              >
                {t('inspector.removeImage')}
              </Button>
            )}
            {children && (
              <fieldset disabled={!!busy || disabled} className="disabled:opacity-50">
                {children}
              </fieldset>
            )}
            {error && (
              <p role="alert" className="text-caption text-accent-ink">
                {error}
              </p>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </>
  )
}
