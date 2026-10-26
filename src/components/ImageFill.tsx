import { useId, useRef, useState } from 'react'
import type { Frame } from '../../shared/types'
import { api, errorMessage } from '../lib/api'
import { replaceElementImage, type ElementInfo, type StylePatch } from '../lib/frameBridge'
import { isLayerLocked } from '../lib/layerEdits'
import { useStore } from '../lib/store'
import { Button } from './ui/button'
import { ArrowRightIcon, UploadIcon, XIcon } from './ui/icons'
import { Input } from './ui/input'
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from './ui/popover'
import { PropertyRow, SelectField } from './ui/property-field'

type ImageInfo = NonNullable<ElementInfo['image']>

const SIZES = [
  { value: 'cover', label: 'Fill' },
  { value: 'contain', label: 'Fit' },
  { value: 'fill', label: 'Stretch' },
  { value: 'none', label: 'Original size' },
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
async function checkImageUrl(value: string): Promise<string> {
  let url: URL
  try {
    url = new URL(value, location.origin)
  } catch {
    throw new Error('Enter a valid image URL.')
  }
  if (!['https:', 'http:'].includes(url.protocol) && !/^data:image\//i.test(url.href)) {
    throw new Error('Use an http or https image URL.')
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
    const timer = window.setTimeout(() => finish(new Error('Image took too long to load. Try another URL.')), 10000)
    preview.onload = () => finish()
    preview.onerror = () => finish(new Error('Couldn’t load that image. Check the URL and try again.'))
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
  const input = useRef<HTMLInputElement>(null)
  const urlId = useId()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<'upload' | 'url' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState(image.src)
  const [seen, setSeen] = useState(image.src)
  if (seen !== image.src) {
    setSeen(image.src)
    setDraft(image.src)
  }
  const locked = isLayerLocked(frame, selector)
  const mode = sizeMode(image)
  const sizes = [
    ...SIZES,
    image.kind === 'img' ? { value: 'scale-down', label: 'Scale down' } : { value: 'tile', label: 'Tile' },
    ...(mode === 'custom' ? [{ value: 'custom', label: 'Custom' }] : []),
  ]

  async function replace(source: File | string) {
    if (busy) return
    const original = useStore.getState().canvas?.frames.find((f) => f.id === frame.id)
    if (!original || isLayerLocked(original, selector)) return
    setError(null)
    if (typeof source !== 'string' && source.size > 5 * 1024 * 1024) {
      setError('Choose an image smaller than 5 MB.')
      return
    }
    setBusy(typeof source === 'string' ? 'url' : 'upload')
    try {
      const url =
        typeof source === 'string' ? await checkImageUrl(source) : (await api.uploadAsset(frame.canvasId, source)).url
      const current = useStore.getState().canvas?.frames.find((f) => f.id === frame.id)
      // A path selector can point to a different layer after a remote edit.
      if (!current || current.html !== original.html || isLayerLocked(current, selector)) {
        throw new Error('The design changed. Select the image and try again.')
      }
      if (!(await replaceElementImage(frame.id, selector, image, url))) {
        throw new Error('The image is no longer editable. Select it and try again.')
      }
      setDraft(url)
    } catch (err) {
      const message = errorMessage(
        err,
        err instanceof Error ? err.message : 'Couldn’t replace the image. Please try again.',
      )
      setError(message)
      useStore.getState().pushNotice(message)
    } finally {
      setBusy(null)
    }
  }

  function setSize(value: string) {
    if (value === 'custom' || locked || busy) return
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
      <Input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
        aria-label="Choose replacement image"
        className="hidden"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ''
          if (file) void replace(file)
        }}
      />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="bare"
            className="h-8 w-full justify-start gap-2 rounded-row bg-sub px-1.5 text-label font-normal text-ink hover:bg-paper-deep data-[state=open]:bg-paper-deep"
            aria-label="Image fill"
            title="Edit image fill"
            disabled={locked}
          >
            <span className="size-5 flex-none overflow-hidden rounded-tag bg-surface">
              {image.src && <img src={image.src} alt="" className="size-full object-cover" />}
            </span>
            Image
          </Button>
        </PopoverTrigger>
        <PopoverContent
          side="left"
          align="end"
          sideOffset={24}
          aria-label="Image fill settings"
          onEscapeKeyDown={(event) => event.stopPropagation()}
        >
          <div className="flex h-10 items-center justify-between border-b border-line-soft px-3">
            <span className="text-body font-medium">Image</span>
            <PopoverClose asChild>
              <Button variant="bare" size="icon-sm" className="size-6 text-ink-faint" aria-label="Close image settings">
                <XIcon size="rail" />
              </Button>
            </PopoverClose>
          </div>
          <div className="space-y-3 p-3">
            <form
              onSubmit={(event) => {
                event.preventDefault()
                if (draft.trim() && draft.trim() !== image.src) void replace(draft.trim())
              }}
            >
              <label htmlFor={urlId} className="mb-1.5 block text-caption text-ink-soft">
                Image URL
              </label>
              <div className="flex items-center gap-1.5">
                <Input
                  id={urlId}
                  inputSize="sm"
                  aria-label="Image URL"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  disabled={!!busy || locked}
                  spellCheck={false}
                  placeholder="https://…"
                />
                <Button
                  type="submit"
                  variant="bare"
                  size="icon-sm"
                  className="size-8 flex-none rounded-row bg-sub"
                  aria-label="Apply image URL"
                  title="Apply image URL"
                  disabled={!!busy || locked || !draft.trim() || draft.trim() === image.src}
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
              aria-label="Upload image"
              aria-busy={!!busy || undefined}
              disabled={!!busy || locked}
              onClick={() => input.current?.click()}
            >
              {image.src && <img src={image.src} alt="Current image" className="size-full object-contain" />}
              <span
                className={`absolute inset-0 flex items-center justify-center bg-ink/15 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 [@media(hover:none)]:opacity-100 ${busy ? 'opacity-100' : 'opacity-0'}`}
              >
                <span className="flex items-center gap-1.5 rounded-row bg-surface px-3 py-2 text-label font-medium text-ink shadow-pop">
                  <UploadIcon size="rail" />
                  {busy === 'upload' ? 'Uploading…' : busy === 'url' ? 'Loading…' : 'Upload image'}
                </span>
              </span>
            </Button>
            <fieldset disabled={!!busy || locked} className="disabled:opacity-50">
              <PropertyRow label="Sizing">
                <SelectField label="Image sizing" value={mode} options={sizes} onChange={setSize} />
              </PropertyRow>
            </fieldset>
            {error && (
              <p role="alert" className="text-caption text-accent-ink">
                {error}
              </p>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
