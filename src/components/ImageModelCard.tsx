import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import type { ImageModelStatus } from '../lib/api'
import { IMAGE_MODELS } from '../../shared/modelMenu'
import { posthog } from '../lib/posthog'
import { useStore } from '../lib/store'
import { Card, CardDescription, CardHeader, CardTitle } from './ui/card'
import { ToggleChip, ToggleChipGroup, ToggleChipItem } from './ui/toggle-chip'
import { CheckIcon } from './ui/icons'

/** Why an entry is disabled, phrased as the fix. */
const UNAVAILABLE_HINTS = {
  openai: 'Needs a ChatGPT subscription or OpenAI API key connected above (or a server key).',
  gemini: 'Needs a Gemini API key connected above (or a server key).',
  ark: 'Not configured on this server (its operator sets ARK_API_KEY).',
} as const

/**
 * Which image model the agents' generate_image tool draws with. The registry
 * is shared with the server; the server says which entries this user's
 * credentials can actually run, and unavailable ones stay visible but inert
 * so the menu doubles as a capability list.
 */
export function ImageModelCard() {
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

  const selected = models.find((m) => m.selected)
  const pick = async (id: string) => {
    setBusy(true)
    setError('')
    try {
      const { models: next } = await api.setImageModel(id)
      setModels(next)
      posthog.capture('image_model_changed', { model: id })
    } catch (e) {
      const body = (e as { body?: { error?: string } })?.body
      setError(body?.error || (e instanceof Error ? e.message : 'That did not work — try again'))
      refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="mt-4 max-w-[1000px] overflow-hidden sm:mt-5">
      <CardHeader>
        <CardTitle>Image model</CardTitle>
        <CardDescription>
          Which model the agent draws generated images with. It runs on the matching account above, or on this server’s
          key when you connected nothing.
        </CardDescription>
      </CardHeader>
      <div className="px-6 pb-6">
        <ToggleChipGroup aria-label="Image model" value={selected?.id ?? ''} onValueChange={pick} disabled={busy}>
          {IMAGE_MODELS.map((option) => {
            const status = models.find((m) => m.id === option.id)
            if (!status?.available) {
              return (
                <ToggleChip key={option.id} state="idle" title={UNAVAILABLE_HINTS[option.provider]}>
                  {option.name}
                </ToggleChip>
              )
            }
            return (
              <ToggleChipItem key={option.id} value={option.id} title={option.blurb}>
                {status.selected && <CheckIcon width={13} height={13} strokeWidth={2.5} color="#1a6b43" aria-hidden />}
                {option.name}
              </ToggleChipItem>
            )
          })}
        </ToggleChipGroup>
        {selected && (
          <p className="mt-[10px] text-[13px] text-ink-faint">
            {IMAGE_MODELS.find((option) => option.id === selected.id)?.blurb}
          </p>
        )}
        {error && <p className="mt-[10px] text-[12.5px] text-accent-ink">{error}</p>}
      </div>
    </Card>
  )
}
