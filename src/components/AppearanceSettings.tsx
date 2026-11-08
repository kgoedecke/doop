import { useTheme } from '../lib/theme'
import { useT } from '../lib/i18n'
import { ThemePicker } from './ThemePicker'
import { PanelLayoutPicker } from './PanelLayoutPicker'
import { usePanelLayout } from '../lib/panelLayout'
import { Note } from './ui/note'
import { CardDescription, CardHeader, CardRow, CardTitle, SettingsCard } from './ui/card'

/** The "Appearance" pane of /settings. The theme and the canvas panel
 *  layout are properties of this browser rather than the
 *  account — how the device looks and reads, like zoom — so nothing here
 *  touches the server. */
export function AppearanceSettings() {
  const { theme, resolved } = useTheme()
  const t = useT()
  const panelLayout = usePanelLayout()
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
          <CardTitle>{t('settings.panelsTitle')}</CardTitle>
          <CardDescription>{t('settings.panelsDescription')}</CardDescription>
        </CardHeader>
        <CardRow label={t('settings.panelsRow')}>
          <PanelLayoutPicker />
          <Note>{t(panelLayout === 'docked' ? 'settings.panelsDockedNote' : 'settings.panelsFloatingNote')}</Note>
        </CardRow>
      </SettingsCard>
    </>
  )
}
