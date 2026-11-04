import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useStore } from '../lib/store'
import { useT, type PlainMessageKey } from '../lib/i18n'
import {
  IMAGE_DESCRIPTION_MODES,
  type DescriberReason,
  type ImageDescriptionMode,
  type ImageDescriptionPreference,
} from '../../shared/imageDescriptions'
import { CardDescription, CardHeader, CardTitle, SettingsCard } from './ui/card'
import { Segmented, SegmentedItem } from './ui/segmented'
import { StatusLabel } from './ui/status-label'

const MODE_LABELS: Record<ImageDescriptionMode, PlainMessageKey> = {
  off: 'settings.imageDescriptionsOff',
  account: 'settings.imageDescriptionsAccount',
  server: 'settings.imageDescriptionsServer',
}

const REASONS: Record<DescriberReason, PlainMessageKey> = {
  off: 'settings.imageDescriptionsReasonOff',
  'text-only': 'settings.imageDescriptionsReasonTextOnly',
  'no-model': 'settings.imageDescriptionsReasonNoModel',
}

/**
 * Whether, and on whose model, the images uploaded to this person's canvases
 * get a description for agents (shared/imageDescriptions.ts). The server
 * answers with the model that would run right now, so a text-only account
 * or an instance without a key explains itself under the switch.
 */
export function ImageDescriptionsCard() {
  const t = useT()
  const [preference, setPreference] = useState<ImageDescriptionPreference | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  /* the describer follows the connected account — re-read when it changes */
  const version = useStore((s) => s.allowanceVersion)
  const refresh = useCallback(() => {
    api.imageDescriptions().then(setPreference, () => {})
  }, [])
  useEffect(refresh, [refresh, version])

  if (!preference) return null

  const pick = async (mode: string) => {
    if (!IMAGE_DESCRIPTION_MODES.some((known) => known === mode)) return
    setBusy(true)
    setError('')
    try {
      setPreference(await api.setImageDescriptions(mode as ImageDescriptionMode))
    } catch (e) {
      setError(e instanceof Error ? e.message : t('models.failedRetry'))
      refresh()
    } finally {
      setBusy(false)
    }
  }

  const { describer } = preference
  return (
    <SettingsCard>
      <CardHeader>
        <CardTitle>{t('settings.imageDescriptionsTitle')}</CardTitle>
        <CardDescription>{t('settings.imageDescriptionsDescription')}</CardDescription>
      </CardHeader>
      <div className="px-4 pb-5 pt-4 sm:px-[22px]">
        <Segmented
          aria-label={t('settings.imageDescriptionsAria')}
          value={preference.mode}
          onValueChange={pick}
          disabled={busy}
        >
          {IMAGE_DESCRIPTION_MODES.map((mode) => (
            <SegmentedItem key={mode} value={mode}>
              {t(MODE_LABELS[mode])}
            </SegmentedItem>
          ))}
        </Segmented>
        <div className="mt-[10px]">
          {describer.label !== null ? (
            <StatusLabel tone="done">{t('settings.imageDescriptionsRunsOn', { label: describer.label })}</StatusLabel>
          ) : (
            <StatusLabel>{t(REASONS[describer.reason])}</StatusLabel>
          )}
        </div>
        {error && <p className="mt-[10px] text-body text-accent-ink">{error}</p>}
      </div>
    </SettingsCard>
  )
}
