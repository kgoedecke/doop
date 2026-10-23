import type { ComponentProps, CSSProperties } from 'react'
import { useStore, type PanelTab } from '../lib/store'
import { useOpenThreadCount } from '../lib/comments'
import { navigate } from '../App'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'
import { Tooltip } from './ui/tooltip'
import { BookOpenIcon, CommentIcon, GearIcon, HelpIcon, PulseIcon, SlidersIcon, WaypointsIcon } from './ui/icons'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu'
import { openSupportChat } from '../lib/posthog'
import { PresenceFace } from './PeerAvatars'

const islandBtn = 'relative size-7 rounded-[8px] text-ink-soft hover:bg-paper-deep hover:text-ink disabled:opacity-35'
const island =
  'pointer-events-auto absolute z-[38] flex w-10 flex-col items-center gap-1 rounded-[12px] bg-surface py-1.5 shadow-float'

/** The right-hand icon islands, sitting just left of the open panels. The top
 *  island offers what is hidden: the Inspector for a selected frame, and one
 *  button per tab of the Agents panel (agents, comments, activity, memory),
 *  each opening the panel on that tab, with a live dot while an agent works or
 *  a message waits. Open panels close from their own header. The bottom
 *  island holds Settings, Help (docs, support chat) and you. */
export function SideRail({
  style,
  agentsOpen,
  onToggleAgents,
  inspectorOpen,
  inspectorAvailable,
  onToggleInspector,
  me,
  onRenameSelf,
}: {
  /** carries `right`, so the islands follow the panels as they open */
  style: CSSProperties
  agentsOpen: boolean
  onToggleAgents: () => void
  inspectorOpen: boolean
  /** a frame is selected — there is something to inspect */
  inspectorAvailable: boolean
  onToggleInspector: () => void
  me: { name: string; color: string }
  onRenameSelf: () => void
}) {
  const setPanelTab = useStore((s) => s.setPanelTab)
  const openTab = (tab: PanelTab) => {
    setPanelTab(tab)
    onToggleAgents()
  }
  const showInspector = inspectorAvailable && !inspectorOpen

  return (
    <>
      {(showInspector || !agentsOpen) && (
        <nav aria-label="Canvas panels" className={cn(island, 'top-2.5')} style={style}>
          {showInspector && (
            <IslandControl label="Inspect frame" onClick={onToggleInspector}>
              <SlidersIcon className="size-3.5" />
            </IslandControl>
          )}
          {!agentsOpen && <PanelTabButtons onOpen={openTab} />}
        </nav>
      )}
      <nav aria-label="Account" className={cn(island, 'bottom-3.5 gap-1.5')} style={style}>
        <IslandControl label="Settings" onClick={() => navigate('/settings')}>
          <GearIcon className="size-3.5" />
        </IslandControl>
        <DropdownMenu>
          <Tooltip label="Help" side="left">
            <DropdownMenuTrigger asChild>
              <Button
                variant="bare"
                size="icon"
                aria-label="Help"
                className={cn(islandBtn, 'data-[state=open]:bg-paper-deep data-[state=open]:text-ink')}
              >
                <HelpIcon className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
          </Tooltip>
          <DropdownMenuContent side="left" align="end" width="sm">
            <DropdownMenuItem asChild>
              <a href="/docs" target="_blank" rel="noopener noreferrer">
                <BookOpenIcon /> Docs
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openSupportChat()}>
              <CommentIcon /> Contact support
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Tooltip label={`You are “${me.name}” — click to change your name`} side="left">
          <button
            type="button"
            aria-label="Change your display name"
            className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-faint"
            onClick={onRenameSelf}
          >
            <PresenceFace name={me.name} color={me.color} kind="user" size={26} className="text-[10px] shadow-none" />
          </button>
        </Tooltip>
      </nav>
    </>
  )
}

/** One button per tab of the Agents panel — agents, comments, activity,
 *  memory — each opening the panel on that tab, with a live dot while an
 *  agent works or a message waits. The desktop island stacks them; on phones
 *  they run along the top-right corner as their own island. */
export function PanelTabButtons({
  onOpen,
  tooltipSide = 'left',
}: {
  onOpen: (tab: PanelTab) => void
  tooltipSide?: 'left' | 'bottom'
}) {
  const working = useStore((s) => s.tasks.filter((t) => t.agentName && !t.endedAt && !t.failedAt).length)
  const proposalPending = useStore((s) => s.proposals.some((p) => p.status === 'pending'))
  const openThreads = useOpenThreadCount()
  return (
    <>
      <IslandControl
        side={tooltipSide}
        label={working ? `Agents · ${working} working · ⌘K to ask the Doop Agent` : 'Agents · ⌘K to ask the Doop Agent'}
        onClick={() => onOpen('tasks')}
      >
        <WaypointsIcon className="size-3.5" />
        {working > 0 && <IslandDot className="bg-success" />}
      </IslandControl>
      <IslandControl
        side={tooltipSide}
        label={openThreads ? `Comments · ${openThreads} open` : 'Comments'}
        onClick={() => onOpen('comments')}
      >
        <CommentIcon className="size-3.5" />
        {openThreads > 0 && <IslandDot className="bg-brand" />}
      </IslandControl>
      <IslandControl side={tooltipSide} label="Activity" onClick={() => onOpen('activity')}>
        <PulseIcon className="size-3.5" />
      </IslandControl>
      <IslandControl
        side={tooltipSide}
        label={proposalPending ? 'Memory · suggestion to review' : 'Memory'}
        onClick={() => onOpen('memory')}
      >
        <BookOpenIcon className="size-3.5" />
        {proposalPending && <IslandDot className="bg-brand" />}
      </IslandControl>
    </>
  )
}

/** The phone-sized island of those buttons, in the top-right corner under the bar. */
export function MobilePanelTabs({ onOpen }: { onOpen: (tab: PanelTab) => void }) {
  return (
    <nav
      aria-label="Canvas panels"
      className="pointer-events-auto absolute top-2 right-2 z-[38] flex items-center gap-1 rounded-[12px] bg-surface px-1.5 py-1 shadow-float"
    >
      <PanelTabButtons onOpen={onOpen} tooltipSide="bottom" />
    </nav>
  )
}

/** The small live dot on an island button's corner. */
function IslandDot({ className }: { className: string }) {
  return (
    <span className={cn('absolute -top-px -right-px size-2 rounded-full border-[1.5px] border-surface', className)} />
  )
}

function IslandControl({
  label,
  on = false,
  side = 'left',
  className,
  ...props
}: ComponentProps<typeof Button> & { label: string; on?: boolean; side?: 'left' | 'bottom' }) {
  return (
    <Tooltip label={label} side={side}>
      {/* a disabled button swallows pointer events — the span keeps the tooltip */}
      <span className="inline-flex">
        <Button
          variant="bare"
          size="icon"
          aria-label={label}
          className={cn(islandBtn, on && 'bg-surface text-ink shadow-ring hover:bg-surface', className)}
          {...props}
        />
      </span>
    </Tooltip>
  )
}
