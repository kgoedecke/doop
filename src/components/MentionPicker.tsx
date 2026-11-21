import { useId, useRef, useState, type ReactNode, type RefObject } from 'react'
import { mentionedRole, type AgentRole, type Roster } from '../../shared/agents'
import {
  AGENT_PICK,
  activeMentionQuery,
  mentionedPeople,
  mentionSegments,
  nameMatches,
  resolvePersonMentions,
} from '../../shared/personMentions'
import type { CanvasPerson } from '../lib/api'
import { useMentionPeople } from '../hooks/use-mention-people'
import { useRoster } from '../hooks/use-roster'
import { useT } from '../lib/i18n'
import { canEditOpenCanvas, useStore } from '../lib/store'
import { cn } from '@/lib/utils'
import { Avatar } from './ui/avatar'
import { Pressable } from './ui/pressable'
import { RoleMark } from './RoleMark'

/* @mentions in a comment field: typing `@` lists the people the canvas is
   shared with and its agents, ↑/↓ move, ↩ or Tab picks, Esc closes the list
   (and only the list). A pick writes `@Name ` into the text, which is all a
   mention is (shared/personMentions.ts), and remembers who was picked for a
   name several people share, or that an agent was picked over a person named
   like its handle. Agents are offered to those who may ask them. */

const MAX_OPTIONS = 6

type MentionOption = { kind: 'person'; person: CanvasPerson } | { kind: 'agent'; role: AgentRole }

const handleOf = (o: MentionOption) => (o.kind === 'person' ? o.person.name : o.role.id)
const keyOf = (o: MentionOption) => (o.kind === 'person' ? `p:${o.person.id}` : `a:${o.role.id}`)

function optionsFor(query: string, people: CanvasPerson[], roster: Roster): MentionOption[] {
  const found: MentionOption[] = [
    ...people.filter((p) => nameMatches(p.name, query)).map((person) => ({ kind: 'person' as const, person })),
    ...roster
      .filter((role) => nameMatches(role.id, query) || nameMatches(role.name, query))
      .map((role) => ({ kind: 'agent' as const, role })),
  ]
  return found.slice(0, MAX_OPTIONS)
}

type Field = HTMLTextAreaElement | HTMLInputElement

export interface MentionPicker {
  /** call from the field's onKeyDown first; true when the key was the list's */
  onKeyDown: (e: React.KeyboardEvent<Field>) => boolean
  /** call from the field's onChange, so the list follows the caret */
  onCaret: (e: React.SyntheticEvent<Field>) => void
  /** spread on the field: caret, focus and the list's accessibility wiring */
  fieldProps: {
    onSelect: (e: React.SyntheticEvent<Field>) => void
    onFocus: () => void
    onBlur: () => void
    'aria-autocomplete': 'list'
    'aria-controls'?: string
    'aria-activedescendant'?: string
  }
  /** the list, to render inside a `relative` box around the field */
  list: ReactNode
  /** the people picked from the list whose mention is still in the text:
   *  sent with it, so a name several people share reaches the one chosen */
  picked: (text: string) => string[]
}

export function useMentionPicker({
  value,
  onChange,
  fieldRef,
}: {
  value: string
  onChange: (text: string) => void
  fieldRef: RefObject<Field | null>
}): MentionPicker {
  const t = useT()
  const id = useId()
  const people = useMentionPeople()
  const roster = useRoster()
  /* asking an agent takes edit access (the server refuses it otherwise) */
  const canAskAgents = useStore(canEditOpenCanvas)
  const [caret, setCaret] = useState<number | null>(null)
  const [focused, setFocused] = useState(false)
  const [highlight, setHighlight] = useState(0)
  /* the `@` whose list was closed (Esc) or answered (a pick), and the query
     it closed on: it stays closed while the query goes on from there */
  const [closed, setClosed] = useState<{ start: number; query: string } | null>(null)
  /* what the list picked in this draft: the latest pick of a name stands for
     it, and an emptied field (a sent comment) starts again */
  const [chosen, setChosen] = useState<MentionOption[]>([])
  if (!value && chosen.length) setChosen([])
  /* where a pick puts the caret: until the field reports it there, its
     select events still carry the caret from before the pick (React fires
     one on the very keydown that picked) and would reopen the list */
  const placing = useRef<number | null>(null)

  const active = caret === null || caret > value.length ? null : activeMentionQuery(value, caret)
  const options = active ? optionsFor(active.query, people, canAskAgents ? roster : []) : []
  const shut =
    !!active &&
    !!closed &&
    closed.start === active.start &&
    active.query.toLowerCase().startsWith(closed.query.toLowerCase())
  const open = focused && !!active && options.length > 0 && !shut
  const index = Math.min(highlight, options.length - 1)
  const optionId = (i: number) => `${id}-option-${i}`

  function pick(option: MentionOption) {
    if (!active || caret === null) return
    const handle = handleOf(option)
    const insert = `@${handle} `
    const next = value.slice(0, active.start) + insert + value.slice(caret)
    const at = active.start + insert.length
    onChange(next)
    setCaret(at)
    setHighlight(0)
    setClosed({ start: active.start, query: `${handle} ` })
    const name = handle.toLowerCase()
    setChosen((list) => [...list.filter((o) => handleOf(o).toLowerCase() !== name), option])
    placing.current = at
    requestAnimationFrame(() => {
      placing.current = null
      const el = fieldRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(at, at)
    })
  }

  function onKeyDown(e: React.KeyboardEvent<Field>): boolean {
    /* keys that finish an IME composition belong to the composition */
    if (!open || e.nativeEvent.isComposing || e.keyCode === 229) return false
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      setHighlight((index + step + options.length) % options.length)
      return true
    }
    if ((e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.shiftKey) || e.key === 'Tab') {
      const option = options[index]
      if (!option) return false
      e.preventDefault()
      pick(option)
      return true
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setClosed({ start: active.start, query: active.query })
      return true
    }
    return false
  }

  function onCaret(e: React.SyntheticEvent<Field>) {
    const el = e.currentTarget
    const at = el.selectionStart === el.selectionEnd ? el.selectionStart : null
    if (placing.current !== null) {
      if (at !== placing.current) return
      placing.current = null
    }
    if (at !== caret) setHighlight(0)
    setCaret(at)
  }

  const list = open ? (
    <div
      id={`${id}-list`}
      role="listbox"
      aria-label={t('stage.mentionList')}
      className="absolute top-full left-0 z-20 mt-1 w-full min-w-[200px] overflow-hidden rounded-control bg-surface p-1 shadow-pop"
      /* a press on the list must not blur the field */
      onMouseDown={(e) => e.preventDefault()}
    >
      {options.map((option, i) => {
        const first = options.findIndex((o) => o.kind === option.kind) === i
        return (
          <div key={keyOf(option)}>
            {first && (
              <div className="px-2 pt-1 pb-0.5 text-caption text-ink-faint">
                {t(option.kind === 'person' ? 'stage.mentionPeople' : 'stage.mentionAgents')}
              </div>
            )}
            <Pressable
              id={optionId(i)}
              role="option"
              aria-selected={i === index}
              tabIndex={-1}
              className={cn(
                'flex w-full items-center gap-2 rounded-row px-2 py-1 text-left text-body text-ink',
                i === index && 'bg-paper-deep',
              )}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => pick(option)}
            >
              {option.kind === 'person' ? (
                <Avatar name={option.person.name} image={option.person.image} size={18} />
              ) : (
                <RoleMark role={option.role} size={16} />
              )}
              <span className="min-w-0 truncate">
                {option.kind === 'person' ? option.person.name : `@${option.role.id}`}
              </span>
              {option.kind === 'agent' && (
                <span className="ml-auto min-w-0 truncate text-caption text-ink-faint">{option.role.name}</span>
              )}
            </Pressable>
          </div>
        )
      })}
    </div>
  ) : null

  return {
    onKeyDown,
    onCaret,
    fieldProps: {
      onSelect: onCaret,
      onFocus: () => setFocused(true),
      onBlur: () => setFocused(false),
      'aria-autocomplete': 'list',
      ...(open ? { 'aria-controls': `${id}-list`, 'aria-activedescendant': optionId(index) } : {}),
    },
    list,
    picked: (text) =>
      chosen
        .filter((o) => mentionedPeople(text, [{ id: keyOf(o), name: handleOf(o) }]).length > 0)
        .map((o) => (o.kind === 'person' ? o.person.id : `${AGENT_PICK}${o.role.id}`)),
  }
}

/** A comment's text with the people and agents it @mentions drawn apart. */
export function MentionText({ text }: { text: string }) {
  const people = useMentionPeople({ ask: false })
  const roster = useRoster()
  const names = [...people, ...roster.map((role) => ({ id: `agent:${role.id}`, name: role.id }))]
  return (
    <>
      {mentionSegments(text, names).map((part, i) =>
        part.person ? (
          <span key={i} className="font-medium text-brand">
            {part.text}
          </span>
        ) : (
          part.text
        ),
      )}
    </>
  )
}

/** The agent a draft @mentions, if any, reading past people's names, so that
 *  `@Brand Smith` is not taken for the brand agent, unless `picked` (the
 *  picker's) chose the agent (the server reads it the same way). None for
 *  someone who may not ask agents. */
export function useAgentMention(text: string, picked: readonly string[] = []): AgentRole | undefined {
  const people = useMentionPeople({ ask: false })
  const roster = useRoster()
  const canAskAgents = useStore(canEditOpenCanvas)
  if (!canAskAgents) return undefined
  return mentionedRole(resolvePersonMentions(text, people, picked).roleText, roster)
}
