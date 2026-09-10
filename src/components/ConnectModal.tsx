import { useMemo } from 'react'
import { useStore } from '../lib/store'
import { roleByAgentName } from '../../shared/agents'
import { Button } from './ui/button'
import { CodeBlock } from './ui/code-block'
import { Dot } from './ui/dot'
import { Modal, ModalActions, ModalLede, ModalTitle } from './ui/modal'

/* This modal is about MCP agents only. Running the built-in Doop Agent on your
   own ChatGPT subscription is an account-level setting and lives in /settings. */

/* The step captions between code blocks. */
const stepHeading = 'mt-6 text-[11px] font-bold uppercase tracking-[0.14em] text-ink-faint'

/** `canvasId` is optional: opened from the home dashboard there is no canvas to
 *  suggest a prompt for, and no presence connection to watch for an arrival. */
export function ConnectModal({ canvasId, onClose }: { canvasId?: string; onClose: () => void }) {
  return (
    <Modal size="lg" onClose={onClose}>
      <>
        <ModalTitle>Connect an AI agent</ModalTitle>
        <ModalLede>
          Any MCP-capable AI can design on this canvas. The endpoint is OAuth-protected: after adding it, trigger the
          sign-in from your client — in Claude Code type <code>/mcp</code>, pick <strong>doop</strong> and authenticate;
          a browser window opens to approve the connection. The agent then works <em>as yours</em>, and its tasks are
          attributed to you.
        </ModalLede>

        <ConnectBody canvasId={canvasId} />

        <ModalActions className="items-center">
          {canvasId && <AgentArrival />}
          <Button onClick={onClose}>Done</Button>
        </ModalActions>
      </>
    </Modal>
  )
}

/** The connect instructions, shared by the connect modal and the free-tier
 *  wall: endpoint, per-client commands, and a starter prompt. */
export function ConnectBody({ canvasId }: { canvasId?: string }) {
  const mcpUrl = `${location.origin}/mcp`

  const claudeCmd = `claude mcp add --transport http doop "${mcpUrl}"`
  const codexCmd = `codex mcp add doop --url ${mcpUrl}`
  const jsonConfig = JSON.stringify({ mcpServers: { doop: { type: 'http', url: mcpUrl } } }, null, 2)
  /* Deliberately thin: the MCP server ships its own INSTRUCTIONS on connect and the
     rest lives behind get_guide. The only thing this prompt knows that they don't is
     which canvas the human is looking at. */
  const prompt = canvasId
    ? `Work on Doop canvas ${canvasId}. Start with get_guide({ topic: "doop-instructions" }) and follow it.`
    : ''

  return (
    <>
      <h3 className={stepHeading}>Claude Code</h3>
      <CodeBlock text={claudeCmd} />

      <h3 className={stepHeading}>Codex</h3>
      <CodeBlock text={codexCmd} />

      <h3 className={stepHeading}>Any other MCP client (streamable HTTP)</h3>
      <CodeBlock text={jsonConfig} />

      {prompt && (
        <>
          <h3 className={stepHeading}>Suggested prompt for the agent</h3>
          <CodeBlock text={prompt} />
        </>
      )}
    </>
  )
}

/** Live connection status: flips the moment an outside (non-resident) agent
 *  joins this canvas's presence, so nobody is left wondering whether the
 *  OAuth dance actually worked. */
export function AgentArrival() {
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
      <Dot className="animate-[arrival-pulse_1.6s_ease-in-out_infinite] bg-brand" /> listening for your agent…
    </span>
  )
}
