import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../lib/store'
import { roleByAgentName } from '../../shared/agents'
import { useIsMobile } from '../hooks/use-mobile'
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from './ui/sheet'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'
import { IconButton } from './ui/icon-button'
import { XIcon } from './ui/icons'
import { ConnectModal } from './ConnectModal'

const obHint = 'text-body text-ink-soft'
/* the copy-this-command affordance inside a step */
const obCopy =
  'self-start rounded-md border-line bg-paper-deep px-[9px] py-1 font-mono text-[11.5px] font-normal text-ink shadow-none hover:translate-x-0 hover:translate-y-0 hover:border-ink-soft hover:bg-paper-deep hover:shadow-none'

/**
 * Getting-started checklist, whose whole point is getting an agent of their
 * own onto the canvas over MCP. No "next" buttons: each step checks itself
 * off from live canvas state (a real agent joining presence, its first task
 * appearing). Progress persists in localStorage so completed steps stay
 * checked across canvases and sessions.
 */

const LS_KEY = 'doop:onboarding'

interface Progress {
  dismissed?: boolean
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

export function Onboarding({ canvasId }: { canvasId: string }) {
  const isMobile = useIsMobile()
  const tasks = useStore((s) => s.tasks)
  const presences = useStore((s) => s.presences)
  const [progress, setProgress] = useState<Progress>(load)
  const [copied, setCopied] = useState(false)
  const [showConnect, setShowConnect] = useState(false)

  /* live detection — flips only ever go false -> true */
  const live = useMemo(() => {
    /* "connected" means an OUTSIDE agent over MCP — the resident team
       (Doop and the specialists) doesn't count towards the setup steps */
    const outside = (name: string) => name !== '' && !roleByAgentName(name)
    const agentHere = Object.values(presences).some((p) => p.kind === 'agent' && outside(p.name))
    const agentWorked = tasks.some((t) => outside(t.agentName))
    return { connected: agentHere || agentWorked, tasked: agentWorked }
  }, [tasks, presences])

  /* a step, once seen live, stays done: fold the live signals into the
     stored progress as they light up */
  const next: Progress = {
    ...progress,
    connected: progress.connected || live.connected,
    tasked: progress.tasked || live.tasked,
  }
  if (next.connected !== progress.connected || next.tasked !== progress.tasked) {
    setProgress(next)
  }

  useEffect(() => save(progress), [progress])

  if (progress.dismissed) return null
  const allDone = progress.connected && progress.tasked

  function dismiss() {
    setProgress({ ...progress, dismissed: true })
  }

  function copy(text: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    }, console.error)
  }

  /* the same one-line prompt the Connect AI modal hands out: the MCP server
     ships its own instructions on connect, so the prompt only needs to name
     the canvas */
  const prompt = `Work on Doop canvas ${canvasId}. Start with get_guide({ topic: "doop-instructions" }) and follow it.`

  const checklist = (
    <>
      <Step done={!!progress.connected} label="Connect your own agent">
        {!progress.connected && (
          <>
            <p className={obHint}>Claude Code, Codex, Cursor or any MCP client can design on this canvas as you.</p>
            <Button variant="primary" size="sm" className="mt-0.75 self-start" onClick={() => setShowConnect(true)}>
              Connect AI
            </Button>
          </>
        )}
      </Step>

      <Step done={!!progress.tasked} label="Give it a task">
        {progress.connected && !progress.tasked && (
          <>
            <Button size="sm" className={obCopy} onClick={() => copy(prompt)}>
              {copied ? '✓ copied' : 'copy a starter prompt'}
            </Button>
            <p className={obHint}>Paste it into your agent's chat and watch the frame stream in.</p>
          </>
        )}
      </Step>

      {allDone && (
        <div className="flex flex-col gap-2.5 border-t border-line-soft pt-2.5">
          <p className="text-body text-ink-soft">
            That's the loop. One more trick: hover a task in the panel and reply with ↩ — your note becomes an open
            request any agent picks up mid-flight.
          </p>
          <Button className="self-start" onClick={dismiss}>
            Got it
          </Button>
        </div>
      )}
    </>
  )

  const connect = showConnect && <ConnectModal canvasId={canvasId} onClose={() => setShowConnect(false)} />

  if (isMobile) {
    const done = [progress.connected, progress.tasked].filter(Boolean).length
    return (
      <>
        {connect}
        <Sheet>
          <SheetTrigger asChild>
            <Button
              variant="ghost"
              className="pointer-events-auto absolute left-3 top-3 z-30 h-10 gap-2 rounded-full bg-surface px-3 text-xs font-semibold shadow-card"
            >
              <span className="text-brand">✦</span> Getting started
              <span className="font-mono text-[10px] text-ink-faint">{done}/2</span>
            </Button>
          </SheetTrigger>
          <SheetContent
            side="bottom"
            className="max-h-[min(78svh,620px)] gap-0 overflow-y-auto rounded-t-2xl border-line bg-surface p-0 shadow-pop"
          >
            <div className="border-b border-line-soft px-5 py-4 pr-14">
              <SheetTitle className="font-display text-lg font-extrabold">Getting started</SheetTitle>
              <SheetDescription className="mt-1 text-xs text-ink-soft">
                Two steps to bring your own agent onto the canvas.
              </SheetDescription>
            </div>
            <div className="flex flex-col gap-4 px-5 py-5">{checklist}</div>
            <Button
              variant="link"
              size="sm"
              className="mx-5 mb-5 self-start px-0 text-xs text-ink-faint"
              onClick={dismiss}
            >
              Dismiss checklist
            </Button>
          </SheetContent>
        </Sheet>
      </>
    )
  }

  return (
    /* bottom left of the canvas, beside the Layers panel in the tool rail's
       column (--rail-left): the rail stops near the top, so the card can hug
       the panel. Clear of the zoom control on the right */
    <div className="pointer-events-auto absolute bottom-3.5 left-[var(--rail-left,14px)] z-40 flex w-[340px] flex-col gap-3 rounded-panel bg-surface px-5 pt-4 pb-5 shadow-pop transition-[left] duration-150 max-md:right-4 max-md:bottom-4 max-md:left-auto">
      <header className="flex items-center justify-between">
        <span className="text-lead font-semibold">Getting started</span>
        <IconButton size="sm" className="-mr-1" aria-label="Dismiss" onClick={dismiss}>
          <XIcon size="rail" />
        </IconButton>
      </header>

      {checklist}
      {connect}
    </div>
  )
}

function Step({ done, label, children }: { done: boolean; label: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2.5">
      <span className={cn('w-3.5 flex-none text-copy', done ? 'text-success-ink' : 'text-ink-faint')}>
        {done ? '✓' : '○'}
      </span>
      {/* the label's line box already leaves room under its text, so it sits
          tighter to its details than they sit to each other */}
      <div className="flex flex-col gap-0.5">
        <span className={cn('text-copy font-medium', done ? 'text-ink-faint line-through decoration-1' : 'text-ink')}>
          {label}
        </span>
        {children && <div className="flex flex-col gap-[5px]">{children}</div>}
      </div>
    </div>
  )
}
