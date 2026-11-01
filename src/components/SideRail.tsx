import type { CSSProperties } from 'react'
import { useStore, type PanelTab } from '../lib/store'
import { useOpenThreadCount } from '../lib/comments'
import { navigate } from '../App'
import { cn } from '@/lib/utils'
import { Tooltip } from './ui/tooltip'
import { Toolbar, ToolbarButton, ToolbarControl, ToolbarDot } from './ui/toolbar'
import { BookOpenIcon, CommentIcon, GearIcon, HelpIcon, PulseIcon, SlidersIcon, SparkIcon } from './ui/icons'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu'
import { openSupportChat } from '../lib/posthog'
import { PresenceFace } from './PeerAvatars'
import { useT } from '../lib/i18n'

const island = 'pointer-events-auto absolute z-[38]'

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
  const t = useT()
  const setPanelTab = useStore((s) => s.setPanelTab)
  const openTab = (tab: PanelTab) => {
    setPanelTab(tab)
    onToggleAgents()
  }
  const showInspector = inspectorAvailable && !inspectorOpen

  return (
    <>
      {(showInspector || !agentsOpen) && (
        <Toolbar
          aria-label={t('canvas.canvasPanels')}
          orientation="vertical"
          className={cn(island, 'top-2.5')}
          style={style}
        >
          {showInspector && (
            <ToolbarControl label={t('canvas.inspectFrame')} onClick={onToggleInspector}>
              <SlidersIcon />
            </ToolbarControl>
          )}
          {!agentsOpen && <PanelTabButtons onOpen={openTab} />}
        </Toolbar>
      )}
      <Toolbar
        aria-label={t('shell.account')}
        orientation="vertical"
        className={cn(island, 'bottom-3.5 gap-1.5')}
        style={style}
      >
        <ToolbarControl label={t('shell.settings')} onClick={() => navigate('/settings')}>
          <GearIcon />
        </ToolbarControl>
        <DropdownMenu>
          <Tooltip label={t('canvas.help')} side="left">
            <DropdownMenuTrigger asChild>
              <ToolbarButton
                aria-label={t('canvas.help')}
                className="data-[state=open]:bg-paper-deep data-[state=open]:text-ink"
              >
                <HelpIcon />
              </ToolbarButton>
            </DropdownMenuTrigger>
          </Tooltip>
          <DropdownMenuContent side="left" align="end" width="sm">
            <DropdownMenuItem asChild>
              <a href="/docs" target="_blank" rel="noopener noreferrer">
                <BookOpenIcon /> {t('canvas.docs')}
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openSupportChat()}>
              <CommentIcon /> {t('canvas.contactSupport')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Tooltip label={t('canvas.youAre', { name: me.name })} side="left">
          <button
            type="button"
            aria-label={t('canvas.changeDisplayName')}
            className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-faint"
            onClick={onRenameSelf}
          >
            <PresenceFace name={me.name} color={me.color} kind="user" size={26} className="text-[10px] shadow-none" />
          </button>
        </Tooltip>
      </Toolbar>
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
  const t = useT()
  const working = useStore((s) => s.tasks.filter((t) => t.agentName && !t.endedAt && !t.failedAt).length)
  const proposalPending = useStore((s) => s.proposals.some((p) => p.status === 'pending'))
  const openThreads = useOpenThreadCount()
  return (
    <>
      <ToolbarControl
        side={tooltipSide}
        label={working ? t('canvas.agentsWorking', { working }) : t('canvas.agents')}
        onClick={() => onOpen('tasks')}
      >
        <SparkIcon />
        {working > 0 && <ToolbarDot className="bg-success" />}
      </ToolbarControl>
      <ToolbarControl
        side={tooltipSide}
        label={openThreads ? t('canvas.commentsOpen', { open: openThreads }) : t('canvas.comments')}
        onClick={() => onOpen('comments')}
      >
        <CommentIcon />
        {openThreads > 0 && <ToolbarDot className="bg-brand" />}
      </ToolbarControl>
      <ToolbarControl side={tooltipSide} label={t('canvas.activity')} onClick={() => onOpen('activity')}>
        <PulseIcon />
      </ToolbarControl>
      <ToolbarControl
        side={tooltipSide}
        label={proposalPending ? t('canvas.memorySuggestion') : t('canvas.memory')}
        onClick={() => onOpen('memory')}
      >
        <BookOpenIcon />
        {proposalPending && <ToolbarDot className="bg-brand" />}
      </ToolbarControl>
    </>
  )
}

/** The phone-sized island of those buttons, in the top-right corner under the bar. */
export function MobilePanelTabs({ onOpen }: { onOpen: (tab: PanelTab) => void }) {
  const t = useT()
  return (
    <Toolbar aria-label={t('canvas.canvasPanels')} className={cn(island, 'top-2 right-2')}>
      <PanelTabButtons onOpen={onOpen} tooltipSide="bottom" />
    </Toolbar>
  )
}
