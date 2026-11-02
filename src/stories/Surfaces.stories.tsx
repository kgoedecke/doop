import type { Meta, StoryObj } from '@storybook/react-vite'
import { Card, CardBody, CardDescription, CardHeader, CardRow, CardTitle, SettingsCard } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Callout } from '@/components/ui/callout'
import { Note } from '@/components/ui/note'
import { Badge } from '@/components/ui/badge'
import { Dot } from '@/components/ui/dot'
import { StatusLabel } from '@/components/ui/status-label'
import { Skeleton } from '@/components/ui/skeleton'
import { MetaLine, Tile, TileBody, TileCover } from '@/components/ui/tile'
import { AvatarStack } from '@/components/ui/avatar'
import { FramePreview } from '@/components/FramePreview'
import { Toast, ToastAction, ToastSpinner } from '@/components/ui/toast'
import { CodeBlock } from '@/components/ui/code-block'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ClockTile, MetaTile } from '@/components/AutomateShell'
import { FrameThumb } from '@/components/FramePreview'

const meta = { title: 'Primitives/Surfaces' } satisfies Meta
export default meta

type Story = StoryObj<typeof meta>

export const Cards: Story = {
  render: () => (
    <div className="flex max-w-[640px] flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Doop Agent</CardTitle>
          <CardDescription>
            Choose how the Doop Agent runs on your canvases: a connected model account or Claude CLI on your desktop.
          </CardDescription>
        </CardHeader>
        <CardBody>
          <CardRow label="Model" action={<Button size="sm">Change</Button>}>
            Claude Opus 5.5
          </CardRow>
        </CardBody>
      </Card>
      <Card tone="flat">
        <CardBody>A flat card: a hairline instead of the elevation ring.</CardBody>
      </Card>
    </div>
  ),
}

/** A settings-pane section: rows with a `control` line their fields up at one width
 *  (`md` 280px, `lg` 420px for a URL); on phones each row stacks and the field fills it. */
export const Settings: Story = {
  name: 'Settings card',
  render: () => (
    <div className="flex flex-col">
      <SettingsCard>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>Your name is the identity shown on cursors and in the activity feed.</CardDescription>
        </CardHeader>
        <CardRow label="Name" action={<Button size="sm">Save</Button>} control={<Input defaultValue="Ada Lovelace" />}>
          <Note>Changed — not saved yet</Note>
        </CardRow>
        <CardRow
          label="Webhook URL"
          controlWidth="lg"
          control={<Input placeholder="https://hooks.example.com/doop" />}
        />
        <CardRow label="Created">
          <span className="text-body text-ink-soft">2d ago</span>
        </CardRow>
      </SettingsCard>
      <SettingsCard tone="flat" className="border-accent-ink/30">
        <CardHeader>
          <CardTitle className="text-accent-ink">Delete workspace</CardTitle>
          <CardDescription>The danger zone is the same shell in the flat tone.</CardDescription>
        </CardHeader>
        <CardBody>
          <Button variant="danger">Delete “Studio”</Button>
        </CardBody>
      </SettingsCard>
    </div>
  ),
}

export const Notices: Story = {
  name: 'Callouts, notes, badges, dots',
  render: () => (
    <div className="flex max-w-[640px] flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Callout>Your free tasks are used up.</Callout>
        <Callout tone="success">Connected — the agent runs on your subscription.</Callout>
        <Callout tone="error">Couldn’t reach Figma. Check the token and try again.</Callout>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <Note>12 frames · edited 2d ago</Note>
        <Note tone="success">Saved</Note>
        <Note tone="error">Couldn’t save</Note>
        <Note size="sm">A larger note</Note>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge>free</Badge>
        <Badge tone="accent">team</Badge>
        <Badge tone="outline">Not connected</Badge>
        <Badge tone="admin">admin</Badge>
        <Badge tone="banned">banned</Badge>
        <Badge tone="brand">Popular</Badge>
        <Badge tone="success">verified</Badge>
        <Badge tone="accent" interactive>
          unclaimed — make mine
        </Badge>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge shape="pill">kgoedecke/doop@main</Badge>
        <Badge shape="pill">doop.design</Badge>
        <Badge shape="pill">A Figma file with a name long enough to truncate at the pill’s limit</Badge>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <StatusLabel tone="done">connected</StatusLabel>
        <StatusLabel>not connected</StatusLabel>
      </div>
      <div className="flex flex-wrap items-center gap-4 text-body text-ink-soft">
        <span className="flex items-center gap-2">
          <Dot tone="running" /> running
        </span>
        <span className="flex items-center gap-2">
          <Dot tone="done" /> done
        </span>
        <span className="flex items-center gap-2">
          <Dot tone="failed" /> failed
        </span>
        <span className="flex items-center gap-2">
          <Dot tone="idle" /> idle
        </span>
        <span className="flex items-center gap-2">
          <Dot tone="muted" size="sm" /> muted, small
        </span>
      </div>
    </div>
  ),
}

/** The cover-and-meta tile Home, Community and the admin index lay out in a grid. */
export const Tiles: Story = {
  render: () => (
    <div className="grid max-w-[760px] grid-cols-3 gap-4">
      <Tile>
        <TileCover aspect="5/3">
          <FramePreview frameId={undefined} />
        </TileCover>
        <TileBody className="flex items-center gap-2.5">
          <div className="min-w-0 flex-1">
            <div className="truncate text-body font-medium">Pricing page</div>
            <MetaLine className="mt-[3px]">
              <span>Edited 2h ago</span>
              <span>Acme</span>
            </MetaLine>
          </div>
          <AvatarStack
            size={18}
            people={[
              { id: 'a', name: 'Ada Lovelace', color: '#0177d3' },
              { id: 'b', name: 'Grace Hopper', color: '#c2410c' },
            ]}
          />
        </TileBody>
      </Tile>
      <Tile>
        <TileCover aspect="16/10">
          <FramePreview frameId={undefined} empty="no preview" />
          <Badge className="absolute left-2 top-2 bg-surface/90">4 frames</Badge>
        </TileCover>
        <TileBody>
          <div className="truncate font-display text-copy font-semibold">Onboarding flow</div>
          <MetaLine className="mt-[7px]">
            <span className="truncate">by Ada Lovelace</span>
            <span className="flex-none">12 copies</span>
          </MetaLine>
        </TileBody>
      </Tile>
      <Tile tone="solid">
        <TileCover aspect="4/3">
          <FramePreview frameId={undefined} />
        </TileCover>
        <TileBody>
          <div className="truncate font-display text-copy font-semibold">Launch deck</div>
          <MetaLine className="mt-[5px] flex-wrap" trailing={<Badge>link on</Badge>}>
            <span>Grace Hopper</span>
            <span>8 frames</span>
            <span>3d ago</span>
          </MetaLine>
        </TileBody>
      </Tile>
    </div>
  ),
}

export const Loading: Story = {
  name: 'Skeleton & toast',
  render: () => (
    <div className="flex max-w-[760px] flex-col gap-5">
      <div className="grid grid-cols-3 gap-4">
        <Skeleton shape="tile" aspect="5/3" />
        <Skeleton index={1} shape="tile" aspect="16/10" />
        <Skeleton index={2} shape="tile" aspect="4/3" />
      </div>
      <div className="flex flex-col gap-2">
        <Skeleton shape="row" />
        <Skeleton index={1} shape="row" />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Skeleton shape="card" />
        <Skeleton index={1} shape="card" />
      </div>
      <div className="relative h-20">
        <Toast className="absolute bottom-0 left-0">
          <ToastSpinner /> Duplicating canvas…
          <ToastAction>Undo</ToastAction>
        </Toast>
      </div>
    </div>
  ),
}

export const Code: Story = {
  render: () => (
    <div className="flex max-w-[520px] flex-col gap-3">
      <CodeBlock text="claude mcp add --transport http doop https://doop.design/mcp" />
      <CodeBlock density="rail" text="claude mcp add --transport http doop https://doop.design/mcp" />
    </div>
  ),
}

/** A frame's preview in its boxed well, per size: empty, and a render that failed to load
 *  (the catalogue has no frame renders, so any frame id shows the failure state). */
export const Thumbs: Story = {
  name: 'Frame thumb',
  render: () => (
    <div className="flex max-w-[640px] flex-col gap-5">
      {(['xs', 'sm'] as const).map((size) => (
        <div key={size} className="flex items-center gap-4">
          <span className="w-6 font-mono text-micro text-ink-faint">{size}</span>
          <FrameThumb size={size} />
          <FrameThumb size={size} frameId="missing" />
        </div>
      ))}
      <div className="flex items-start gap-4">
        <span className="w-6 font-mono text-micro text-ink-faint">md</span>
        <div className="grid flex-1 grid-cols-2 gap-3">
          <FrameThumb size="md" />
          <FrameThumb size="md" frameId="missing" />
        </div>
      </div>
    </div>
  ),
}

/** The hero card a list shows before it has rows, and the dashed placeholder a table page shows. */
export const Empty: Story = {
  name: 'Empty state',
  render: () => (
    <div className="flex max-w-[640px] flex-col gap-6">
      <EmptyState
        title="Start your first canvas"
        description="A canvas is a shared space of live HTML frames — you design in the browser, your AI agents design through MCP, and everyone watches everything happen in real time."
        action={<Button variant="primary">+ Create a canvas</Button>}
      />
      <EmptyState
        variant="dashed"
        illustration={
          <>
            <ClockTile size={36} />
            <span className="h-px w-[22px] bg-line" aria-hidden />
            <MetaTile size={36} className="border border-line bg-surface" />
          </>
        }
        title="Nothing runs on its own yet"
        description="Pull designs in on a schedule, or hand a canvas to an agent every week."
        action={<Button variant="primary">+ New automation</Button>}
      />
    </div>
  ),
}
