import { useEffect, useMemo, useRef } from 'react'
import { navigate } from '../App'
import { api } from '../lib/api'
import { useT } from '../lib/i18n'
import { useStore } from '../lib/store'
import { agentLaunch, type AgentLaunchKind } from '../../shared/agentLaunch'
import { AppIcon, type AppIconBrand } from './ui/brand-mark'
import { Button } from './ui/button'
import { ChoiceList, ChoiceRow } from './ui/choice-list'
import { CodeBlock } from './ui/code-block'
import { ModalActions, ModalLede, ModalSource, ModalTitle } from './ui/modal'
import { Note } from './ui/note'
import { Step, Steps } from './ui/steps'

/** What to hand the person's own agent: the tools find the cards. */
export function repoCardsPrompt(canvasId: string, origin: string): string {
  return `On my Doop canvas ${origin}/c/${canvasId} (canvas_id ${canvasId}), take the queued GitHub import cards with take_repo_cards and build each one.`
}

/** Where a repo import with no Doop Agent stands: nobody to run it yet, or
 *  cards waiting for the person's own agent. */
export type RepoGuideState = { stage: 'connect' } | { stage: 'agent'; cardIds: string[]; client?: string }

const LAUNCH_ICONS: Record<AgentLaunchKind, AppIconBrand> = {
  'claude-code': 'claude-code',
  'claude-desktop': 'claude',
  claude: 'claude',
  chatgpt: 'openai',
  cursor: 'cursor',
  codex: 'codex',
  other: 'mcp',
}

/* how often the connect stage asks whether an agent finished connecting */
const CONNECT_POLL_MS = 4000

/**
 * A GitHub import for someone with no Doop Agent plan, in two stages:
 * choose who builds it (a plan, so Doop does, or an agent of their own),
 * then open that agent with the prompt filled in and watch it take the
 * cards. Connecting an agent from the first stage queues the import for it
 * without leaving the window.
 */
export function RepoAgentGuide({
  canvasId,
  repo,
  state,
  onConnectAgent,
  onAgentConnected,
  onClose,
}: {
  canvasId: string
  repo: string
  state: RepoGuideState
  /** open the Connect AI flow over this window */
  onConnectAgent: () => void
  /** an agent of their own is connected now: import again, for it */
  onAgentConnected: () => void
  onClose: () => void
}) {
  const t = useT()
  const header = (title: string) => (
    <div className="flex items-center gap-3">
      <AppIcon brand="github" size={40} />
      <div className="flex flex-col gap-[5px]">
        <ModalTitle>{title}</ModalTitle>
        <ModalSource href={`https://github.com/${repo}`}>{repo}</ModalSource>
      </div>
    </div>
  )

  if (state.stage === 'connect')
    return (
      <>
        {header(t('canvas.repoGuideConnectTitle'))}
        <ModalLede className="mt-3">{t('canvas.repoGuideConnectLede')}</ModalLede>
        <ConnectWatcher onConnected={onAgentConnected} />
        <ChoiceList className="mt-4">
          <ChoiceRow
            icon={<AppIcon brand="openai" size={32} />}
            title={t('canvas.repoGuidePlanTitle')}
            description={t('canvas.repoGuidePlanDescription')}
            onClick={() => navigate(`/settings?pane=agent&from=${encodeURIComponent(`/c/${canvasId}`)}`)}
          />
          <ChoiceRow
            icon={<AppIcon brand="mcp" size={32} />}
            title={t('canvas.repoGuideAgentTitle')}
            description={t('canvas.repoGuideAgentDescription')}
            onClick={onConnectAgent}
          />
        </ChoiceList>
        <ModalActions>
          <Button onClick={onClose}>{t('common.close')}</Button>
        </ModalActions>
      </>
    )

  return <AgentStage canvasId={canvasId} state={state} header={header} onClose={onClose} />
}

/** Asks, while the connect stage is up, whether an agent of their own has
 *  connected (the Connect AI flow finishes in another app or tab). */
function ConnectWatcher({ onConnected }: { onConnected: () => void }) {
  const latest = useRef(onConnected)
  useEffect(() => {
    latest.current = onConnected
  })
  useEffect(() => {
    let live = true
    const timer = window.setInterval(() => {
      api.agentAllowance().then(
        (allowance) => {
          if (live && allowance.connected) {
            window.clearInterval(timer)
            latest.current()
          }
        },
        () => {},
      )
    }, CONNECT_POLL_MS)
    return () => {
      live = false
      window.clearInterval(timer)
    }
  }, [])
  return null
}

function AgentStage({
  canvasId,
  state,
  header,
  onClose,
}: {
  canvasId: string
  state: Extract<RepoGuideState, { stage: 'agent' }>
  header: (title: string) => React.ReactNode
  onClose: () => void
}) {
  const t = useT()
  const prompt = repoCardsPrompt(canvasId, location.origin)
  const launch = agentLaunch(state.client, prompt)
  const progress = useImportProgress(state.cardIds)
  return (
    <>
      {header(t('canvas.repoForAgentTitle', { agent: launch.label }))}
      <ModalLede className="mt-3">{t('canvas.repoForAgentLede', { agent: launch.label })}</ModalLede>
      <Steps className="mt-4">
        <Step>
          {launch.url
            ? t('canvas.repoForAgentStepOpenLink', { agent: launch.label })
            : launch.command
              ? t('canvas.repoForAgentStepRun', { agent: launch.label })
              : t('canvas.repoForAgentStepPaste')}
        </Step>
        <Step>{t('canvas.repoForAgentStepWatch')}</Step>
      </Steps>
      {launch.url && (
        <Button
          variant="primary"
          className="mt-4 self-start"
          onClick={() => window.open(launch.url, '_blank', 'noopener')}
        >
          <AppIcon brand={LAUNCH_ICONS[launch.kind]} size={18} />
          {t('canvas.repoForAgentOpen', { agent: launch.label })}
        </Button>
      )}
      <CodeBlock className="mt-3" text={launch.command ?? prompt} />
      <Note size="sm" className="mt-3 block">
        {progress}
      </Note>
      <ModalActions>
        <Button onClick={onClose}>{t('common.close')}</Button>
      </ModalActions>
    </>
  )
}

/** One line on how far the agent got with this import's cards, live from
 *  the board's task messages. */
function useImportProgress(cardIds: string[]): string {
  const t = useT()
  const tasks = useStore((s) => s.tasks)
  return useMemo(() => {
    const mine = tasks.filter((task) => cardIds.includes(task.id))
    if (!mine.length) return t('canvas.repoProgressWaiting')
    const taken = mine.filter((task) => task.agentName)
    const landed = mine.filter((task) => task.endedAt).length
    const failed = mine.filter((task) => task.failedAt).length
    if (!taken.length) return t('canvas.repoProgressWaiting')
    return t('canvas.repoProgress', {
      agent: taken[0]!.agentName,
      taken: taken.length,
      total: mine.length,
      landed,
      failed,
    })
  }, [tasks, cardIds, t])
}
