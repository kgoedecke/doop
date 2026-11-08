import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import type { ImageModelStatus } from '../lib/api'
import { IMAGE_MODELS, type ImageModelOption, type ImageProvider } from '../../shared/modelMenu'
import { posthog } from '../lib/posthog'
import { useStore } from '../lib/store'
import { useT, type PlainMessageKey } from '../lib/i18n'
import { ConnectionSection } from './ConnectionTable'
import { Pressable } from './ui/pressable'
import { AppIcon } from './ui/brand-mark'
import { CheckIcon } from './ui/icons'
import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'

/** Each provider's tile, as the connections above wear theirs. */
const TILES: Record<ImageProvider, ReactNode> = {
  openai: <AppIcon brand="openai" />,
  gemini: <AppIcon brand="gemini" />,
  ark: <AppIcon brand="seedream" />,
}

/** Why an entry is disabled, phrased as the fix. */
const UNAVAILABLE_HINTS: Record<ImageProvider, PlainMessageKey> = {
  openai: 'models.imageNeedsOpenai',
  gemini: 'models.imageNeedsGemini',
  ark: 'models.imageNeedsArk',
}

/** The registry's blurbs, in the reader's language; an entry added to the
 *  shared registry later shows its English blurb until it gets a key here. */
const BLURBS: Partial<Record<string, PlainMessageKey>> = {
  'gpt-image-2': 'models.imageGptBlurb',
  'gemini-3.1-flash-image': 'models.imageNanoBananaBlurb',
  'seedream-5-0-pro': 'models.imageSeedreamProBlurb',
  'seedream-5-0-lite': 'models.imageSeedreamLiteBlurb',
}

/**
 * Which image model the agents' generate_image tool draws with, as a list in
 * the connections' style: pick a row, the chosen one wears a check. The
 * registry is shared with the server; the server says which entries this
 * user's credentials can actually run, and unavailable ones stay visible but
 * inert, their line saying what to connect.
 */
export function ImageModelCard() {
  const t = useT()
  const [models, setModels] = useState<ImageModelStatus[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  /* availability follows the connected account — re-read when it changes */
  const version = useStore((s) => s.allowanceVersion)
  const refresh = useCallback(() => {
    api.imageModels().then(
      ({ models: next }) => setModels(next),
      () => {},
    )
  }, [])
  useEffect(refresh, [refresh, version])

  if (!models) return null

  const blurbOf = (option: ImageModelOption) => {
    const key = BLURBS[option.id]
    return key ? t(key) : option.blurb
  }

  const pick = async (id: string) => {
    setBusy(true)
    setError('')
    try {
      const { models: next } = await api.setImageModel(id)
      setModels(next)
      posthog.capture('image_model_changed', { model: id })
    } catch (e) {
      const body = (e as { body?: { error?: string } })?.body
      setError(body?.error || (e instanceof Error ? e.message : t('models.failedRetry')))
      refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <ConnectionSection title={t('models.imageModelTitle')} className="mt-7">
      <div role="radiogroup" aria-label={t('models.imageModelTitle')}>
        {IMAGE_MODELS.map((option) => {
          const status = models.find((m) => m.id === option.id)
          const available = !!status?.available
          /* the server names its fallback even when nothing can run it; a check only on one that can */
          const chosen = available && !!status?.selected
          return (
            <Pressable
              key={option.id}
              role="radio"
              aria-checked={chosen}
              disabled={busy || !available}
              onClick={() => void pick(option.id)}
              className="flex w-full items-center gap-[14px] border-b border-line-soft px-4 py-3 text-left last:border-b-0 enabled:hover:bg-sub disabled:cursor-default"
            >
              <span aria-hidden className={cn('flex-none', !available && 'opacity-55')}>
                {TILES[option.provider]}
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn('block truncate text-copy font-medium', !available && 'text-ink-soft')}>
                  {option.name}
                </span>
                <span className="block truncate text-label text-ink-faint">
                  {available ? blurbOf(option) : t(UNAVAILABLE_HINTS[option.provider])}
                </span>
              </span>
              {chosen && <CheckIcon size={16} strokeWidth={2.2} className="flex-none text-brand" aria-hidden />}
            </Pressable>
          )
        })}
      </div>
      {error && <p className="border-t border-line-soft px-4 py-3 text-body text-accent-ink">{error}</p>}
    </ConnectionSection>
  )
}
