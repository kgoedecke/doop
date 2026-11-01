import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import type { ImageModelStatus } from '../lib/api'
import { IMAGE_MODELS, type ImageModelOption, type ImageProvider } from '../../shared/modelMenu'
import { posthog } from '../lib/posthog'
import { useStore } from '../lib/store'
import { useT, type PlainMessageKey } from '../lib/i18n'
import { CardDescription, CardHeader, CardTitle, SettingsCard } from './ui/card'
import { ToggleChip, ToggleChipGroup, ToggleChipItem } from './ui/toggle-chip'
import { CheckIcon } from './ui/icons'

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
 * Which image model the agents' generate_image tool draws with. The registry
 * is shared with the server; the server says which entries this user's
 * credentials can actually run, and unavailable ones stay visible but inert
 * so the menu doubles as a capability list.
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

  const selected = models.find((m) => m.selected)
  const selectedOption = selected && IMAGE_MODELS.find((option) => option.id === selected.id)
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
    <SettingsCard>
      <CardHeader>
        <CardTitle>{t('models.imageModelTitle')}</CardTitle>
        <CardDescription>{t('models.imageModelDescription')}</CardDescription>
      </CardHeader>
      <div className="px-4 pb-5 pt-4 sm:px-[22px]">
        <ToggleChipGroup
          aria-label={t('models.imageModelTitle')}
          value={selected?.id ?? ''}
          onValueChange={pick}
          disabled={busy}
        >
          {IMAGE_MODELS.map((option) => {
            const status = models.find((m) => m.id === option.id)
            if (!status?.available) {
              return (
                <ToggleChip key={option.id} state="idle" title={t(UNAVAILABLE_HINTS[option.provider])}>
                  {option.name}
                </ToggleChip>
              )
            }
            return (
              <ToggleChipItem key={option.id} value={option.id} title={blurbOf(option)}>
                {status.selected && (
                  <CheckIcon width={13} height={13} strokeWidth={2.5} color="var(--success-ink)" aria-hidden />
                )}
                {option.name}
              </ToggleChipItem>
            )
          })}
        </ToggleChipGroup>
        {selected && <p className="mt-[10px] text-body text-ink-faint">{selectedOption && blurbOf(selectedOption)}</p>}
        {error && <p className="mt-[10px] text-body text-accent-ink">{error}</p>}
      </div>
    </SettingsCard>
  )
}
