import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../lib/store'
import { roleByAgentName } from '../../shared/agents'

/**
 * Getting-started checklist. No "next" buttons: each step checks itself off
 * from live canvas state (the demo agent's task ending, a real agent joining
 * presence, its first task appearing). Progress persists in localStorage so
 * completed steps stay checked across canvases and sessions.
 */

const LS_KEY = 'doop:onboarding'

interface Progress {
  dismissed?: boolean
  watched?: boolean
  connected?: boolean
  tasked?: boolean
}

function load(): Progress {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) ?? '{}')
  } catch {
    return {}
  }
}

function save(p: Progress) {
  localStorage.setItem(LS_KEY, JSON.stringify(p))
}

export function Onboarding() {
  const tasks = useStore((s) => s.tasks)
  const presences = useStore((s) => s.presences)
  const [progress, setProgress] = useState<Progress>(load)
  const [copied, setCopied] = useState<string | null>(null)

  /* live detection — flips only ever go false -> true */
  const live = useMemo(() => {
    const demoDone = tasks.some((t) => t.agentName === 'Doop' && t.endedAt)
    /* "connected" means an OUTSIDE agent over MCP — the resident team
       (Doop and the specialists) doesn't count towards the setup steps */
    const realAgent = (t: { agentName: string }) => t.agentName !== '' && !roleByAgentName(t.agentName)
    const agentHere = Object.values(presences).some((p) => p.kind === 'agent' && !roleByAgentName(p.name))
    const agentWorked = tasks.some(realAgent)
    return { watched: demoDone, connected: agentHere || agentWorked, tasked: agentWorked }
  }, [tasks, presences])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setProgress((prev) => {
        const next: Progress = {
          ...prev,
          watched: prev.watched || live.watched,
          connected: prev.connected || live.connected,
          tasked: prev.tasked || live.tasked,
        }
        if (next.watched !== prev.watched || next.connected !== prev.connected || next.tasked !== prev.tasked) {
          save(next)
          return next
        }
        return prev
      })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [live.watched, live.connected, live.tasked])

  if (progress.dismissed) return null
  const allDone = progress.watched && progress.connected && progress.tasked

  function dismiss() {
    const next = { ...progress, dismissed: true }
    save(next)
    setProgress(next)
  }

  function copy(text: string, which: string) {
    navigator.clipboard.writeText(text)
    setCopied(which)
    window.setTimeout(() => setCopied(null), 1500)
  }

  const mcpCmd = `claude mcp add --transport http doop "${location.origin}/mcp"`
  const prompt = `You are connected to Doop, a shared multiplayer design canvas, via the "doop" MCP server. Work on canvas ${location.pathname.split('/')[2] ?? ''}. Start with get_guide({ topic: "doop-instructions" }), then design something beautiful on a new frame. Stream it with append_frame_html and review your work with get_frame_screenshot.`

  return (
    <div className="onboarding">
      <header>
        <span className="ob-title">Getting started</span>
        <button className="ob-close" onClick={dismiss} title="Dismiss">
          ✕
        </button>
      </header>

      <Step done={!!progress.watched} label="Watch an agent design">
        {!progress.watched && (
          <p className="ob-hint">The Doop agent is drawing your welcome frame — watch the canvas.</p>
        )}
      </Step>

      <Step done={!!progress.connected} label="Connect your own agent">
        {!progress.connected && (
          <>
            <button className="ob-copy" onClick={() => copy(mcpCmd, 'cmd')}>
              {copied === 'cmd' ? '✓ copied' : 'copy the Claude Code command'}
            </button>
            <p className="ob-hint">
              Run it in a terminal, then inside Claude Code type <code>/mcp</code>, pick <strong>doop</strong> and
              authenticate (a browser window opens). This step checks itself off when your agent first reads the canvas.
            </p>
          </>
        )}
      </Step>

      <Step done={!!progress.tasked} label="Give it a task">
        {progress.connected && !progress.tasked && (
          <>
            <button className="ob-copy" onClick={() => copy(prompt, 'prompt')}>
              {copied === 'prompt' ? '✓ copied' : 'copy a starter prompt'}
            </button>
            <p className="ob-hint">Paste it into your agent chat, then watch this canvas.</p>
          </>
        )}
      </Step>

      {allDone && (
        <div className="ob-done">
          <p>
            That's the loop. One more trick: hover a task in the panel and reply with ↩ — your note becomes an open
            request any agent picks up mid-flight.
          </p>
          <button className="btn" onClick={dismiss}>
            Got it
          </button>
        </div>
      )}
    </div>
  )
}

function Step({ done, label, children }: { done: boolean; label: string; children?: React.ReactNode }) {
  return (
    <div className={`ob-step ${done ? 'done' : ''}`}>
      <span className="ob-mark">{done ? '✓' : '○'}</span>
      <div className="ob-body">
        <span className="ob-label">{label}</span>
        {children}
      </div>
    </div>
  )
}
