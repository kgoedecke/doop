import type { Meta, StoryObj } from '@storybook/react-vite'
import { AgentIcon } from '@/components/AgentIcon'
import { DoopMark, Logo } from '@/components/Logo'
import { RadioTowerIcon, WebIcon } from '@/components/ui/icons'
import { BRANDS, BrandMark } from '@/components/ui/brand-mark'
import { MetaTile } from '@/components/AutomateShell'
import { ClockTile } from '@/components/AutomateShell'
import { colorFor } from '../../shared/types'

/**
 * Every mark the product wears: its own, the agents', the people's and the
 * brands it connects to. These are the only places a logo should come from.
 */
const meta = { title: 'Marks' } satisfies Meta
export default meta

type Story = StoryObj<typeof meta>

export const Doop: Story = {
  render: () => (
    <div className="flex items-center gap-5">
      <Logo />
      <Logo className="size-[26px] rounded-row" />
      <DoopMark size={24} />
      <DoopMark size={13} />
    </div>
  ),
}

/** The Disc-D with its dot hopping: the home greeting's mark, and the loading mark. */
export const DoopAnimated: Story = {
  render: () => (
    <div className="flex items-end gap-6 text-ink">
      <DoopMark animated size={62} className="block" />
      <DoopMark animated size={24} className="block" />
    </div>
  ),
}

export const Agents: Story = {
  render: () => (
    <div className="flex items-center gap-5 text-body">
      {['Claude Code', 'Codex', 'Cursor', 'Doop'].map((name) => (
        <span key={name} className="flex items-center gap-2" style={{ color: colorFor(name) }}>
          <AgentIcon name={name} size={14} />
          <span className="text-ink-soft">{name}</span>
        </span>
      ))}
    </div>
  ),
}

/** Every third-party mark, from the one registry (`<BrandMark brand size />`). */
export const Brands: Story = {
  render: () => (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-4">
        {BRANDS.map((brand) => (
          <span key={brand} className="flex flex-col items-center gap-1.5">
            <BrandMark brand={brand} size={24} />
            <span className="font-mono text-micro text-ink-faint">{brand}</span>
          </span>
        ))}
      </div>
      <div className="flex items-center gap-4">
        {BRANDS.map((brand) => (
          <BrandMark key={brand} brand={brand} size={16} />
        ))}
        <span className="ml-2 text-caption text-ink-faint">16px in logo rows, 24px on picker tiles</span>
      </div>
    </div>
  ),
}

/** The feature tiles that compose a mark: a brand on a paper tile, the automation chain's clock. */
export const Tiles: Story = {
  render: () => (
    <div className="flex items-center gap-4">
      <span className="grid size-4 place-items-center rounded-[4px] bg-surface shadow-ring">
        <BrandMark brand="figma" size={12} />
      </span>
      <MetaTile size={24} />
      <ClockTile size={24} />
      <WebIcon className="size-5 text-ink" />
      <RadioTowerIcon className="size-5 text-ink" />
    </div>
  ),
}
