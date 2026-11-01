import { useTheme } from '../lib/theme'
import { useLocale, useT } from '../lib/i18n'
import { ThemePicker } from './ThemePicker'
import { LanguagePicker } from './LanguagePicker'
import { Note } from './ui/note'
import { CardDescription, CardHeader, CardRow, CardTitle, SettingsCard } from './ui/card'

/** The "Appearance" pane of /settings. The theme and the language are
 *  properties of this browser rather than the account — how the device looks
 *  and reads, like zoom — so nothing here touches the server. */
export function AppearanceSettings() {
  const { theme, resolved } = useTheme()
  const { picked } = useLocale()
  const t = useT()
  return (
    <>
      <SettingsCard>
        <CardHeader>
          <CardTitle>{t('settings.themeTitle')}</CardTitle>
          <CardDescription>{t('settings.themeDescription')}</CardDescription>
        </CardHeader>
        <CardRow label={t('settings.themeRow')}>
          <ThemePicker />
          <Note>
            {theme === 'system'
              ? t('settings.themeFollowingSystem', {
                  resolved: t(resolved === 'dark' ? 'settings.themeResolvedDark' : 'settings.themeResolvedLight'),
                })
              : t('settings.themeSetByHand')}
          </Note>
        </CardRow>
      </SettingsCard>
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
    </>
  )
}
