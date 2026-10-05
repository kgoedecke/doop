import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { AGENT_ROLES, mentionsFor, roleByAgentName, roleById, roleName, type AgentRole } from '../../shared/agents'
import type { AgentTask, ChatMessage } from '../../shared/types'
import { useStore } from '../lib/store'
import { api } from '../lib/api'
import { timeAgo } from '../lib/time'
import { taskFrameId } from '../lib/taskFrame'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'
import { Dot } from './ui/dot'
import { RoleMark } from './RoleMark'
import { isResidentLimit } from './TeamAllowance'

/* Every spelling that addresses a resident agent, longest first so
   "@accessibility" is not cut to "@a11y"-length matches */
const MENTION_SPELLINGS = AGENT_ROLES.flatMap(mentionsFor).sort((a, b) => b.length - a.length)
const MENTION_RE = new RegExp(`@(${MENTION_SPELLINGS.join('|')})\\b`, 'gi')

/** Messages closer together than this from the same sender share one header. */
const GROUP_WINDOW_MS = 3 * 60_000

/** The canvas chat: humans talk to each other and to the resident agents.
 *  A message that @mentions an agent queues a card for it — the card's
 *  progress is shown under the message, and the agent answers in the thread
 *  when it is done. */
export function ChatPanel({ active }: { active: boolean }) {
  const chat = useStore((s) => s.chat)
  const markChatSeen = useStore((s) => s.markChatSeen)
  const messages = useMemo(() => [...chat].reverse(), [chat])
  const listRef = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  /* the chat is on screen: whatever arrived is read */
  useEffect(() => {
    if (active) markChatSeen()
  }, [active, chat, markChatSeen])

  /* keep the newest message in view unless the reader scrolled up on purpose */
  useLayoutEffect(() => {
    const el = listRef.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [messages, active])

  return (
    <>
      <div
        ref={listRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-2"
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        {messages.length === 0 ? (
          <div className="px-4 py-6 text-center text-[13px] text-ink-faint">
            Nothing said yet. Talk to everyone on this canvas here — @mention an agent to hand it a task.
          </div>
        ) : (
          messages.map((m, i) => {
            const prev = messages[i - 1]
            const grouped = !!prev && sameSender(prev, m) && m.at - prev.at < GROUP_WINDOW_MS
            return <MessageRow key={m.id} message={m} grouped={grouped} />
          })
        )}
      </div>
      <Composer
        onSent={() => {
          pinned.current = true
        }}
      />
    </>
  )
}

/** Same person AND same name: two accounts sharing a display name must not
 *  merge, and a rename must start a fresh header rather than tuck the new
 *  name's messages under the old one. */
function sameSender(a: ChatMessage, b: ChatMessage): boolean {
  if (a.fromKind !== b.fromKind || a.from !== b.from) return false
  return !a.fromUserId || !b.fromUserId || a.fromUserId === b.fromUserId
}

function MessageRow({ message, grouped }: { message: ChatMessage; grouped: boolean }) {
  const role = message.fromKind === 'agent' ? roleByAgentName(message.from) : undefined
  return (
    <div className={cn('flex animate-[chip-in_0.25s_ease] gap-2.5 px-4', grouped ? 'py-[3px]' : 'pt-[9px] pb-[3px]')}>
      <div className="w-[14px] flex-none">
        {!grouped &&
          (message.fromKind === 'agent' ? (
            <RoleMark role={role} size={14} className="mt-[3px]" />
          ) : (
            <Dot className="mt-[6px] ml-[3px]" style={{ background: message.color }} />
          ))}
      </div>
      <div className="min-w-0 flex-1 text-[12.5px] leading-[1.45]">
        {!grouped && (
          <div className="flex items-baseline gap-1.5">
            <span className="font-bold">{message.from}</span>
            {message.fromKind === 'agent' && (
              <span className="font-mono text-[9.5px] font-medium uppercase tracking-[0.08em] text-ink-faint">
                agent
              </span>
            )}
            <span className="font-mono text-[10px] text-ink-faint">{timeAgo(message.at)}</span>
          </div>
        )}
        <div className={cn('whitespace-pre-wrap break-words', message.fromKind === 'agent' && 'text-ink-soft')}>
          <Mentions text={message.text} />
        </div>
        {message.taskId && message.fromKind === 'user' && <CardState taskId={message.taskId} />}
      </div>
    </div>
  )
}

/** Message text with every @agent mention set in the agent's colour. */
function Mentions({ text }: { text: string }) {
  const parts: ReactNode[] = []
  let last = 0
  for (const match of text.matchAll(MENTION_RE)) {
    const at = match.index ?? 0
    if (at > last) parts.push(text.slice(last, at))
    const spelling = (match[1] ?? '').toLowerCase()
    const role = AGENT_ROLES.find((r) => mentionsFor(r).includes(spelling))
    parts.push(
      <span key={at} className="rounded-[4px] bg-paper-deep px-[3px] font-semibold" style={{ color: role?.color }}>
        {match[0]}
      </span>,
    )
    last = at + match[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return <>{parts}</>
}

/** Where the card a message queued stands, under the message. */
function CardState({ taskId }: { taskId: string }) {
  const canvasId = useStore((s) => s.canvas?.id)
  const task = useStore((s) => s.tasks.find((t) => t.id === taskId))
  const frameId = useStore((s) => (task ? taskFrameId(task, s) : undefined))
  const frameName = useStore((s) => s.canvas?.frames.find((f) => f.id === frameId)?.name)
  if (!task) return null

  const label = cardLabel(task)
  const goToFrame = () => {
    if (frameId) useStore.getState().requestFlyTo(frameId)
  }

  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
      <button
        type="button"
        disabled={!frameId}
        title={frameName ? `Go to “${frameName}”` : undefined}
        onClick={goToFrame}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full border px-2 py-[2px] font-mono text-[9.5px] tracking-[0.06em]',
          task.failedAt
            ? 'border-accent-ink/40 text-accent-ink'
            : task.endedAt
              ? 'border-line text-ink-faint'
              : 'border-brand/40 text-brand',
          frameId && 'cursor-pointer hover:bg-paper-deep',
        )}
      >
        {!task.endedAt && !task.failedAt && (
          <Dot
            size="sm"
            className={cn(task.agentName && 'animate-[status-pulse_1.6s_ease-in-out_infinite]')}
            style={{ background: task.agentName ? task.color : 'var(--ink-faint)' }}
          />
        )}
        {label}
      </button>
      {task.failedAt && canvasId && (
        <Button variant="danger-solid" size="pill" onClick={() => api.retryCard(canvasId, task.id).catch(reportLimit)}>
          ↻ Retry
        </Button>
      )}
      {task.failedAt && task.failureReason && (
        <span className="basis-full text-[11px] leading-[1.4] text-accent-ink">{task.failureReason}</span>
      )}
    </div>
  )
}

function cardLabel(task: AgentTask): string {
  const pipeline = task.pipeline?.length ? task.pipeline : ['doop']
  const stageName = roleName(pipeline[task.stage ?? 0])
  if (task.failedAt) return `${task.agentName || stageName} stopped`
  if (task.endedAt) return `✓ ${pipeline.map(roleName).join(' → ')}`
  if (task.agentName) return `${task.agentName} is on it`
  return `waiting for ${stageName}`
}

function reportLimit(err: unknown) {
  if (isResidentLimit(err)) useStore.getState().setLimitWall(true)
  else console.error(err)
}

/* ---- composer ---- */

/** The "@par" the caret is typing, if any: what to complete and where. */
function mentionAtCaret(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const m = /(^|\s)@([a-z0-9]*)$/i.exec(before)
  if (!m) return null
  return { start: caret - (m[2]?.length ?? 0) - 1, query: (m[2] ?? '').toLowerCase() }
}

function matchingRoles(query: string): AgentRole[] {
  return AGENT_ROLES.filter((r) => mentionsFor(r).some((s) => s.startsWith(query)))
}

function Composer({ onSent }: { onSent: () => void }) {
  const canvasId = useStore((s) => s.canvas?.id)
  const [text, setText] = useState('')
  const [caret, setCaret] = useState(0)
  const [pick, setPick] = useState(0)
  /* Escape hides the list until the text changes again */
  const [dismissed, setDismissed] = useState(false)
  const [sending, setSending] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)

  const hit = mentionAtCaret(text, caret)
  const suggestions = hit && !dismissed ? matchingRoles(hit.query) : []
  const mentioned = useMemo(() => {
    const ids = new Set<string>()
    for (const match of text.matchAll(MENTION_RE)) {
      const spelling = (match[1] ?? '').toLowerCase()
      const role = AGENT_ROLES.find((r) => mentionsFor(r).includes(spelling))
      if (role) ids.add(role.id)
    }
    return [...ids].map(roleById).filter((r): r is AgentRole => !!r)
  }, [text])

  function insertMention(role: AgentRole) {
    const ta = taRef.current
    const next = hit
      ? text.slice(0, hit.start) + `@${role.id} ` + text.slice(caret)
      : (text ? text.replace(/\s*$/, ' ') : '') + `@${role.id} `
    const pos = hit ? hit.start + role.id.length + 2 : next.length
    setText(next)
    setCaret(pos)
    setPick(0)
    requestAnimationFrame(() => {
      ta?.focus()
      ta?.setSelectionRange(pos, pos)
    })
  }

  async function send() {
    const clean = text.trim()
    if (!clean || !canvasId || sending) return
    setSending(true)
    setText('')
    setCaret(0)
    try {
      await api.sendChat(canvasId, clean)
      onSent()
    } catch (err) {
      setText(clean) // keep what was typed when the send failed
      reportLimit(err)
    } finally {
      setSending(false)
      taRef.current?.focus()
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (suggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        return setPick((p) => (p + 1) % suggestions.length)
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        return setPick((p) => (p - 1 + suggestions.length) % suggestions.length)
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        return insertMention(suggestions[pick] ?? suggestions[0]!)
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        return setDismissed(true)
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  const trackCaret = () => setCaret(taRef.current?.selectionStart ?? 0)

  return (
    <div className="relative shrink-0 border-t border-line-soft p-3">
      {suggestions.length > 0 && (
        <ul
          role="listbox"
          aria-label="Agents"
          className="absolute bottom-full left-3 z-[3] mb-1 w-[240px] rounded-[10px] border border-line bg-surface p-1 shadow-pop"
        >
          {suggestions.map((role, i) => (
            <li key={role.id} role="option" aria-selected={i === pick}>
              <button
                type="button"
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px]',
                  i === pick ? 'bg-paper-deep' : 'hover:bg-paper-deep',
                )}
                onMouseDown={(e) => e.preventDefault()} // keep the textarea focused
                onMouseEnter={() => setPick(i)}
                onClick={() => insertMention(role)}
              >
                <RoleMark role={role} size={14} />
                <span className="font-semibold">@{role.id}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-ink-faint">
                  {role.name} · {role.blurb}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="rounded-[10px] border border-line bg-surface p-2 transition-[border-color] focus-within:border-ink-soft">
        <Textarea
          ref={taRef}
          variant="bare"
          rows={2}
          className="max-h-[160px] min-h-[40px] md:text-[13px]"
          placeholder="Message the room — @mention an agent to assign it…"
          value={text}
          disabled={!canvasId}
          onChange={(e) => {
            setText(e.target.value)
            setCaret(e.target.selectionStart)
            setPick(0)
            setDismissed(false)
          }}
          onKeyDown={onKeyDown}
          onKeyUp={trackCaret}
          onClick={trackCaret}
          onSelect={trackCaret}
        />
        <div className="mt-1 flex items-center gap-1.5">
          {mentioned.length > 0 ? (
            <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-[11px] font-semibold text-brand">
              {mentioned.map((r) => (
                <RoleMark key={r.id} role={r} size={13} />
              ))}
              <span>{mentioned.map((r) => r.name).join(' → ')} will pick this up</span>
            </span>
          ) : (
            <div className="flex min-w-0 flex-1 flex-wrap gap-1">
              {AGENT_ROLES.map((role) => (
                <Button
                  key={role.id}
                  variant="ghost"
                  size="pill"
                  className="border-dashed px-1.5 py-0 text-[10.5px] font-semibold text-ink-soft hover:border-brand hover:bg-transparent hover:text-brand"
                  title={`${role.name} — ${role.blurb}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => insertMention(role)}
                >
                  <RoleMark role={role} size={11} /> @{role.id}
                </Button>
              ))}
            </div>
          )}
          <Button
            variant="solid"
            size="pill"
            className="px-3 py-[4px] text-xs"
            disabled={!text.trim() || sending || !canvasId}
            onClick={() => void send()}
          >
            Send
          </Button>
        </div>
      </div>
    </div>
  )
}
