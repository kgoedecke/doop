import type { ComponentType, SVGProps } from 'react'
import { isTheme, useTheme, type Theme } from '../lib/theme'
import { ToggleChipGroup, ToggleChipItem } from './ui/toggle-chip'
import { DesktopIcon, MoonIcon, SunIcon } from './ui/icons'

/** The three choices, in the order every control lists them. Each site renders
 *  the icon at its own size, so this carries the component, not an element. */
export const themeOptions: { value: Theme; label: string; Icon: ComponentType<SVGProps<SVGSVGElement>> }[] = [
  { value: 'system', label: 'System', Icon: DesktopIcon },
  { value: 'light', label: 'Light', Icon: SunIcon },
  { value: 'dark', label: 'Dark', Icon: MoonIcon },
]

/** The chip row on the Appearance settings pane. */
export function ThemePicker() {
  const { theme, setTheme } = useTheme()
  return (
    <ToggleChipGroup aria-label="Theme" value={theme} onValueChange={(next) => isTheme(next) && setTheme(next)}>
      {themeOptions.map(({ value, label, Icon }) => (
        <ToggleChipItem key={value} value={value}>
          <Icon aria-hidden /> {label}
        </ToggleChipItem>
      ))}
    </ToggleChipGroup>
  )
}
