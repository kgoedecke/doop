import { cn } from '@/lib/utils'
import { useTheme, type Theme } from '../lib/theme'
import { Card, CardDescription, CardHeader, CardRow, CardTitle } from './ui/card'
import { SwitchRow } from './ui/switch'
import { ToggleChipGroup, ToggleChipItem } from './ui/toggle-chip'
import { DesktopIcon, MoonIcon, SunIcon } from './ui/icons'

const settingsCard = 'mt-4 max-w-[1000px] overflow-hidden sm:mt-5'

export function AppearanceSettings({ embedded = false, className }: { embedded?: boolean; className?: string }) {
  const { theme, resolvedTheme, isDark, setTheme, toggleDarkMode } = useTheme()

  return (
    <Card className={cn(settingsCard, embedded && 'mt-4 sm:mt-5', className)}>
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
        <CardDescription>
          Customize how Doop looks on your device. Choose between light, dark, or system preference.
        </CardDescription>
      </CardHeader>

      <SwitchRow
        icon={isDark ? <MoonIcon /> : <SunIcon />}
        label="Dark mode"
        description="Reduce glare and switch to high-contrast dark tones across the canvas and interface."
        checked={isDark}
        onCheckedChange={toggleDarkMode}
      />

      <CardRow label="Theme preference">
        <div className="flex flex-col gap-2">
          <ToggleChipGroup value={theme} onValueChange={(val) => setTheme(val as Theme)}>
            <ToggleChipItem value="system">
              <DesktopIcon /> System
            </ToggleChipItem>
            <ToggleChipItem value="light">
              <SunIcon /> Light
            </ToggleChipItem>
            <ToggleChipItem value="dark">
              <MoonIcon /> Dark
            </ToggleChipItem>
          </ToggleChipGroup>
          <span className="text-[11.5px] text-ink-faint">
            {theme === 'system'
              ? `Following your system appearance (currently ${resolvedTheme}).`
              : `Manual override active (${theme} mode).`}
          </span>
        </div>
      </CardRow>
    </Card>
  )
}
