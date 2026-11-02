import type { Meta, StoryObj } from '@storybook/react-vite'
import type { CanvasMeta, WorkspaceSummary } from '../../shared/types'
import { AppRail, railLayout } from '@/components/AppRail'
import { CanvasSearchModal } from '@/components/CanvasSearchModal'
import {
  DashContent,
  DashHeader,
  DashLayout,
  DashMain,
  DashNavItem,
  DashSectionLabel,
  DashTitle,
} from '@/components/ui/dash'
import { CreditCardIcon, GearIcon, UsersIcon } from '@/components/ui/icons'
import { cn } from '@/lib/utils'

const railIcon = { width: 14, height: 14, 'aria-hidden': true } as const

/** The signed-in shell: the rail every dashboard page mounts, with sample data. */
const meta = { title: 'Shell' } satisfies Meta
export default meta

type Story = StoryObj<typeof meta>

const now = Date.now()
const canvases: CanvasMeta[] = [
  {
    id: 'c1',
    name: 'Doop UI redesign',
    ownerId: 'u1',
    createdAt: now - 864e5 * 9,
    updatedAt: now - 6e4,
    frameCount: 22,
    agents: [{ name: 'Claude Code', lastAt: now - 3e4 }],
    people: [{ id: 'u1', name: 'Kevin Goedecke' }],
  },
  {
    id: 'c2',
    name: 'doop.design website',
    ownerId: 'u1',
    createdAt: now - 864e5 * 4,
    updatedAt: now - 12e4,
    frameCount: 9,
    agents: [{ name: 'Codex', lastAt: now - 12 * 6e4 }],
    people: [{ id: 'u1', name: 'Kevin Goedecke' }],
  },
  {
    id: 'c3',
    name: 'Cordline — Support',
    ownerId: 'u2',
    shared: true,
    createdAt: now - 864e5 * 2,
    updatedAt: now - 864e5 * 2,
    frameCount: 1,
    agents: [{ name: 'Cursor', lastAt: now - 2 * 36e5 }],
    people: [
      { id: 'u2', name: 'Mia Chen' },
      { id: 'u1', name: 'Kevin Goedecke' },
    ],
  },
]
const workspaces: WorkspaceSummary[] = [
  { id: 'w1', name: 'Doop UI', role: 'owner', active: true, plan: 'team', memberCount: 3 } as WorkspaceSummary,
]

export const Rail: Story = {
  render: () => (
    <div className="h-[720px] overflow-hidden rounded-panel shadow-ring">
      <DashLayout className={cn(railLayout, 'h-full')}>
        <AppRail
          active="all"
          canvases={canvases}
          workspaces={workspaces}
          onScope={() => {}}
          onCreateWorkspace={() => {}}
        />
        <DashMain className="[background:var(--paper)]">
          <DashHeader variant="bare" />
          <DashContent className="pt-2 md:pt-3">
            <DashTitle>A page in the shell</DashTitle>
          </DashContent>
        </DashMain>
      </DashLayout>
    </div>
  ),
}

/** A page's own group (Workspace's panes, Admin's indexes) goes in as children, after Resources. */
export const RailWithGroup: Story = {
  name: 'Rail with a page group',
  render: () => (
    <div className="h-[820px] overflow-hidden rounded-panel shadow-ring">
      <DashLayout className={cn(railLayout, 'h-full')}>
        <AppRail active="ws:w1" canvases={canvases} workspaces={workspaces} onScope={() => {}}>
          <DashSectionLabel density="rail">Doop UI</DashSectionLabel>
          <nav className="flex flex-col gap-0.5">
            <DashNavItem density="rail" icon={<UsersIcon {...railIcon} />} active>
              People
            </DashNavItem>
            <DashNavItem density="rail" icon={<CreditCardIcon {...railIcon} />}>
              Plan &amp; billing
            </DashNavItem>
            <DashNavItem density="rail" icon={<GearIcon {...railIcon} />}>
              General
            </DashNavItem>
          </nav>
        </AppRail>
        <DashMain className="[background:var(--paper)]">
          <DashHeader variant="bare" />
          <DashContent className="pt-2 md:pt-3">
            <DashTitle>Doop UI</DashTitle>
          </DashContent>
        </DashMain>
      </DashLayout>
    </div>
  ),
}

export const SearchPalette: Story = {
  name: 'Search palette',
  render: () => <CanvasSearchModal canvases={canvases} onOpen={() => {}} onClose={() => {}} />,
}
