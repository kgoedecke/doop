import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { IconButton } from '@/components/ui/icon-button'
import { Chip } from '@/components/ui/chip'
import { Kbd } from '@/components/ui/kbd'
import { SearchField } from '@/components/ui/search-field'
import { MenuButton } from '@/components/ui/menu-button'
import { Pressable } from '@/components/ui/pressable'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Toolbar, ToolbarControl, ToolbarDot } from '@/components/ui/toolbar'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import {
  ArrowUpIcon,
  CalendarIcon,
  CommentIcon,
  CopyIcon,
  GridIcon,
  HistoryIcon,
  LayoutTemplateIcon,
  MoreHorizontalIcon,
  PanelCollapseIcon,
  PulseIcon,
  SearchIcon,
  SparkIcon,
  UserIcon,
  XIcon,
} from '@/components/ui/icons'

/**
 * The small controls the dashboard chrome is assembled from. Each exists so
 * a screen never draws its own icon square, ring pill or key cap again.
 */
const meta = { title: 'Primitives/Controls' } satisfies Meta
export default meta

type Story = StoryObj<typeof meta>

function IconButtonDemo() {
  const [on, setOn] = useState<'grid' | 'user'>('grid')
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-2.5">
        <IconButton size="sm" aria-label="Search canvases (⌘K)">
          <SearchIcon width={15} height={15} />
        </IconButton>
        <IconButton size="sm" aria-label="Hide sidebar">
          <PanelCollapseIcon width={15} height={15} />
        </IconButton>
        <span className="text-caption text-ink-faint">sm · 24px, the rail's header row</span>
      </div>
      <div className="flex items-center gap-2.5">
        <IconButton aria-label="All canvases" on={on === 'grid'} onClick={() => setOn('grid')}>
          <GridIcon width={14} height={14} />
        </IconButton>
        <IconButton aria-label="Owned by me" on={on === 'user'} onClick={() => setOn('user')}>
          <UserIcon width={14} height={14} />
        </IconButton>
        <IconButton aria-label="Actions" shape="round" className="text-ink-faint">
          <MoreHorizontalIcon className="size-4" />
        </IconButton>
        <IconButton aria-label="Disabled" disabled>
          <GridIcon width={14} height={14} />
        </IconButton>
        <span className="text-caption text-ink-faint">
          md · 32px; `on` keeps the paper-deep fill; round for row actions
        </span>
      </div>
      <div className="flex items-center gap-2.5">
        <IconButton variant="primary" size="lg" shape="round" aria-label="Send">
          <ArrowUpIcon width={14} height={14} strokeWidth={1.75} />
        </IconButton>
        <IconButton variant="primary" size="lg" shape="round" aria-label="Send" disabled>
          <ArrowUpIcon width={14} height={14} strokeWidth={1.75} />
        </IconButton>
        <IconButton variant="danger" size="sm" aria-label="Remove Mia Chen">
          <XIcon width={14} height={14} />
        </IconButton>
        <span className="text-caption text-ink-faint">
          lg · 34px primary, the composer's send; danger for a row's remove
        </span>
      </div>
      <div className="flex items-center gap-2.5">
        <div className="relative grid h-[120px] w-[200px] place-items-center rounded-card bg-[linear-gradient(135deg,#c7d7f5,#f5d0c7)]">
          <IconButton variant="frosted" aria-label="Actions for Pricing page" className="absolute right-2 top-2">
            <MoreHorizontalIcon className="size-4" />
          </IconButton>
        </div>
        <span className="text-caption text-ink-faint">frosted · over a preview image</span>
      </div>
    </div>
  )
}

export const IconButtons: Story = { name: 'IconButton', render: () => <IconButtonDemo /> }

function ChipDemo() {
  const [on, setOn] = useState(0)
  const chips = [
    { label: 'Draft a landing page', icon: <LayoutTemplateIcon width={13} height={13} /> },
    { label: 'Recap a session', icon: <CalendarIcon width={13} height={13} /> },
    { label: 'What changed', icon: <HistoryIcon width={13} height={13} /> },
    { label: 'Run an automation', icon: <span className="font-mono text-caption">/</span> },
  ]
  return (
    <div className="flex flex-wrap items-center gap-3">
      {chips.map((c, i) => (
        <Chip key={c.label} icon={c.icon} on={i === on} onMouseEnter={() => setOn(i)}>
          {c.label}
        </Chip>
      ))}
    </div>
  )
}

/** Chips rest at 60%; the pointer, keyboard focus or `on` bring one fully up. */
export const Chips: Story = { name: 'Chip', render: () => <ChipDemo /> }

export const KeyCaps: Story = {
  name: 'Kbd',
  render: () => (
    <div className="flex items-center gap-4 text-body text-ink-soft">
      <span className="flex items-center gap-1">
        <Kbd>⌘</Kbd>
        <Kbd>K</Kbd>
        <span className="ml-1.5">Search</span>
      </span>
      <span className="flex items-center gap-1">
        <Kbd>⌘</Kbd>
        <Kbd>/</Kbd>
        <span className="ml-1.5">Ask Doop</span>
      </span>
      <span className="flex items-center gap-1">
        <Kbd>Esc</Kbd>
        <span className="ml-1.5">Close</span>
      </span>
    </div>
  ),
}

export const SearchFields: Story = {
  name: 'SearchField',
  render: () => (
    <div className="flex max-w-[460px] flex-col gap-5">
      <SearchField
        className="w-[260px]"
        placeholder="Search the gallery"
        aria-label="Search the gallery"
        trailing={<Kbd>⌘K</Kbd>}
      />
      <div className="flex flex-wrap items-center gap-3 rounded-control bg-paper p-3">
        <span className="text-body font-medium text-ink">Header</span>
        <SearchField
          size="header"
          placeholder="Search the gallery"
          aria-label="Search the gallery (header)"
          trailing={<Kbd className="hidden md:inline-flex">⌘K</Kbd>}
        />
      </div>
      <span className="text-caption text-ink-faint">
        size header: its own 40px row on a phone, the 30px pill (max 320px) from md
      </span>
      <div className="overflow-hidden rounded-panel bg-surface shadow-float">
        <SearchField
          variant="bar"
          placeholder="Search canvases"
          aria-label="Search canvases"
          inputClassName="text-copy md:text-copy"
        />
        <p className="px-4 py-5 text-body text-ink-faint">the palette's results go here</p>
      </div>
    </div>
  ),
}

function MenuButtonDemo() {
  const [sort, setSort] = useState('Last edited')
  const [drafts, setDrafts] = useState(1)
  return (
    <div className="flex items-center gap-5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <MenuButton aria-label={`Sort: ${sort}`}>{sort}</MenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" width="sm">
          {['Last edited', 'Name', 'Created'].map((s) => (
            <DropdownMenuItem key={s} onSelect={() => setSort(s)}>
              {s}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <MenuButton variant="quiet" icon={<CopyIcon width={14} height={14} />} aria-label={`Drafts: ${drafts}`}>
            {drafts} {drafts === 1 ? 'draft' : 'drafts'}
          </MenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" width="sm">
          {[1, 2, 3].map((n) => (
            <DropdownMenuItem key={n} onSelect={() => setDrafts(n)}>
              {n} {n === 1 ? 'draft' : 'drafts'}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="text-caption text-ink-faint">ring in a header; quiet inside a composer</span>
    </div>
  )
}

export const MenuButtons: Story = { name: 'MenuButton', render: () => <MenuButtonDemo /> }

/** The reset under every card tile and list row: no chrome, a focus ring. Tab to it. */
export const Pressables: Story = {
  name: 'Pressable',
  render: () => (
    <div className="flex max-w-[420px] flex-col gap-4">
      <div className="overflow-hidden rounded-card bg-surface shadow-elevation-1">
        <Pressable className="px-3 py-2.5">
          <span className="block text-body font-medium text-ink">Pricing page</span>
          <span className="mt-px block text-caption text-ink-faint">3 frames · edited 2d ago</span>
        </Pressable>
      </div>
      <Pressable layout="inline" focus="ring" className="gap-[7px] rounded-md text-body text-ink-soft hover:text-ink">
        <CopyIcon width={14} height={14} /> Inline action
      </Pressable>
    </div>
  ),
}

function SwitchDemo() {
  const [on, setOn] = useState(true)
  const [small, setSmall] = useState(false)
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-2.5">
        <span className="text-caption text-ink-soft">{on ? 'On' : 'Off'}</span>
        <Switch checked={on} onCheckedChange={setOn} aria-label="Weekly pull on or off" />
        <span className="text-caption text-ink-faint">md · 34×20, an automation's on/off</span>
      </div>
      <div className="flex items-center gap-2.5">
        <Switch size="sm" checked={small} onCheckedChange={setSmall} aria-label="Small switch" />
        <Switch size="sm" checked disabled aria-label="Disabled switch" />
        <span className="text-caption text-ink-faint">sm · 26×16, inside a dense row; disabled</span>
      </div>
    </div>
  )
}

/** A setting that applies the moment it flips. Space toggles it from the keyboard. */
export const Switches: Story = { name: 'Switch', render: () => <SwitchDemo /> }

function SelectDemo() {
  const [role, setRole] = useState('member')
  const [day, setDay] = useState('')
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-2.5">
        <Select value={role} onValueChange={setRole}>
          <SelectTrigger className="w-[180px]" aria-label="Role">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="member">Member</SelectItem>
            <SelectItem value="admin">Admin</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-caption text-ink-faint">md · 36px, beside an Input in a form</span>
      </div>
      <div className="flex items-center gap-2.5">
        <Select value={day} onValueChange={setDay}>
          <SelectTrigger size="sm" className="w-[140px]" aria-label="Which day">
            <SelectValue placeholder="Pick a day" />
          </SelectTrigger>
          <SelectContent>
            {['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].map((d) => (
              <SelectItem key={d} value={d}>
                {d}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value="member" disabled>
          <SelectTrigger size="sm" className="w-[120px]" aria-label="Disabled select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="member">Member</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-caption text-ink-faint">sm · 32px, a node sentence; placeholder; disabled</span>
      </div>
    </div>
  )
}

/** One value from a short list. `value=""` shows the placeholder; no item may use the empty string. */
export const Selects: Story = { name: 'Select', render: () => <SelectDemo /> }

/** The canvas editor's floating toolbar. `vertical` is the 40px column pinned
 *  to the editor's sides (and the automation editor's collapsed Runs panel);
 *  `ToolbarControl` names each glyph by its tooltip, and `ToolbarDot` marks
 *  live state on a button's corner. */
export const Toolbars: Story = {
  name: 'Toolbar',
  render: () => (
    <div className="flex items-start gap-6">
      <Toolbar aria-label="Canvas panels" orientation="vertical">
        <ToolbarControl label="Agents · 1 working">
          <SparkIcon />
          <ToolbarDot className="bg-success" />
        </ToolbarControl>
        <ToolbarControl label="Comments · 2 open">
          <CommentIcon />
          <ToolbarDot className="bg-brand" />
        </ToolbarControl>
        <ToolbarControl label="Activity">
          <PulseIcon />
        </ToolbarControl>
      </Toolbar>
      <Toolbar aria-label="Runs" orientation="vertical">
        <ToolbarControl label="Runs · last run failed">
          <PulseIcon />
          <ToolbarDot className="bg-accent-ink" />
        </ToolbarControl>
      </Toolbar>
      <Toolbar aria-label="Actions">
        <ToolbarControl label="Search" side="bottom">
          <SearchIcon />
        </ToolbarControl>
        <ToolbarControl label="Copy" side="bottom">
          <CopyIcon />
        </ToolbarControl>
      </Toolbar>
    </div>
  ),
}
