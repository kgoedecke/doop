import { useTheme } from '../lib/theme'
import { ThemePicker } from './ThemePicker'
import { Note } from './ui/note'
import { CardDescription, CardHeader, CardRow, CardTitle, SettingsCard } from './ui/card'

/** The "Appearance" pane of /settings. The theme is a property of this
 *  browser rather than the account — it is how the device looks, like zoom —
 *  so nothing here touches the server. */
export function AppearanceSettings() {
  const { theme, resolved } = useTheme()
  return (
    <SettingsCard>
      <CardHeader>
        <CardTitle>Theme</CardTitle>
        <CardDescription>
          Choose a light or dark theme for every canvas and page in this browser. System follows your operating system
          and updates when its theme changes.
        </CardDescription>
      </CardHeader>
      <CardRow label="Appearance">
        <ThemePicker />
        <Note>
          {theme === 'system'
            ? `Following your system. The current theme is ${resolved}.`
            : 'Your selected theme overrides your system setting.'}
        </Note>
      </CardRow>
    </SettingsCard>
  )
}
