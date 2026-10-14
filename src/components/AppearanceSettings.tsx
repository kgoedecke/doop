import { useTheme } from '../lib/theme'
import { ThemePicker } from './ThemePicker'
import { Note } from './ui/note'
import { Card, CardDescription, CardHeader, CardRow, CardTitle } from './ui/card'

/** The "Appearance" pane of /settings. The theme is a property of this
 *  browser rather than the account — it is how the device looks, like zoom —
 *  so nothing here touches the server. */
export function AppearanceSettings() {
  const { theme, resolved } = useTheme()
  return (
    <Card className="mt-4 max-w-[1000px] overflow-hidden sm:mt-5">
      <CardHeader>
        <CardTitle>Theme</CardTitle>
        <CardDescription>
          Light or dark, across every canvas and page in this browser. System follows your operating system and switches
          whenever it does.
        </CardDescription>
      </CardHeader>
      <CardRow label="Appearance">
        <ThemePicker />
        <Note>
          {theme === 'system'
            ? `Following your system — ${resolved} right now.`
            : 'Set by hand — your system setting is ignored.'}
        </Note>
      </CardRow>
    </Card>
  )
}
