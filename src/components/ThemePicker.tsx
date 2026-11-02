import type { ComponentType } from 'react'
import { isTheme, useTheme, type Theme } from '../lib/theme'
import { useT, type PlainMessageKey } from '../lib/i18n'
import { ToggleChipGroup, ToggleChipItem } from './ui/toggle-chip'
import { DesktopIcon, MoonIcon, SunIcon, type IconProps } from './ui/icons'

/** The three choices, in the order every control lists them. Each site renders
 *  the icon at its own size, so this carries the component, not an element. */
export const themeOptions: { value: Theme; label: PlainMessageKey; Icon: ComponentType<IconProps> }[] = [
  { value: 'system', label: 'settings.themeSystem', Icon: DesktopIcon },
  { value: 'light', label: 'settings.themeLight', Icon: SunIcon },
  { value: 'dark', label: 'settings.themeDark', Icon: MoonIcon },
]

/** The chip row on the Appearance settings pane. */
export function ThemePicker() {
  const { theme, setTheme } = useTheme()
  const t = useT()
  return (
    <ToggleChipGroup
      aria-label={t('settings.themeAria')}
      value={theme}
      onValueChange={(next) => isTheme(next) && setTheme(next)}
    >
      {themeOptions.map(({ value, label, Icon }) => (
        <ToggleChipItem key={value} value={value}>
          <Icon aria-hidden /> {t(label)}
        </ToggleChipItem>
      ))}
    </ToggleChipGroup>
  )
}
