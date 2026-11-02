import type { Meta, StoryObj } from '@storybook/react-vite'
import type { ComponentType } from 'react'
import * as Icons from '@/components/ui/icons'
import type { IconProps } from '@/components/ui/icons'

/** Every glyph in the set, at the 16px default (`size="button"`) and the 14px
 *  the rail, menus and editor chrome use (`size="rail"`). */
const meta = { title: 'Foundations/Icons' } satisfies Meta
export default meta

type Story = StoryObj<typeof meta>

type IconComponent = ComponentType<IconProps>
const ALL = (Object.entries(Icons).filter(([, v]) => typeof v === 'function') as [string, IconComponent][]).sort(
  ([a], [b]) => a.localeCompare(b),
)

export const Catalogue: Story = {
  render: () => (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
      {ALL.map(([name, Icon]) => (
        <div key={name} className="flex items-center gap-3 rounded-card bg-surface px-3 py-2.5 shadow-ring">
          <Icon />
          <Icon size="rail" className="text-ink-soft" />
          <span className="truncate font-mono text-caption text-ink-soft">{name}</span>
        </div>
      ))}
    </div>
  ),
}
