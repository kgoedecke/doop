import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { navigate } from '../App'
import { useStore } from '../lib/store'
import { roleByAgentName } from '../../shared/agents'
import { posthog } from '../lib/posthog'
import { useT, type PlainMessageKey, type Translate } from '../lib/i18n'
import { canUseChatGPTPublicEndpoint, CHATGPT_CONNECTION_GUIDE, CHATGPT_PLUGINS_URL } from '../lib/chatgptConnection'
import { ClaudeDesktopInstall } from './ClaudeDesktopInstall'
import { canAddToClaudeDesktop, claudeConnectorInstallUrl } from '../lib/claudeConnection'
import { CursorInstall } from './CursorInstall'
import { CodexInstall } from './CodexInstall'
import { AppIcon, type AppIconBrand } from './ui/brand-mark'
import { Button } from './ui/button'
import { ChoiceList, ChoiceRow } from './ui/choice-list'
import { CodeBlock } from './ui/code-block'
import { Disclosure } from './ui/collapsible'
import { Dot } from './ui/dot'
import { CheckIcon, ChevronLeftIcon } from './ui/icons'
import { Modal, ModalActions, ModalLede, ModalSpacer, ModalTitle } from './ui/modal'
import { cn } from '@/lib/utils'
import { isDesktopShell } from '../lib/shell'

/**
 * "Connect AI" is about agents that join the canvas from outside: Claude Code,
 * Codex, Cursor, the Claude or ChatGPT apps, or any MCP client. Pick the agent,
 * then follow its own three steps. Running the built-in Doop Agent on your own
 * ChatGPT or Claude plan is an account setting and lives in Settings, next to
 * the prompt bar's allowance meter — not here.
 */

type AgentId = 'claude-code' | 'claude' | 'chatgpt' | 'codex' | 'cursor' | 'mcp' | 'headless'
type View = 'agents' | AgentId
type ClaudeConnection = 'desktop' | 'web'
/** how a generic MCP client signs in: a person approves it in a browser, or it sends an agent key */
type McpConnection = 'browser' | 'key'

/** a product's own name stays as it is; the generic client is named in the reader's language */
type AgentOption = {
  id: AgentId
  blurb: PlainMessageKey
  /** its app icon, as Settings → Doop Agent shows the providers */
  icon: AppIconBrand
} & ({ name: string } | { nameKey: PlainMessageKey })

const AGENTS: AgentOption[] = [
  { id: 'claude-code', name: 'Claude Code', blurb: 'connect.blurbClaudeCode', icon: 'claude-code' },
  { id: 'claude', name: 'Claude', blurb: 'connect.blurbClaude', icon: 'claude' },
  { id: 'chatgpt', name: 'ChatGPT', blurb: 'connect.blurbChatgpt', icon: 'openai' },
  { id: 'codex', name: 'Codex', blurb: 'connect.blurbCodex', icon: 'codex' },
  { id: 'cursor', name: 'Cursor', blurb: 'connect.blurbCursor', icon: 'cursor' },
  { id: 'mcp', nameKey: 'connect.otherClientName', blurb: 'connect.blurbOtherClient', icon: 'mcp' },
  { id: 'headless', nameKey: 'connect.headlessName', blurb: 'connect.blurbHeadless', icon: 'headless' },
]

const agentById = (id: AgentId): AgentOption => AGENTS.find((agent) => agent.id === id) ?? AGENTS[0]!

const agentName = (agent: AgentOption, t: Translate): string => ('name' in agent ? agent.name : t(agent.nameKey))

/** `canvasId` is optional: opened from the home dashboard there is no canvas to
 *  suggest a prompt for, and no presence connection to watch for an arrival. */
export function ConnectModal({
  canvasId,
  onClose,
  initialAgent,
  showAgentStatus = true,
}: {
  canvasId?: string
  onClose: () => void
  initialAgent?: AgentId
  /** Standalone setup can suggest a canvas without subscribing to its presence. */
  showAgentStatus?: boolean
}) {
  const [view, setView] = useState<View>(initialAgent ?? 'agents')
  return (
    <Modal size="lg" className="flex flex-col overflow-hidden p-0 sm:p-0" onClose={onClose}>
      {view === 'agents' ? (
        <AgentPicker onPick={setView} />
      ) : (
        <AgentSteps
          agent={view}
          canvasId={canvasId}
          showAgentStatus={showAgentStatus}
          onBack={() => setView('agents')}
          onClose={onClose}
        />
      )}
    </Modal>
  )
}

/* ---------- pick the agent, then its three steps ---------- */

function AgentPicker({ onPick }: { onPick: (agent: AgentId) => void }) {
  const t = useT()
  return (
    <div className={body}>
      <ModalTitle>{t('connect.chooseTitle')}</ModalTitle>
      <ModalLede>{t('connect.chooseLede')}</ModalLede>
      <ChoiceList className="mt-5">
        {AGENTS.map((option) => (
          <ChoiceRow
            key={option.id}
            icon={<AppIcon brand={option.icon} />}
            title={agentName(option, t)}
            description={t(option.blurb)}
            onClick={() => {
              posthog.capture('connect_ai_agent_chosen', { agent: option.id })
              onPick(option.id)
            }}
          />
        ))}
      </ChoiceList>
    </div>
  )
}

interface Step {
  title: string
  body: ReactNode
  code?: string
  action?: ReactNode
}

interface StepOptions {
  claudeConnection: ClaudeConnection
  mcpConnection: McpConnection
  canvasId?: string | undefined
  /** opens Settings → Agent keys, coming back to this canvas */
  openAgentKeys: () => void
}

/** An agent with no browser to sign in with: an agent key, sent as a bearer header. */
function agentKeySteps(t: Translate, mcpUrl: string, pointAt: Step, openAgentKeys: () => void) {
  const config = JSON.stringify(
    { mcpServers: { doop: { type: 'http', url: mcpUrl, headers: { Authorization: 'Bearer dpk_…' } } } },
    null,
    2,
  )
  return {
    lede: t('connect.agentKeyLede'),
    steps: [
      {
        title: t('connect.agentKeyCreateTitle'),
        body: t('connect.agentKeyCreateBody'),
        action: (
          <Button variant="solid" className="mt-2.5" onClick={openAgentKeys}>
            {t('connect.agentKeyOpen')}
          </Button>
        ),
      },
      { title: t('connect.agentKeySendTitle'), body: t('connect.agentKeySendBody'), code: config },
      pointAt,
    ],
  }
}

function agentSteps(
  t: Translate,
  agent: AgentId,
  mcpUrl: string,
  prompt: string,
  { claudeConnection, mcpConnection, canvasId, openAgentKeys }: StepOptions,
): { lede: string; steps: Step[] } {
  const jsonConfig = JSON.stringify({ mcpServers: { doop: { type: 'http', url: mcpUrl } } }, null, 2)
  const pointAt: Step = {
    title: t('connect.pointAtTitle'),
    body: prompt ? t('connect.pointAtWithPrompt') : t('connect.pointAtNoPrompt'),
    code: prompt || undefined,
  }
  switch (agent) {
    case 'claude-code':
      return {
        lede: t('connect.claudeCodeLede'),
        steps: [
          {
            title: t('connect.claudeCodeAddTitle'),
            body: (
              <>
                {t('connect.claudeCodeAddBefore')}
                <code>doop</code>
                {t('connect.claudeCodeAddAfter')}
              </>
            ),
            code: `claude mcp add --transport http doop "${mcpUrl}"`,
          },
          {
            title: t('connect.claudeCodeSignInTitle'),
            body: (
              <>
                {t('connect.claudeCodeSignInBefore')}
                <code>/mcp</code>
                {t('connect.claudeCodeSignInPick')}
                <strong>doop</strong>
                {t('connect.claudeCodeSignInThen')}
                {/* Claude Code's own menu label, which it shows in English */}
                <strong>Authenticate</strong>
                {t('connect.claudeCodeSignInAfter')}
              </>
            ),
          },
          pointAt,
        ],
      }
    case 'claude':
      if (claudeConnection === 'desktop') {
        return {
          lede: t('connect.claudeDesktopLede'),
          steps: [
            {
              title: t('connect.claudeDesktopAddTitle'),
              body: t('connect.claudeDesktopAddBody'),
              action: <ClaudeDesktopInstall mcpUrl={mcpUrl} />,
            },
            {
              title: t('connect.claudeDesktopConnectTitle'),
              body: t('connect.claudeDesktopConnectBody'),
            },
            {
              ...pointAt,
              body: prompt ? t('connect.claudeDesktopPointWithPrompt') : t('connect.claudeDesktopPointNoPrompt'),
            },
          ],
        }
      }
      if (!claudeConnectorInstallUrl(mcpUrl)) {
        return {
          lede: t('connect.claudePublicLede'),
          steps: [
            {
              title: t('connect.claudeLocalTitle'),
              body: t('connect.claudeLocalBody'),
            },
          ],
        }
      }
      return {
        lede: t('connect.claudeWebLede'),
        steps: [
          {
            title: t('connect.claudeWebAddTitle'),
            body: t('connect.claudeWebAddBody'),
            action: (
              <Button asChild variant="solid" className="mt-2.5">
                <a
                  href={claudeConnectorInstallUrl(mcpUrl)!}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => posthog.capture('claude_connector_opened')}
                >
                  {t('connect.addToClaude')}
                </a>
              </Button>
            ),
          },
          {
            title: t('connect.approveSignInTitle'),
            body: t('connect.claudeWebApproveBody'),
          },
          {
            ...pointAt,
            body: prompt ? t('connect.claudeWebPointWithPrompt') : t('connect.claudeWebPointNoPrompt'),
          },
        ],
      }
    case 'chatgpt':
      if (!canUseChatGPTPublicEndpoint(mcpUrl)) {
        return {
          lede: t('connect.chatgptPublicLede'),
          steps: [
            {
              title: t('connect.chatgptReachTitle'),
              body: t('connect.chatgptReachBody'),
              code: mcpUrl,
              action: (
                <Button asChild variant="solid" className="mt-2.5">
                  <a href={CHATGPT_CONNECTION_GUIDE} target="_blank" rel="noopener noreferrer">
                    {t('connect.chatgptGuide')}
                  </a>
                </Button>
              ),
            },
          ],
        }
      }
      return {
        lede: t('connect.chatgptLede'),
        steps: [
          {
            title: t('connect.chatgptOpenTitle'),
            body: (
              <>
                {t('connect.chatgptOpenBefore')}
                <strong>+</strong>
                {t('connect.chatgptOpenMiddle')}
                {/* ChatGPT's own menu label */}
                <strong>Add custom MCP server</strong>
                {t('connect.chatgptOpenAfter')}
              </>
            ),
            action: (
              <Button asChild variant="solid" className="mt-2.5">
                <a
                  href={CHATGPT_PLUGINS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => posthog.capture('chatgpt_connection_opened')}
                >
                  {t('connect.chatgptOpenButton')}
                </a>
              </Button>
            ),
          },
          {
            title: t('connect.chatgptAddTitle'),
            body: (
              <>
                {t('connect.chatgptAddBefore')}
                <strong>Doop</strong>
                {t('connect.chatgptAddDescribe')}
                <strong>OAuth</strong>
                {t('connect.chatgptAddReview')}
                {/* ChatGPT's own button label */}
                <strong>Create as a plugin</strong>
                {t('connect.chatgptAddAfter')}
              </>
            ),
            code: mcpUrl,
          },
          {
            ...pointAt,
            body: prompt ? t('connect.chatgptPointWithPrompt') : t('connect.chatgptPointNoPrompt'),
          },
        ],
      }
    case 'codex':
      return {
        lede: t('connect.codexLede'),
        steps: [
          {
            title: t('connect.codexAddTitle'),
            body: t('connect.codexAddBody'),
            action: <CodexInstall mcpUrl={mcpUrl} canvasId={canvasId} />,
          },
          {
            title: t('connect.codexSignInTitle'),
            body: t('connect.codexSignInBody'),
            code: 'codex mcp login doop',
          },
          pointAt,
        ],
      }
    case 'cursor':
      return {
        lede: t('connect.cursorLede'),
        steps: [
          {
            title: t('connect.cursorAddTitle'),
            body: t('connect.cursorAddBody'),
            action: <CursorInstall mcpUrl={mcpUrl} />,
          },
          {
            title: t('connect.approveSignInTitle'),
            body: t('connect.cursorApproveBody'),
          },
          {
            ...pointAt,
            body: prompt ? t('connect.cursorPointWithPrompt') : t('connect.cursorPointNoPrompt'),
          },
        ],
      }
    case 'headless':
      return agentKeySteps(t, mcpUrl, pointAt, openAgentKeys)
    case 'mcp':
      if (mcpConnection === 'key') return agentKeySteps(t, mcpUrl, pointAt, openAgentKeys)
      return {
        lede: t('connect.mcpLede'),
        steps: [
          {
            title: t('connect.mcpConfigTitle'),
            body: (
              <>
                {t('connect.mcpConfigBefore')}
                <code>doop</code>
                {t('connect.mcpConfigAfter')}
              </>
            ),
            code: jsonConfig,
          },
          {
            title: t('connect.approveSignInTitle'),
            body: t('connect.mcpApproveBody'),
          },
          pointAt,
        ],
      }
  }
}

function AgentSteps({
  agent,
  canvasId,
  showAgentStatus,
  onBack,
  onClose,
}: {
  agent: AgentId
  canvasId?: string
  showAgentStatus: boolean
  onBack: () => void
  onClose: () => void
}) {
  const t = useT()
  const option = agentById(agent)
  const name = agentName(option, t)
  const mcpUrl = `${location.origin}/mcp`
  const [claudeConnection, setClaudeConnection] = useState<ClaudeConnection>(() =>
    canAddToClaudeDesktop() || !claudeConnectorInstallUrl(mcpUrl) ? 'desktop' : 'web',
  )
  /* Deliberately thin: the MCP server ships its own INSTRUCTIONS on connect and the
     rest lives behind get_guide. The only thing this prompt knows that they don't is
     which canvas the human is looking at. */
  const prompt = canvasId
    ? `Work on Doop canvas ${canvasId}. Start with get_guide({ topic: "doop-instructions" }) and follow it.`
    : ''
  const [mcpConnection, setMcpConnection] = useState<McpConnection>('browser')
  /* a browser keeps these steps open beside the new tab; the desktop shell's
     tabs hold canvases only, and the system browser may not be signed in, so
     there it goes in place and Settings' back link returns to the canvas */
  const openAgentKeys = () => {
    const from = canvasId ? `&from=${encodeURIComponent(`/c/${canvasId}`)}` : ''
    if (isDesktopShell()) navigate(`/settings?pane=keys${from}`)
    else window.open('/settings?pane=keys', '_blank', 'noopener')
  }
  const { lede, steps } = agentSteps(t, agent, mcpUrl, prompt, {
    claudeConnection,
    mcpConnection,
    canvasId,
    openAgentKeys,
  })
  return (
    <>
      <div className={body}>
        <div className="flex items-center gap-3.5">
          <AppIcon brand={option.icon} size={40} />
          <div>
            <ModalTitle>{t('connect.connectAgentTitle', { name })}</ModalTitle>
            <ModalLede className="mt-1">{lede}</ModalLede>
          </div>
        </div>

        {agent === 'claude' && (
          <MethodSwitch
            label={t('connect.claudeMethodAria')}
            value={claudeConnection}
            onChange={setClaudeConnection}
            options={[
              { id: 'web', label: t('connect.connectOnline') },
              { id: 'desktop', label: t('connect.desktopApp') },
            ]}
          />
        )}
        {agent === 'mcp' && (
          <MethodSwitch
            label={t('connect.mcpMethodAria')}
            value={mcpConnection}
            onChange={setMcpConnection}
            options={[
              { id: 'browser', label: t('connect.mcpBrowser') },
              { id: 'key', label: t('connect.mcpAgentKey') },
            ]}
          />
        )}

        <ol className="mt-6">
          {steps.map((step, i) => (
            <li
              key={step.title}
              className={cn('grid grid-cols-[28px_1fr] gap-3.5', i > 0 && 'mt-3.5 border-t border-line-soft pt-3.5')}
            >
              <span className="mt-px grid size-[26px] place-items-center rounded-full bg-ink text-xs font-bold text-paper">
                {i + 1}
              </span>
              <div>
                <h4 className="text-copy font-semibold text-ink">{step.title}</h4>
                <p className="mt-0.5 text-body leading-[1.5] text-ink-soft [&_code]:rounded-[4px] [&_code]:bg-paper-deep [&_code]:px-1 [&_code]:font-mono [&_code]:text-caption [&_code]:text-ink">
                  {step.body}
                </p>
                {step.code && <CodeBlock text={step.code} className="mt-2.5" />}
                {step.action}
              </div>
            </li>
          ))}
        </ol>

        {agent === 'claude' && claudeConnection === 'web' && claudeConnectorInstallUrl(mcpUrl) && (
          <Disclosure label={t('connect.connectionHelp')} className="mt-4 text-label leading-relaxed text-ink-soft">
            <p>
              {t('connect.helpBefore')}
              {/* Claude's own menu path */}
              <strong>Customize → Connectors → Add custom connector</strong>
              {t('connect.helpAfter')}
            </p>
            <CodeBlock text={mcpUrl} className="mt-2" />
          </Disclosure>
        )}
      </div>

      <ModalActions className={footer}>
        {canvasId && showAgentStatus ? <AgentArrival name={name} /> : <ModalSpacer />}
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-sm px-2 py-2 text-xs font-medium text-ink-soft hover:text-ink"
          onClick={onBack}
        >
          <ChevronLeftIcon width={14} height={14} />
          {t('common.back')}
        </button>
        <Button onClick={onClose}>{t('connect.done')}</Button>
      </ModalActions>
    </>
  )
}

/* ---------- shared pieces ---------- */

/* The modal is a column: the screen's body scrolls in the middle and the
   action row sits on the bottom edge, so the back button and the main action
   stay in reach on the long agent screens (the JSON config plus the headless
   note runs past a laptop viewport). */
const body = 'min-h-0 flex-1 overflow-y-auto p-5'
const footer = 'mt-0 shrink-0 items-center border-t border-line-soft bg-surface px-5 py-4'

/** The pressed-button pair that picks how an agent connects (Claude's app
 *  or online; a generic client's browser sign-in or agent key). */
function MethodSwitch<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: T
  onChange: (value: T) => void
  options: { id: T; label: string }[]
}) {
  return (
    <div className="mt-5 flex gap-2" role="group" aria-label={label}>
      {options.map((option) => (
        <Button
          key={option.id}
          size="sm"
          variant={value === option.id ? 'solid' : 'ghost'}
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  )
}

/** Live connection status: flips the moment an outside (non-resident) agent
 *  joins this canvas's presence, so nobody is left wondering whether the
 *  OAuth dance actually worked. */
export function AgentArrival({ name }: { name?: string }) {
  const t = useT()
  const presences = useStore((s) => s.presences)
  const arrived = useMemo(
    () => Object.values(presences).find((p) => p.kind === 'agent' && !roleByAgentName(p.name)),
    [presences],
  )
  return arrived ? (
    <span className="mr-auto inline-flex items-center gap-[7px] text-body text-success-ink">
      <CheckIcon size={14} />
      {t('connect.arrived', { name: arrived.name })}
    </span>
  ) : (
    <span className="mr-auto inline-flex items-center gap-[7px] text-body text-ink-faint">
      <Dot className="animate-[arrival-pulse_1.6s_ease-in-out_infinite] bg-brand" />{' '}
      {t('connect.listening', { name: name ?? t('connect.yourAgent') })}
    </span>
  )
}
