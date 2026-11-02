import type { Meta, StoryObj } from '@storybook/react-vite'
import { Avatar, AvatarStack, initials } from '@/components/ui/avatar'
import { colorFor } from '../../shared/types'

/**
 * Who is here, as one face: a disc on a 2px surface collar. A person is
 * their initials on a 22% tint of their colour; an agent is its brand mark
 * on the surface, and wears the silver glaze while it works. The same face
 * sits in the canvas's presence pill (24px), on a canvas card (18px) and in
 * the account menu and member rows (28–32px).
 */
const meta = {
  title: 'Primitives/Avatar',
  component: Avatar,
  args: { name: 'Kevin Goedecke', kind: 'user', size: 24, color: colorFor('kevin'), glaze: false },
  argTypes: {
    kind: { control: 'radio', options: ['user', 'agent'] },
    tone: { control: 'radio', options: ['tint', 'ink'] },
    size: { control: { type: 'range', min: 16, max: 48, step: 2 } },
    color: { control: 'color' },
    glaze: { control: 'boolean' },
    glazeDelay: { table: { disable: true } },
    stacked: { table: { disable: true } },
  },
} satisfies Meta<typeof Avatar>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

const PEOPLE = [
  { id: 'u1', name: 'Kevin Goedecke' },
  { id: 'u2', name: 'Mia Chen' },
  { id: 'u3', name: 'Sam Ortiz' },
  { id: 'u4', name: 'Jo Park' },
  { id: 'u5', name: 'Lee Wong' },
].map((p) => ({ ...p, color: colorFor(p.id) }))

/** One rule for the letters: first and last initial, two letters of a lone name, a dot for none. */
export const People: Story = {
  render: () => (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-4">
        {PEOPLE.slice(0, 3).map((p) => (
          <Avatar key={p.id} name={p.name} color={p.color} />
        ))}
        <Avatar name="Madonna" color={colorFor('madonna')} />
        <Avatar name="" />
      </div>
      <div className="flex items-center gap-4 text-caption text-ink-faint">
        {['Kevin Goedecke', 'Mary Jane Watson', 'Madonna', ''].map((n) => (
          <span key={n || 'none'} className="font-mono">
            {JSON.stringify(n)} → {initials(n)}
          </span>
        ))}
      </div>
    </div>
  ),
}

/** Agents: the brand mark on the surface; a glazed face is one that is working right now. */
export const Agents: Story = {
  render: () => (
    <div className="flex items-center gap-5">
      <Avatar name="Claude Code" kind="agent" glaze />
      <Avatar name="Codex" kind="agent" glaze glazeDelay={1.3} />
      <Avatar name="Cursor" kind="agent" />
      <Avatar name="Doop Reviewer" kind="agent" />
    </div>
  ),
}

export const Sizes: Story = {
  render: () => (
    <div className="flex items-center gap-5">
      {[18, 24, 28, 32].map((size) => (
        <Avatar key={size} name="Kevin Goedecke" color={colorFor('kevin')} size={size} />
      ))}
      <span className="text-caption text-ink-faint">
        18 on a canvas card · 24 in the presence pill · 28–32 in menus and rows
      </span>
    </div>
  ),
}

/** `tone="ink"`: the signed-in account's own face on the dashboard, initials on an ink disc. */
export const Ink: Story = {
  name: 'Ink (account)',
  render: () => (
    <div className="flex items-center gap-5">
      <Avatar tone="ink" name="Kevin Goedecke" size={34} />
      <Avatar tone="ink" name="Madonna" size={28} />
      <span className="text-caption text-ink-faint">34 on the dashboard's account button</span>
    </div>
  ),
}

/** The first three and a "+N" disc; the row's tooltip names everyone. */
export const Stack: Story = {
  render: () => (
    <div className="flex flex-col gap-5">
      <AvatarStack people={PEOPLE} />
      <AvatarStack people={PEOPLE} size={18} />
      <AvatarStack people={PEOPLE.slice(0, 2)} size={18} />
      <div className="flex">
        <Avatar name="Kevin Goedecke" color={colorFor('kevin')} stacked />
        <Avatar name="Mia Chen" color={colorFor('mia')} stacked />
        <Avatar name="Claude Code" kind="agent" glaze stacked />
      </div>
    </div>
  ),
}
