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
import { CardDescription, CardHeader, CardRow, CardTitle, SettingsCard } from './ui/card'
import { Disclosure } from './ui/collapsible'
import { Note } from './ui/note'
import { StatusLabel } from './ui/status-label'
import { ToggleChipGroup, ToggleChipItem } from './ui/toggle-chip'

const MODE_LABELS: Record<ImageDescriptionMode, PlainMessageKey> = {
  off: 'settings.imageDescriptionsOff',
  account: 'settings.imageDescriptionsAccount',
  server: 'settings.imageDescriptionsServer',
}

/* Who pays for the model that is ready. My model falls back to the server's
   when the account has none that sees images, and says so. */
const PAYER_NOTES: Record<'account' | 'server', PlainMessageKey> = {
  account: 'settings.imageDescriptionsAccountNote',
  server: 'settings.imageDescriptionsServerNote',
}

const REASONS: Record<DescriberReason, PlainMessageKey> = {
  off: 'settings.imageDescriptionsReasonOff',
  'text-only': 'settings.imageDescriptionsReasonTextOnly',
  'no-model': 'settings.imageDescriptionsReasonNoModel',
}

/**
 * Upload billing and consent to owner fallback. The status previews the
 * user's own uploads; a different canvas owner's eligible account can
 * precede the displayed server fallback.
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
      <CardRow label={t('settings.imageDescriptionsRow')}>
        <ToggleChipGroup
          aria-label={t('settings.imageDescriptionsAria')}
          value={preference.mode}
          onValueChange={pick}
          disabled={busy}
        >
          {IMAGE_DESCRIPTION_MODES.map((mode) => (
            <ToggleChipItem key={mode} value={mode}>
              {t(MODE_LABELS[mode])}
            </ToggleChipItem>
          ))}
        </ToggleChipGroup>
      </CardRow>
      <div className="flex flex-col gap-2.5 px-4 pb-5 pt-1 sm:pl-[186px] sm:pr-[22px]">
        {describer.label !== null ? (
          <>
            <StatusLabel tone="done">{t('settings.imageDescriptionsRunsOn', { label: describer.label })}</StatusLabel>
            {preference.paidBy && (
              <Note>
                {t(
                  preference.mode === 'account' && preference.paidBy === 'server'
                    ? 'settings.imageDescriptionsFallbackNote'
                    : PAYER_NOTES[preference.paidBy],
                )}
              </Note>
            )}
          </>
        ) : (
          <Note>{t(REASONS[describer.reason])}</Note>
        )}
        {error && <Note tone="error">{error}</Note>}
        <Disclosure label={t('settings.imageDescriptionsHowTitle')} className="text-caption text-ink-faint">
          <p className="max-w-[62em] text-caption text-ink-soft">{t('settings.imageDescriptionsHow')}</p>
        </Disclosure>
      </div>
    </SettingsCard>
  )
}
