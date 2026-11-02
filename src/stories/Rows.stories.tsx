import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Avatar } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { BuildingIcon } from '@/components/ui/icons'
import { PersonRow } from '@/components/ui/list'
import { SelectionBar, SelectionBarAction } from '@/components/ui/selection-bar'
import { Step, Steps } from '@/components/ui/steps'
import { colorFor } from '../../shared/types'

/** The small rows screens kept drawing by hand: a person on a line, the
 *  "N of M selected" bar over a checklist, and a numbered how-to. */
const meta = { title: 'Primitives/Rows' } satisfies Meta
export default meta

type Story = StoryObj<typeof meta>

/** The share list, the members table and the account menu. */
export const People: Story = {
  name: 'PersonRow',
  render: () => (
    <div className="flex max-w-[420px] flex-col gap-1">
      <PersonRow
        className="py-1.5"
        avatar={<Avatar name="Kevin Goedecke" color={colorFor('kevin')} size={28} />}
        name="Kevin Goedecke (you)"
        detail="kevin@doop.design"
        trailing={<span className="text-label text-ink-faint">Owner</span>}
      />
      <PersonRow
        className="py-1.5"
        avatar={<Avatar name="Mia Chen" color={colorFor('mia')} size={28} />}
        name="Mia Chen"
        detail="mia@example.com · joined 3d ago"
        trailing={
          <>
            <Badge>member</Badge>
            <Button variant="bare-danger" size="sm">
              Remove
            </Button>
          </>
        }
      />
      <PersonRow
        className="py-1.5"
        avatar={
          <span className="grid size-7 flex-none place-items-center rounded-full bg-paper-deep text-ink-soft">
            <BuildingIcon width={14} height={14} aria-hidden />
          </span>
        }
        name="Everyone in Doop"
        detail="12 people"
        trailing={<span className="text-label text-ink-faint">Can edit</span>}
      />
    </div>
  ),
}

const FRAMES = ['Home', 'Pricing', 'Changelog', 'About', 'Careers']

function SelectionBarDemo() {
  const [selected, setSelected] = useState<Set<string>>(new Set(FRAMES.slice(0, 3)))
  const toggle = (name: string) =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  return (
    <div className="flex max-w-[420px] flex-col gap-6">
      <div>
        <SelectionBar
          count={selected.size}
          total={FRAMES.length}
          actions={
            <>
              <SelectionBarAction onClick={() => setSelected(new Set(FRAMES))}>Select all</SelectionBarAction>
              <SelectionBarAction onClick={() => setSelected(new Set())}>Clear</SelectionBarAction>
            </>
          }
        />
        <div className="flex flex-col gap-2 rounded-card border border-line bg-surface p-3">
          {FRAMES.map((name) => (
            <label key={name} className="flex items-center gap-2.5 text-body">
              <Checkbox checked={selected.has(name)} onChange={() => toggle(name)} />
              {name}
            </label>
          ))}
        </div>
      </div>
      <SelectionBar
        count={31}
        total={40}
        tone="error"
        note=" — 25 at most"
        actions={<SelectionBarAction>Clear</SelectionBarAction>}
      />
    </div>
  )
}

export const Selection: Story = { name: 'SelectionBar', render: () => <SelectionBarDemo /> }

/** Numbered from a CSS counter: write the steps in order. */
export const HowTo: Story = {
  name: 'Steps',
  render: () => (
    <Steps className="max-w-[420px]">
      <Step>Copy your frames below.</Step>
      <Step>In Figma, run Plugins → “Doop — Editable import”.</Step>
      <Step>Paste, then add to your current page.</Step>
    </Steps>
  ),
}
