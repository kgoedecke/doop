import { useT } from '../lib/i18n'
import { setPromptBoxHidden, usePromptBoxHidden } from '../lib/homePreferences'
import { CardDescription, CardHeader, CardRow, CardTitle, SettingsCard } from './ui/card'
import { Switch } from './ui/switch'

export function GeneralSettings() {
  const t = useT()
  const hidden = usePromptBoxHidden()
  return (
    <SettingsCard>
      <CardHeader>
        <CardTitle>{t('settings.homeDashboardTitle')}</CardTitle>
        <CardDescription>{t('settings.homeDashboardDescription')}</CardDescription>
      </CardHeader>
      <CardRow
        label={<label htmlFor="show-prompt-box">{t('settings.showPromptBox')}</label>}
        action={
          <Switch id="show-prompt-box" checked={!hidden} onCheckedChange={(checked) => setPromptBoxHidden(!checked)} />
        }
      >
        <span className="text-body text-ink-soft">{t('settings.showPromptBoxHint')}</span>
      </CardRow>
    </SettingsCard>
  )
}
