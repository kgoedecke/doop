import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { navigate } from '../App'
import { useStore } from '../lib/store'
import { roleByAgentName } from '../../shared/agents'
import { posthog } from '../lib/posthog'
import { AgentIcon } from './AgentIcon'
import { Button } from './ui/button'
import { CodeBlock } from './ui/code-block'
import { Dot } from './ui/dot'
import { ChevronLeftIcon, PuzzleIcon } from './ui/icons'
import { Modal, ModalActions, ModalEyebrow, ModalLede, ModalSpacer, ModalTitle } from './ui/modal'
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
  { id: 'claude', name: 'Claude', blurb: 'Connect from the Claude app', icon: <AgentIcon name="claude" size={20} /> },
  { id: 'chatgpt', name: 'ChatGPT', blurb: 'Add an MCP connection', icon: <AgentIcon name="gpt" size={20} /> },
  { id: 'codex', name: 'Codex', blurb: 'Connect your coding agent', icon: <AgentIcon name="codex" size={20} /> },
  {
    id: 'cursor',
    name: 'Cursor',
    blurb: 'Add to your MCP settings',
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
export function ConnectModal({ canvasId, onClose }: { canvasId?: string; onClose: () => void }) {
  const [view, setView] = useState<View>('agents')
  return (
    <Modal size="lg" className="flex flex-col overflow-hidden p-0 sm:p-0" onClose={onClose}>
      {view === 'agents' ? (
        <AgentPicker onPick={setView} />
      ) : (
        <AgentSteps agent={view} canvasId={canvasId} onBack={() => setView('agents')} onClose={onClose} />
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
        <ModalEyebrow>Connect AI</ModalEyebrow>
        <ModalTitle className="mt-2">Choose your agent</ModalTitle>
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
          variant="solid"
          onClick={() => {
            posthog.capture('connect_ai_agent_chosen', { agent })
            onPick(agent)
          }}
        >
          Connect →
        </Button>
      </ModalActions>
    </>
  )
}

interface Step {
  title: string
  body: ReactNode
  code?: string
}

function agentSteps(agent: AgentId, mcpUrl: string, prompt: string): { lede: string; steps: Step[] } {
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
      return {
        lede: 'No terminal. You add Doop as a connector in the Claude app, then approve it in your browser.',
        steps: [
          {
            title: 'Add Doop as a connector',
            body: (
              <>
                In Claude (desktop or web) open <strong>Settings → Connectors → Add custom connector</strong>. Name it{' '}
                <strong>Doop</strong> and paste this as the URL.
              </>
            ),
            code: mcpUrl,
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
      return {
        lede: 'No terminal. You add Doop as a connector inside ChatGPT, then approve it in your browser.',
        steps: [
          {
            title: 'Turn on Developer mode',
            body: (
              <>
                In ChatGPT open <strong>Settings → Connectors → Advanced</strong> and switch on{' '}
                <strong>Developer mode</strong>. Available on Plus, Pro, Business and Enterprise plans.
              </>
            ),
          },
          {
            title: 'Create the Doop connector',
            body: (
              <>
                Back in <strong>Connectors</strong> click <strong>Create</strong>, name it <strong>Doop</strong>, choose{' '}
                <strong>OAuth</strong> and paste this as the MCP server URL. Save, then approve the connection in the
                browser tab that opens.
              </>
            ),
            code: mcpUrl,
          },
          {
            ...pointAt,
            body: prompt
              ? 'In a new chat open the + menu, tick Doop, and send this as your first message.'
              : 'In a new chat open the + menu, tick Doop, and tell it which canvas to work on.',
          },
        ],
      }
    case 'codex':
      return {
        lede: 'Three steps, about a minute. Codex then designs on this canvas as you.',
        steps: [
          {
            title: 'Add Doop as an MCP server',
            body: (
              <>
                Run this once in any terminal. It registers the <code>doop</code> server for Codex.
              </>
            ),
            code: `codex mcp add doop --url ${mcpUrl}`,
          },
          {
            title: 'Sign in from Codex',
            body: 'Start Codex. The first time it reaches Doop a browser tab opens so you can approve the connection.',
          },
          pointAt,
        ],
      }
    case 'cursor':
      return {
        lede: 'Cursor reads MCP servers from its settings. Paste one entry and approve the sign-in.',
        steps: [
          {
            title: 'Add Doop to your MCP settings',
            body: (
              <>
                Open <strong>Cursor Settings → MCP → Add new global MCP server</strong> and paste this into{' '}
                <code>mcp.json</code>.
              </>
            ),
            code: jsonConfig,
          },
          {
            title: 'Approve the sign-in',
            body: 'Switch the doop server on. A browser tab opens so you can approve the connection.',
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
  onBack,
  onClose,
}: {
  agent: AgentId
  canvasId?: string
  onBack: () => void
  onClose: () => void
}) {
  const option = agentById(agent)
  const mcpUrl = `${location.origin}/mcp`
  /* Deliberately thin: the MCP server ships its own INSTRUCTIONS on connect and the
     rest lives behind get_guide. The only thing this prompt knows that they don't is
     which canvas the human is looking at. */
  const prompt = canvasId
    ? `Work on Doop canvas ${canvasId}. Start with get_guide({ topic: "doop-instructions" }) and follow it.`
    : ''
  const { lede, steps } = agentSteps(agent, mcpUrl, prompt)
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
                <h4 className="text-[13.5px] font-semibold text-ink">{step.title}</h4>
                <p className="mt-0.5 text-[12.5px] leading-[1.5] text-ink-soft [&_code]:rounded-[4px] [&_code]:bg-paper-deep [&_code]:px-1 [&_code]:font-mono [&_code]:text-[11.5px] [&_code]:text-ink">
                  {step.body}
                </p>
                {step.code && <CodeBlock text={step.code} className="mt-2.5" />}
              </div>
            </li>
          ))}
        </ol>

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
        {canvasId ? <AgentArrival name={option.name} /> : <ModalSpacer />}
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
const body = 'min-h-0 flex-1 overflow-y-auto p-5 sm:p-7'
const footer = 'mt-0 shrink-0 items-center border-t border-line-soft bg-surface px-5 py-4 sm:px-7'

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
        'relative flex items-center gap-3 rounded-[12px] border bg-surface py-3.5 pl-3.5 pr-9 text-left text-ink transition-colors',
        selected ? 'border-brand ring-3 ring-brand/15' : 'border-line hover:border-ink-faint',
      )}
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-[9px] border border-line-soft bg-paper">
        {icon}
      </span>
      <span className="block">
        <span className="block text-[13.5px] font-semibold">{title}</span>
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
    <span className="mr-auto inline-flex items-center gap-[7px] text-[12.5px] text-success-ink">
      ✓ {arrived.name} is here — it worked
    </span>
  ) : (
    <span className="mr-auto inline-flex items-center gap-[7px] text-[12.5px] text-ink-faint">
      <Dot className="animate-[arrival-pulse_1.6s_ease-in-out_infinite] bg-brand" /> listening for{' '}
      {name ?? 'your agent'}…
    </span>
  )
}
