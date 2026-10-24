import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { navigate } from '../App'
import { useStore } from '../lib/store'
import { roleByAgentName } from '../../shared/agents'
import { posthog } from '../lib/posthog'
import { canUseChatGPTPublicEndpoint, CHATGPT_CONNECTION_GUIDE, CHATGPT_PLUGINS_URL } from '../lib/chatgptConnection'
import { AgentIcon } from './AgentIcon'
import { ClaudeDesktopInstall } from './ClaudeDesktopInstall'
import { canAddToClaudeDesktop, claudeConnectorInstallUrl } from '../lib/claudeConnection'
import { CursorInstall } from './CursorInstall'
import { CodexInstall } from './CodexInstall'
import { Button } from './ui/button'
import { CodeBlock } from './ui/code-block'
import { Disclosure } from './ui/collapsible'
import { Dot } from './ui/dot'
import { ChevronLeftIcon, PuzzleIcon } from './ui/icons'
import { Modal, ModalActions, ModalLede, ModalSpacer, ModalTitle } from './ui/modal'
import { barPrimaryBtn } from './TopBar'
import { cn } from '@/lib/utils'

/**
 * "Connect AI" is about agents that join the canvas from outside: Claude Code,
 * Codex, Cursor, the Claude or ChatGPT apps, or any MCP client. Pick the agent,
 * then follow its own three steps. Running the built-in Doop Agent on your own
 * ChatGPT or Claude plan is an account setting and lives in Settings, next to
 * the prompt bar's allowance meter — not here.
 */

type AgentId = 'claude-code' | 'claude' | 'chatgpt' | 'codex' | 'cursor' | 'mcp'
type View = 'agents' | AgentId
type ClaudeConnection = 'desktop' | 'web'

interface AgentOption {
  id: AgentId
  name: string
  blurb: string
  icon: ReactNode
}

const AGENTS: AgentOption[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    blurb: 'Connect from your terminal',
    icon: <AgentIcon name="claude" size={20} />,
  },
  { id: 'claude', name: 'Claude', blurb: 'Add Doop to Claude', icon: <AgentIcon name="claude" size={20} /> },
  { id: 'chatgpt', name: 'ChatGPT', blurb: 'Connect in your browser', icon: <AgentIcon name="gpt" size={20} /> },
  { id: 'codex', name: 'Codex', blurb: 'ChatGPT desktop and Codex CLI', icon: <AgentIcon name="codex" size={20} /> },
  {
    id: 'cursor',
    name: 'Cursor',
    blurb: 'Add Doop to Cursor',
    icon: <AgentIcon name="cursor" size={20} />,
  },
  {
    id: 'mcp',
    name: 'Other MCP client',
    blurb: 'Use a manual connection',
    icon: <PuzzleIcon width={20} height={20} />,
  },
]

const agentById = (id: AgentId): AgentOption => AGENTS.find((agent) => agent.id === id) ?? AGENTS[0]!

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
  const [agent, setAgent] = useState<AgentId>('claude-code')
  return (
    <>
      <div className={body}>
        <ModalTitle>Choose your agent</ModalTitle>
        <ModalLede>
          Let an agent you already use work on this canvas via MCP. Choose yours to see its connection instructions.
        </ModalLede>

        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          {AGENTS.map((option) => (
            <ChoiceCard
              key={option.id}
              selected={agent === option.id}
              onClick={() => setAgent(option.id)}
              icon={option.icon}
              title={option.name}
              blurb={option.blurb}
            />
          ))}
        </div>
      </div>

      <ModalActions className={footer}>
        <Button
          variant="primary"
          className={barPrimaryBtn}
          onClick={() => {
            posthog.capture('connect_ai_agent_chosen', { agent })
            onPick(agent)
          }}
        >
          Connect
        </Button>
      </ModalActions>
    </>
  )
}

interface Step {
  title: string
  body: ReactNode
  code?: string
  action?: ReactNode
}

function agentSteps(
  agent: AgentId,
  mcpUrl: string,
  prompt: string,
  claudeConnection: ClaudeConnection,
  canvasId?: string,
): { lede: string; steps: Step[] } {
  const jsonConfig = JSON.stringify({ mcpServers: { doop: { type: 'http', url: mcpUrl } } }, null, 2)
  const pointAt: Step = {
    title: 'Point it at this canvas',
    body: prompt
      ? 'Paste this as your first message. Everything else the agent needs comes from the server.'
      : 'Open a canvas and tell the agent to work on it. Everything else it needs comes from the server.',
    code: prompt || undefined,
  }
  switch (agent) {
    case 'claude-code':
      return {
        lede: 'Three steps, about a minute. Claude Code then designs on this canvas as you.',
        steps: [
          {
            title: 'Add Doop as an MCP server',
            body: (
              <>
                Run this once in any terminal. It registers the <code>doop</code> server for every project.
              </>
            ),
            code: `claude mcp add --transport http doop "${mcpUrl}"`,
          },
          {
            title: 'Sign in from Claude Code',
            body: (
              <>
                Inside Claude Code type <code>/mcp</code>, pick <strong>doop</strong>, then{' '}
                <strong>Authenticate</strong>. A browser tab opens so you can approve the connection.
              </>
            ),
          },
          pointAt,
        ],
      }
    case 'claude':
      if (claudeConnection === 'desktop') {
        return {
          lede: 'Add Doop from the desktop app, confirm in Claude, and start designing together.',
          steps: [
            {
              title: 'Add Doop to Claude Desktop',
              body: 'Click Add to Claude in the Doop desktop app, then confirm the installation in Claude. Your Doop server address is filled in for you.',
              action: <ClaudeDesktopInstall mcpUrl={mcpUrl} />,
            },
            {
              title: 'Connect your Doop account',
              body: 'Enable the extension in Claude. Sign in to Doop in the browser that opens and approve the connection.',
            },
            {
              ...pointAt,
              body: prompt
                ? 'Start a new Claude chat, enable Doop in the tools menu, and send this as your first message.'
                : 'Start a new Claude chat, enable Doop in the tools menu, and tell it which canvas to work on.',
            },
          ],
        }
      }
      if (!claudeConnectorInstallUrl(mcpUrl)) {
        return {
          lede: 'Claude’s online connector needs a publicly reachable HTTPS server.',
          steps: [
            {
              title: 'Use the desktop connection for this server',
              body: 'This Doop address is local or uses HTTP. Choose Desktop app above to connect from your computer, or open Doop at its public HTTPS address.',
            },
          ],
        }
      }
      return {
        lede: 'Add Doop to your Claude account, approve the connection, and start designing. No download needed.',
        steps: [
          {
            title: 'Add Doop to Claude',
            body: 'Open Claude with Doop’s name and server address already filled in. Review the details and add the connector.',
            action: (
              <Button asChild variant="solid" className="mt-2.5">
                <a
                  href={claudeConnectorInstallUrl(mcpUrl)!}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => posthog.capture('claude_connector_opened')}
                >
                  Add to Claude
                </a>
              </Button>
            ),
          },
          {
            title: 'Approve the sign-in',
            body: 'Click Connect on the new connector. A browser tab opens so you can approve the connection.',
          },
          {
            ...pointAt,
            body: prompt
              ? 'In a new chat enable Doop under the tools menu and send this as your first message.'
              : 'In a new chat enable Doop under the tools menu and tell it which canvas to work on.',
          },
        ],
      }
    case 'chatgpt':
      if (!canUseChatGPTPublicEndpoint(mcpUrl)) {
        return {
          lede: 'ChatGPT needs a public HTTPS address or a secure tunnel to reach this Doop server.',
          steps: [
            {
              title: 'Make your Doop server reachable',
              body: 'ChatGPT cannot reach this address directly. Open your public HTTPS Doop address and start this connection there, or configure an OpenAI Secure MCP Tunnel for this server.',
              code: mcpUrl,
              action: (
                <Button asChild variant="solid" className="mt-2.5">
                  <a href={CHATGPT_CONNECTION_GUIDE} target="_blank" rel="noopener noreferrer">
                    View ChatGPT setup guide
                  </a>
                </Button>
              ),
            },
          ],
        }
      }
      return {
        lede: 'No download. Open ChatGPT, paste the server address below, and approve the Doop connection.',
        steps: [
          {
            title: 'Open ChatGPT plugins',
            body: (
              <>
                Click the <strong>+</strong> button on the Plugins page, then <strong>Add custom MCP server</strong>.
                Your account or workspace must allow custom servers.
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
                  Open ChatGPT setup
                </a>
              </Button>
            ),
          },
          {
            title: 'Add Doop and sign in',
            body: (
              <>
                Name it <strong>Doop</strong>, describe it as a design canvas, and paste this as the MCP server URL.
                Choose <strong>OAuth</strong>, review the permissions, then select <strong>Create as a plugin</strong>.
                Sign in to Doop when prompted and install the resulting plugin.
              </>
            ),
            code: mcpUrl,
          },
          {
            ...pointAt,
            body: prompt
              ? 'Start a new chat, type @ and select Doop, then send this as your first message.'
              : 'Start a new chat, type @ and select Doop, then tell it which canvas to work on.',
          },
        ],
      }
    case 'codex':
      return {
        lede: 'Add Doop from the desktop app, sign in, and start designing with Codex.',
        steps: [
          {
            title: 'Add Doop to Codex',
            body: 'Doop Desktop configures Codex for you. This works with Codex CLI and the Codex tab in the ChatGPT desktop app.',
            action: <CodexInstall mcpUrl={mcpUrl} canvasId={canvasId} />,
          },
          {
            title: 'Sign in from Codex',
            body: 'Open a new Codex chat. If Doop needs authentication, sign in from its MCP settings. For Codex CLI, run the command below and approve the connection in your browser.',
            code: 'codex mcp login doop',
          },
          pointAt,
        ],
      }
    case 'cursor':
      return {
        lede: 'Add Doop to Cursor, sign in, and start designing together.',
        steps: [
          {
            title: 'Add Doop to Cursor',
            body: 'Open Cursor and review the server connection. No file download needed.',
            action: <CursorInstall mcpUrl={mcpUrl} />,
          },
          {
            title: 'Approve the sign-in',
            body: 'Enable the doop server in Cursor and complete its browser sign-in. Your agent can then work on the canvases you can access.',
          },
          {
            ...pointAt,
            body: prompt
              ? 'Open the Agent chat and send this as your first message.'
              : 'Open the Agent chat and tell it which canvas to work on.',
          },
        ],
      }
    case 'mcp':
      return {
        lede: 'Doop is a streamable-HTTP MCP server with OAuth. Any client that supports that can design here.',
        steps: [
          {
            title: "Add this server to your client's MCP config",
            body: (
              <>
                Windsurf, Zed, Cline and VS Code all read a JSON file like this. Paste the <code>doop</code> entry into
                it.
              </>
            ),
            code: jsonConfig,
          },
          {
            title: 'Approve the sign-in',
            body: 'The first time your client connects, a browser tab opens to authorize it. The agent then works as you, and its edits are attributed to you.',
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
  const option = agentById(agent)
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
  const { lede, steps } = agentSteps(agent, mcpUrl, prompt, claudeConnection, canvasId)
  return (
    <>
      <div className={body}>
        <div className="flex items-center gap-3.5">
          <span className="grid size-11 shrink-0 place-items-center rounded-[11px] border border-line-soft bg-paper">
            {option.icon}
          </span>
          <div>
            <ModalTitle>Connect {option.name}</ModalTitle>
            <ModalLede className="mt-1">{lede}</ModalLede>
          </div>
        </div>

        {agent === 'claude' && (
          <div className="mt-5 flex gap-2" role="group" aria-label="Claude connection method">
            {(['web', 'desktop'] as const).map((connection) => (
              <Button
                key={connection}
                size="sm"
                variant={claudeConnection === connection ? 'solid' : 'ghost'}
                aria-pressed={claudeConnection === connection}
                onClick={() => setClaudeConnection(connection)}
              >
                {connection === 'desktop' ? 'Desktop app' : 'Connect online'}
              </Button>
            ))}
          </div>
        )}

        <ol className="mt-6">
          {steps.map((step, i) => (
            <li
              key={step.title}
              className={cn('grid grid-cols-[28px_1fr] gap-3.5', i > 0 && 'mt-3.5 border-t border-line-soft pt-3.5')}
            >
              <span className="mt-px grid size-[26px] place-items-center rounded-full bg-ink text-xs font-bold text-white">
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
          <Disclosure label="Connection help" className="mt-4 text-label leading-relaxed text-ink-soft">
            <p>
              If Claude asks you to sign in first, return here and click Add to Claude again. You can also use{' '}
              <strong>Customize → Connectors → Add custom connector</strong> in Claude with this address:
            </p>
            <CodeBlock text={mcpUrl} className="mt-2" />
          </Disclosure>
        )}

        {agent === 'mcp' && (
          <p className="mt-4 text-xs leading-[1.5] text-ink-faint">
            No browser to sign in with (n8n, Mastra, CI)? Mint an agent key in{' '}
            <button
              type="button"
              className="font-medium text-accent-ink underline underline-offset-2"
              onClick={() =>
                navigate(`/settings?pane=keys${canvasId ? `&from=${encodeURIComponent(`/c/${canvasId}`)}` : ''}`)
              }
            >
              Settings → Agent keys
            </button>{' '}
            and send it as <code>Authorization: Bearer dpk_…</code>. The key acts as you, on the canvases you can reach.
          </p>
        )}
      </div>

      <ModalActions className={footer}>
        {canvasId && showAgentStatus ? <AgentArrival name={option.name} /> : <ModalSpacer />}
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-sm px-2 py-2 text-xs font-medium text-ink-soft hover:text-ink"
          onClick={onBack}
        >
          <ChevronLeftIcon width={14} height={14} />
          Back
        </button>
        <Button onClick={onClose}>Done</Button>
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

function ChoiceCard({
  selected,
  onClick,
  icon,
  title,
  blurb,
}: {
  selected: boolean
  onClick: () => void
  icon: ReactNode
  title: string
  blurb: string
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'relative flex items-center gap-3 rounded-card border bg-surface py-3.5 pl-3.5 pr-9 text-left text-ink transition-colors',
        selected ? 'border-brand' : 'border-line hover:border-ink-faint',
      )}
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-[9px] border border-line-soft bg-paper">
        {icon}
      </span>
      <span className="block">
        <span className="block text-copy font-semibold">{title}</span>
        <span className="mt-0.5 block text-xs leading-[1.5] text-ink-soft">{blurb}</span>
      </span>
      <span
        aria-hidden
        className={cn(
          'absolute right-4 top-1/2 size-4 -translate-y-1/2 rounded-full border',
          selected ? 'border-[5px] border-brand' : 'border-line',
        )}
      />
    </button>
  )
}

/** Live connection status: flips the moment an outside (non-resident) agent
 *  joins this canvas's presence, so nobody is left wondering whether the
 *  OAuth dance actually worked. */
export function AgentArrival({ name }: { name?: string }) {
  const presences = useStore((s) => s.presences)
  const arrived = useMemo(
    () => Object.values(presences).find((p) => p.kind === 'agent' && !roleByAgentName(p.name)),
    [presences],
  )
  return arrived ? (
    <span className="mr-auto inline-flex items-center gap-[7px] text-body text-success-ink">
      ✓ {arrived.name} is here — it worked
    </span>
  ) : (
    <span className="mr-auto inline-flex items-center gap-[7px] text-body text-ink-faint">
      <Dot className="animate-[arrival-pulse_1.6s_ease-in-out_infinite] bg-brand" /> listening for{' '}
      {name ?? 'your agent'}…
    </span>
  )
}
