import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Segmented, SegmentedIconItem, SegmentedIcons, SegmentedItem } from '@/components/ui/segmented'
import { ToggleChip, ToggleChipGroup, ToggleChipItem } from '@/components/ui/toggle-chip'
import {
  DropdownMenu,
  DropdownMenuCaption,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipProvider } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { ListItem, ListMeta, ListRow, ListSection, ListSummary, ListTitle } from '@/components/ui/list'
import { DashNavItem, DashSectionLabel, DashSidebarBrand } from '@/components/ui/dash'
import { Dot } from '@/components/ui/dot'
import {
  BuildingIcon,
  ChevronDownIcon,
  CopyIcon,
  GridIcon,
  KeyIcon,
  ListIcon,
  ShareIcon,
  SparkIcon,
  TrashIcon,
  UsersIcon,
} from '@/components/ui/icons'

const meta = { title: 'Primitives/Navigation' } satisfies Meta
export default meta

type Story = StoryObj<typeof meta>

/** `variant="card"` is the phone's pane switcher (Settings, Workspace, Admin): full width, 40px. */
export const TabsStory: Story = {
  name: 'Tabs',
  render: () => (
    <Tabs defaultValue="all" className="max-w-[420px]">
      <TabsList variant="card">
        <TabsTrigger value="all">All · 12</TabsTrigger>
        <TabsTrigger value="mine">Mine · 9</TabsTrigger>
        <TabsTrigger value="shared">Shared · 3</TabsTrigger>
      </TabsList>
      <TabsContent value="all" className="pt-3 text-body text-ink-soft">
        Every canvas you can open.
      </TabsContent>
      <TabsContent value="mine" className="pt-3 text-body text-ink-soft">
        The ones you made.
      </TabsContent>
      <TabsContent value="shared" className="pt-3 text-body text-ink-soft">
        The ones you were invited to.
      </TabsContent>
    </Tabs>
  ),
}

function SegmentedDemo() {
  const [view, setView] = useState('grid')
  const [tier, setTier] = useState('fast')
  return (
    <div className="flex items-center gap-6">
      <SegmentedIcons value={view} onValueChange={setView} aria-label="View">
        <SegmentedIconItem value="grid" aria-label="Grid view">
          <GridIcon width={14} height={14} />
        </SegmentedIconItem>
        <SegmentedIconItem value="list" aria-label="List view">
          <ListIcon width={14} height={14} />
        </SegmentedIconItem>
      </SegmentedIcons>
      <Segmented value={tier} onValueChange={setTier} aria-label="Model tier">
        <SegmentedItem value="fast">Fast</SegmentedItem>
        <SegmentedItem value="smart">Smart</SegmentedItem>
      </Segmented>
    </div>
  )
}

export const SegmentedStory: Story = { name: 'Segmented', render: () => <SegmentedDemo /> }

function ChipsDemo() {
  const [model, setModel] = useState('gpt-image-2')
  const [shelf, setShelf] = useState('all')
  return (
    <div className="flex flex-col gap-5">
      <ToggleChipGroup aria-label="Image model" value={model} onValueChange={setModel}>
        <ToggleChipItem value="gpt-image-2">GPT Image 2</ToggleChipItem>
        <ToggleChipItem value="nano-banana-2">Nano Banana 2</ToggleChipItem>
        <ToggleChip state="idle" title="Connect a Seedream account first">
          Seedream 5 Pro
        </ToggleChip>
      </ToggleChipGroup>
      <ToggleChipGroup aria-label="Shelf" className="gap-1.5" value={shelf} onValueChange={setShelf}>
        {['all', 'landing', 'app', 'deck'].map((value) => (
          <ToggleChipItem key={value} value={value} size="sm">
            {value === 'all' ? 'All · 24' : value}
          </ToggleChipItem>
        ))}
      </ToggleChipGroup>
      <span className="text-caption text-ink-faint">md for pickers; sm for the gallery's shelf filter</span>
    </div>
  )
}

export const ToggleChips: Story = { name: 'Toggle chips', render: () => <ChipsDemo /> }

export const Menu: Story = {
  name: 'Dropdown menu',
  render: () => (
    <div className="flex items-start gap-6">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button>
            Last edited <ChevronDownIcon width={12} height={12} className="text-ink-faint" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" width="md">
          <DropdownMenuItem>
            <ShareIcon className="size-4" /> Share
          </DropdownMenuItem>
          <DropdownMenuItem>
            <CopyIcon className="size-4" /> Duplicate
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuCaption>Danger zone</DropdownMenuCaption>
          <DropdownMenuItem tone="danger">
            <TrashIcon className="size-4" /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <TooltipProvider>
        <Tooltip label="Working right now">
          <Button variant="ghost">Hover me</Button>
        </Tooltip>
      </TooltipProvider>
    </div>
  ),
}

const railIcon = { width: 14, height: 14, 'aria-hidden': true } as const

function SidebarDemo() {
  const [pane, setPane] = useState('all')
  return (
    <div className="flex items-start gap-8">
      {/* the app rail's rows: DashNavItem density="rail" on a rail-variant sidebar's bg-sub */}
      <div className="w-[236px] rounded-card bg-sub px-3 pb-3 pt-3.5">
        <DashSidebarBrand onHome={() => {}} />
        <nav className="flex flex-col gap-0.5">
          <DashNavItem
            density="rail"
            icon={<GridIcon {...railIcon} />}
            active={pane === 'all'}
            onClick={() => setPane('all')}
          >
            All canvases
          </DashNavItem>
          <DashNavItem
            density="rail"
            icon={<UsersIcon {...railIcon} />}
            active={pane === 'shared'}
            onClick={() => setPane('shared')}
          >
            Shared with me
          </DashNavItem>
        </nav>
        <DashSectionLabel density="rail">Workspaces</DashSectionLabel>
        <DashNavItem
          density="rail"
          icon={<BuildingIcon {...railIcon} />}
          count={12}
          active={pane === 'ws'}
          onClick={() => setPane('ws')}
        >
          Doop UI
        </DashNavItem>
        <DashSectionLabel density="rail">Agents</DashSectionLabel>
        <DashNavItem
          as="div"
          density="rail"
          icon={<SparkIcon {...railIcon} />}
          trailing={<Dot size="sm" className="bg-success" title="working right now" />}
        >
          Claude Code
        </DashNavItem>
        <DashNavItem
          as="div"
          density="rail"
          icon={<KeyIcon {...railIcon} />}
          trailing={<span className="text-caption text-ink-faint">2h ago</span>}
        >
          Codex
        </DashNavItem>
      </div>
      {/* the default density, for a sidebar that is not the app rail */}
      <div className="w-[236px] rounded-card bg-surface px-3.5 pb-[18px] pt-2 shadow-ring">
        <DashSectionLabel>Instance</DashSectionLabel>
        <DashNavItem icon={<GridIcon {...railIcon} />} count={48} active>
          Canvases
        </DashNavItem>
        <DashNavItem icon={<UsersIcon {...railIcon} />} count={9}>
          Accounts
        </DashNavItem>
      </div>
    </div>
  )
}

export const Sidebar: Story = { name: 'Sidebar rows', render: () => <SidebarDemo /> }

export const Lists: Story = {
  render: () => (
    <ListSection className="max-w-[420px]">
      <ListRow>
        <ListItem>
          <ListTitle>Recap this week</ListTitle>
          <ListSummary>Claude · 3 frames</ListSummary>
        </ListItem>
        <ListMeta>2m ago</ListMeta>
      </ListRow>
      <ListRow>
        <ListItem>
          <ListTitle>Pricing page, three tiers</ListTitle>
          <ListSummary>Codex · running</ListSummary>
        </ListItem>
        <ListMeta>now</ListMeta>
      </ListRow>
    </ListSection>
  ),
}
