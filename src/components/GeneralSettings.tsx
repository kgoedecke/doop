import { useLocale, useT } from '../lib/i18n'
import { setPromptBoxHidden, usePromptBoxHidden } from '../lib/homePreferences'
import { LanguagePicker } from './LanguagePicker'
import { Note } from './ui/note'
import { CardDescription, CardHeader, CardRow, CardTitle, SettingsCard } from './ui/card'
import { Switch } from './ui/switch'

export function GeneralSettings() {
  const t = useT()
  const hidden = usePromptBoxHidden()
  const { picked } = useLocale()
  return (
    <>
      <SettingsCard>
        <CardHeader>
          <CardTitle>{t('settings.languageTitle')}</CardTitle>
          <CardDescription>{t('settings.languageDescription')}</CardDescription>
        </CardHeader>
        <CardRow label={t('settings.languageRow')}>
          <LanguagePicker />
          <Note>{picked ? t('settings.languagePicked') : t('settings.languageServerDefault')}</Note>
        </CardRow>
      </SettingsCard>
      <SettingsCard>
        <CardHeader>
          <CardTitle>{t('settings.homeDashboardTitle')}</CardTitle>
          <CardDescription>{t('settings.homeDashboardDescription')}</CardDescription>
        </CardHeader>
        <CardRow
          label={<label htmlFor="show-prompt-box">{t('settings.showPromptBox')}</label>}
          action={
            <Switch
              id="show-prompt-box"
              checked={!hidden}
              onCheckedChange={(checked) => setPromptBoxHidden(!checked)}
            />
          }
        >
          <span className="text-body text-ink-soft">{t('settings.showPromptBoxHint')}</span>
        </CardRow>
      </SettingsCard>
    </>
  )
}
