import {
  useEffect,
  useId,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type RefObject,
  type SyntheticEvent,
} from 'react'
import { api } from '../lib/api'
import { navigate } from '../lib/navigate'
import { menuItemVariants } from './ui/menu'
import { PlusIcon } from './ui/icons'
import { partialHandleAt, type CanvasSkills, type OfferedSkill } from '../../shared/skills'
import type { AgentScope } from '../../shared/customAgents'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/** Where a menu's skills come from: an open canvas's, or, on Home before the
 *  canvas exists, the scope it will be made in. */
export type SkillSource = { canvasId: string } | { scope: AgentScope }

function fetchSkills(from: SkillSource): Promise<CanvasSkills> {
  if ('canvasId' in from) return api.canvasSkills(from.canvasId)
  const { scope } = from
  return api.listSkills('workspaceId' in scope ? scope.workspaceId : undefined).then((skills) => ({
    skills: skills.map(({ handle, description }) => ({ handle, description })),
    /* the list route answers members and owners only, who may add to it */
    addIn: scope,
  }))
}

/** The skills card's create form, in the scope the canvas's skills come from. */
function newSkillPath(scope: AgentScope): string {
  return 'workspaceId' in scope
    ? `/w/${encodeURIComponent(scope.workspaceId)}?pane=agents&skill=new`
    : '/settings?pane=agent&skill=new'
}

/**
 * The `/handle` menu of a field whose text can ask for a skill (the composer,
 * comments, an automation's agent step, Home's prompt box, an agent's
 * Instructions): typing `/` lists the canvas's skills, more letters narrow it,
 * ↑↓ move, Enter or Tab writes `/handle `,
 * Esc closes. Focus never leaves the field. With nothing matching the menu
 * closes, so Enter keeps doing what the field does.
 *
 * `openMenu` writes the `/` itself, for a button beside the field. With
 * `offerNew` the menu ends with "New skill", leading to the create form where
 * this person may add one; only a field whose draft survives leaving the
 * canvas (the composer's) should offer it.
 *
 * The caller spreads `inputProps` on the field, asks `onKeyDown` first in its
 * own key handler, and puts `menu` inside a `relative` box around the field.
 */
export function useSkillMenu({
  from,
  text,
  setText,
  inputRef,
  offerNew = false,
}: {
  /** undefined while the field has no canvas (an automation step before one is picked) */
  from: SkillSource | undefined
  text: string
  setText: (text: string) => void
  inputRef: RefObject<HTMLTextAreaElement | null>
  offerNew?: boolean
}) {
  const t = useT()
  const id = useId()
  const [caret, setCaret] = useState(0)
  /* the last list read, and the source it came from: another source's is never shown */
  const [offered, setOffered] = useState<{ source: string; skills: OfferedSkill[]; addIn: AgentScope | null }>()
  const [dismissed, setDismissed] = useState<number>()
  const [active, setActive] = useState(0)

  const source = from && JSON.stringify(from)
  const partial = from ? partialHandleAt(text, caret) : undefined
  const at = partial?.start
  /* Esc closes the menu of this "/" only: once it is gone, the next one opens */
  if (dismissed !== undefined && at !== dismissed) setDismissed(undefined)
  const shown = offered?.source === source ? offered : undefined
  const skills = shown?.skills
  const addIn = shown?.addIn ?? null
  const live = !!partial && at !== dismissed
  const matches = live && skills ? skills.filter((skill) => skill.handle.includes(partial.query)) : []
  /* "New skill" is the last row while any skill matches, and the only row on a bare "/" */
  const addTo = offerNew && live && skills && (matches.length > 0 || partial.query === '') ? addIn : null
  const count = matches.length + (addTo ? 1 : 0)
  const open = count > 0
  /* on a canvas with no skills, a bare "/" shows where to add them */
  const empty = live && skills?.length === 0 && partial.query === ''
  const index = Math.min(active, count - 1)

  /* read again for each new "/" and each source (an automation step can change
     canvas, Home its scope), so a skill added meanwhile shows; an answer to an
     older ask is dropped */
  useEffect(() => {
    if (!source || at === undefined) return
    let current = true
    fetchSkills(JSON.parse(source) as SkillSource).then(
      (list) => current && setOffered({ source, ...list }),
      /* refused (a viewer who may not ask an agent for work): no menu at all */
      () => current && setOffered(undefined),
    )
    return () => {
      current = false
    }
  }, [source, at])

  function follow(el: HTMLTextAreaElement) {
    setCaret(el.selectionStart)
  }

  function place(at: number) {
    setCaret(at)
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(at, at)
    })
  }

  function pick(handle: string) {
    if (!partial) return
    /* the rest of a handle the caret sits inside, and its space, give way to the pick */
    const rest = text.slice(caret).replace(/^[a-z0-9-]*\s?/, '')
    setText(`${text.slice(0, partial.start)}/${handle} ${rest}`)
    place(partial.start + handle.length + 2)
  }

  /** Write a `/` at the caret (at the end when the field is not focused) and open the menu. */
  function openMenu() {
    const el = inputRef.current
    if (!from || !el) return
    const focused = document.activeElement === el
    const at = focused ? el.selectionStart : text.length
    const to = focused ? el.selectionEnd : text.length
    const already = partialHandleAt(text, at)
    setDismissed(undefined)
    setActive(0)
    if (already && at === to) return place(at)
    const lead = at > 0 && !/[\s(]/.test(text[at - 1] ?? '') ? ' ' : ''
    /* a word right after the caret is the request's, not a handle to finish: keep it apart */
    const trail = to < text.length && !/\s/.test(text[to] ?? '') ? ' ' : ''
    const start = at + lead.length
    setText(`${text.slice(0, at)}${lead}/${trail}${text.slice(to)}`)
    place(start + 1)
  }

  function choose(i: number) {
    const skill = matches[i]
    if (skill) pick(skill.handle)
    else if (addTo) navigate(newSkillPath(addTo))
  }

  /** True when the menu took the key; the field's own handler then stops. */
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!(open || empty) || e.nativeEvent.isComposing) return false
    const take = () => {
      e.preventDefault()
      e.stopPropagation()
      return true
    }
    if (e.key === 'Escape') {
      setDismissed(partial?.start)
      return take()
    }
    if (!open) return false
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const next = (index + (e.key === 'ArrowDown' ? 1 : count - 1)) % count
      setActive(next)
      /* the list scrolls past 220px; keep the picked row in sight */
      document.getElementById(optionId(next))?.scrollIntoView({ block: 'nearest' })
      return take()
    }
    /* a lone "New skill" row (no skills yet, bare "/") takes Enter too, rather than sending "/" */
    if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      choose(index)
      return take()
    }
    return false
  }

  const optionId = (i: number) => `${id}-skill-${i}`
  const inputProps = {
    onChange: (e: ChangeEvent<HTMLTextAreaElement>) => {
      setText(e.target.value)
      setActive(0)
      follow(e.target)
    },
    onSelect: (e: SyntheticEvent<HTMLTextAreaElement>) => follow(e.currentTarget),
    'aria-autocomplete': 'list' as const,
    'aria-expanded': open,
    'aria-controls': open ? `${id}-skills` : undefined,
    'aria-activedescendant': open ? optionId(index) : undefined,
  }

  const row = (i: number) => ({
    id: optionId(i),
    role: 'option',
    'aria-selected': i === index,
    onMouseEnter: () => setActive(i),
    onClick: () => choose(i),
  })

  const menu =
    open || empty ? (
      <div
        className="absolute right-0 bottom-full left-0 z-50 mb-1.5 max-h-[220px] overflow-y-auto rounded-card bg-surface p-1.5 shadow-pop animate-[chip-in_0.18s_ease]"
        /* a press on the list must not take focus from the field; data-pan-stop
           lets it scroll itself on the automation editor's pannable ground */
        data-pan-stop
        onMouseDown={(e) => e.preventDefault()}
      >
        {empty && (
          <p className="px-2.5 py-[7px] text-caption text-ink-faint">
            {addTo ? t('skills.menuEmptyShort') : t('skills.menuEmpty')}
          </p>
        )}
        {open && (
          <div id={`${id}-skills`} role="listbox" aria-label={t('skills.menuLabel')}>
            {matches.map((skill, i) => (
              <div
                key={skill.handle}
                {...row(i)}
                className={cn(menuItemVariants(), 'cursor-pointer flex-col items-start gap-0', i === index && 'bg-sub')}
              >
                <span className="font-mono text-ink">/{skill.handle}</span>
                <span className="w-full truncate text-caption text-ink-faint">{skill.description}</span>
              </div>
            ))}
            {addTo && (
              <div
                {...row(matches.length)}
                className={cn(
                  menuItemVariants(),
                  'cursor-pointer text-ink-soft',
                  matches.length > 0 && 'mt-1 border-t border-line-soft',
                  index === matches.length && 'bg-sub',
                )}
              >
                <PlusIcon size="rail" />
                {t('skills.menuNew')}
              </div>
            )}
          </div>
        )}
      </div>
    ) : null

  return { inputProps, onKeyDown, openMenu, menu }
}
