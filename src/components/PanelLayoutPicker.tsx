import type { ComponentType } from 'react'
import { isPanelLayout, setPanelLayout, usePanelLayout, type PanelLayout } from '../lib/panelLayout'
import { useT, type PlainMessageKey } from '../lib/i18n'
import { ToggleChipGroup, ToggleChipItem } from './ui/toggle-chip'
import { PanelsDockedIcon, PanelsFloatingIcon, type IconProps } from './ui/icons'

const options: { value: PanelLayout; label: PlainMessageKey; Icon: ComponentType<IconProps> }[] = [
  { value: 'floating', label: 'settings.panelsFloating', Icon: PanelsFloatingIcon },
  { value: 'docked', label: 'settings.panelsDocked', Icon: PanelsDockedIcon },
]

/** The chip row on the Appearance settings pane that picks the canvas
 *  editor's panel layout. */
export function PanelLayoutPicker() {
  const layout = usePanelLayout()
  const t = useT()
  return (
    <ToggleChipGroup
      aria-label={t('settings.panelsAria')}
      value={layout}
      onValueChange={(next) => isPanelLayout(next) && setPanelLayout(next)}
    >
      {options.map(({ value, label, Icon }) => (
        <ToggleChipItem key={value} value={value}>
          <Icon aria-hidden /> {t(label)}
        </ToggleChipItem>
      ))}
    </ToggleChipGroup>
  )
}
