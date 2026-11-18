import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import type { ImageModelStatus } from '../lib/api'
import { IMAGE_MODELS, type ImageModelOption, type ImageProvider } from '../../shared/modelMenu'
import { posthog } from '../lib/posthog'
import { useStore } from '../lib/store'
import { useT, type PlainMessageKey } from '../lib/i18n'
import { ConnectionSection, ModelSelect } from './ConnectionTable'
import { Pressable } from './ui/pressable'
import { AppIcon } from './ui/brand-mark'
import { CheckIcon } from './ui/icons'
import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'

/** Each provider's tile, as the connections above wear theirs. */
const TILES: Record<ImageProvider, ReactNode> = {
  openai: <AppIcon brand="openai" />,
  'openai-api': <AppIcon brand="openai" />,
  gemini: <AppIcon brand="gemini" />,
  ark: <AppIcon brand="seedream" />,
}

/** Why an entry is disabled, phrased as the fix. */
const UNAVAILABLE_HINTS: Record<ImageProvider, PlainMessageKey> = {
  openai: 'models.imageNeedsOpenai',
  'openai-api': 'models.imageNeedsOpenaiKey',
  gemini: 'models.imageNeedsGemini',
  ark: 'models.imageNeedsArk',
}

/** The registry's blurbs, in the reader's language; an entry added to the
 *  shared registry later shows its English blurb until it gets a key here. */
const BLURBS: Partial<Record<string, PlainMessageKey>> = {
  'gpt-image-2': 'models.imageGptBlurb',
  'gpt-image-2.5-sunburst': 'models.imageGptSunburstBlurb',
  'gpt-image-2.5-flare': 'models.imageGptFlareBlurb',
  'gpt-image-2.6-sunburst': 'models.imageGpt26SunburstBlurb',
  'gpt-image-2.6-flare': 'models.imageGpt26FlareBlurb',
  'chatgpt-image-latest': 'models.imageChatgptLatestBlurb',
  'gpt-image-1.5': 'models.imageGpt15Blurb',
  'gpt-image-1-mini': 'models.imageGpt1MiniBlurb',
  'gemini-3.1-flash-image': 'models.imageNanoBananaBlurb',
  'seedream-5-0-pro': 'models.imageSeedreamProBlurb',
  'seedream-5-0-lite': 'models.imageSeedreamLiteBlurb',
}

/** The rows' names, in the reader's language; a family added later shows
 *  its registry name until it gets a key here. */
const FAMILY_NAMES: Partial<Record<string, PlainMessageKey>> = {
  'GPT Image via ChatGPT subscription': 'models.imageFamilyChatgpt',
  'GPT Image API': 'models.imageFamilyApi',
}

/** The registry as rows: entries of one family (the GPT Image API models)
 *  share a row, the model picked from its dropdown as a connection's is. */
function imageModelRows(): ImageModelOption[][] {
  const rows: ImageModelOption[][] = []
  for (const option of IMAGE_MODELS) {
    const row = option.family ? rows.find((r) => r[0]?.family === option.family) : undefined
    if (row) row.push(option)
    else rows.push([option])
  }
  return rows
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
        {imageModelRows().map((variants) => {
          const statusOf = (id: string) => models.find((m) => m.id === id)
          /* the row shows its picked model, else its first; one family shares a provider */
          const option = variants.find((v) => statusOf(v.id)?.selected) ?? variants[0]!
          const available = !!statusOf(option.id)?.available
          /* the server names its fallback even when nothing can run it; a check only on one that can */
          const chosen = available && !!statusOf(option.id)?.selected
          const familyKey = option.family ? FAMILY_NAMES[option.family] : undefined
          const name = familyKey ? t(familyKey) : (option.family ?? option.name)
          return (
            <div
              key={option.family ?? option.id}
              className="flex w-full items-center gap-[14px] border-b border-line-soft px-4 py-3 last:border-b-0 max-md:flex-wrap max-md:gap-y-2"
            >
              <Pressable
                role="radio"
                aria-checked={chosen}
                disabled={busy || !available}
                onClick={() => void pick(option.id)}
                className="flex min-w-0 flex-1 items-center gap-[14px] text-left disabled:cursor-default"
              >
                <span aria-hidden className={cn('flex-none', !available && 'opacity-55')}>
                  {TILES[option.provider]}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cn('block truncate text-copy font-medium', !available && 'text-ink-soft')}>
                    {name}
                  </span>
                  <span className="block truncate text-label text-ink-faint">
                    {available ? blurbOf(option) : t(UNAVAILABLE_HINTS[option.provider])}
                  </span>
                </span>
              </Pressable>
              {variants.length > 1 && (
                <div className="w-[260px] flex-none max-md:order-last max-md:w-full">
                  <ModelSelect
                    name={name}
                    models={variants.map((v) => ({ id: v.id, name: v.name, blurb: blurbOf(v) }))}
                    model={option.id}
                    onModel={(id) => void pick(id)}
                    disabled={busy || !available}
                  />
                </div>
              )}
              {chosen && <CheckIcon size={16} strokeWidth={2.2} className="flex-none text-brand" aria-hidden />}
            </div>
          )
        })}
      </div>
      {error && <p className="border-t border-line-soft px-4 py-3 text-body text-accent-ink">{error}</p>}
    </ConnectionSection>
  )
}
