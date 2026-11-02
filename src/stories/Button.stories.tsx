import type { Meta, StoryObj } from '@storybook/react-vite'
import { Button } from '@/components/ui/button'
import { PlusIcon, SearchIcon, UploadIcon } from '@/components/ui/icons'

const meta = {
  title: 'Primitives/Button',
  component: Button,
  args: { children: 'New canvas', variant: 'default', size: 'md' },
  argTypes: {
    variant: {
      control: 'select',
      options: [
        'default',
        'primary',
        'ghost',
        'danger',
        'bare',
        'bare-danger',
        'link',
        'danger-solid',
        'solid',
        'inverse',
      ],
    },
    size: { control: 'select', options: ['pill', 'sm', 'md', 'lg', 'bar', 'icon', 'icon-sm', 'inline'] },
    block: { control: 'boolean' },
    disabled: { control: 'boolean' },
  },
} satisfies Meta<typeof Button>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

/** One black primary per screen; everything else is a white ring button. */
export const Variants: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="primary">
        <PlusIcon width={15} height={15} strokeWidth={1.75} /> New canvas
      </Button>
      <Button>
        <UploadIcon width={15} height={15} /> Import
      </Button>
      <Button variant="ghost">Manage</Button>
      <Button variant="danger">Disconnect</Button>
      <Button variant="bare">Cancel</Button>
      <Button variant="link">Codex &amp; other clients →</Button>
      <Button variant="danger-solid">Retry</Button>
      <Button variant="solid" size="sm">
        Copy
      </Button>
      <span className="rounded-control bg-ink p-2">
        <Button variant="inverse" size="sm">
          Inverse
        </Button>
      </span>
    </div>
  ),
}

export const Sizes: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      <Button size="pill">pill</Button>
      <Button size="sm">Small</Button>
      <Button size="md">Medium</Button>
      <Button size="lg">Large</Button>
      <Button size="bar">Bar</Button>
      <Button size="icon" aria-label="Search">
        <SearchIcon />
      </Button>
      <Button size="icon-sm" aria-label="Search">
        <SearchIcon width={14} height={14} />
      </Button>
      <Button variant="bare" size="inline">
        inline
      </Button>
    </div>
  ),
}

/** `size="inline"`: a text action with no box, at the caption step. `bare` for selection bars,
 *  `link` for a pointer in a card or a callout. */
export const InlineActions: Story = {
  name: 'Inline text actions',
  render: () => (
    <div className="flex max-w-[420px] flex-col gap-5">
      <div className="flex items-center justify-between rounded-control bg-paper px-3 py-2">
        <span className="text-label text-ink-soft">3 of 12 selected</span>
        <span className="flex gap-3">
          <Button variant="bare" size="inline">
            Select page
          </Button>
          <Button variant="bare" size="inline">
            Clear
          </Button>
        </span>
      </div>
      <Button variant="link" size="inline" className="self-start text-accent-ink">
        Codex &amp; other clients →
      </Button>
    </div>
  ),
}

/** The home design's header buttons: 32px tall, 8px corners, the body step. */
export const HeaderActions: Story = {
  name: 'Header actions (home)',
  render: () => (
    <div className="flex items-center gap-2">
      <Button className="h-8 gap-[7px] rounded-control pl-2.5 pr-3 text-body">
        <UploadIcon width={15} height={15} className="text-ink-soft" /> Import
      </Button>
      <Button variant="primary" className="h-8 gap-[7px] rounded-control pl-2.5 pr-3 text-body">
        <PlusIcon width={15} height={15} strokeWidth={1.75} /> New canvas
      </Button>
    </div>
  ),
}
