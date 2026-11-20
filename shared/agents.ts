/**
 * The resident design team. Every board card names one or more of these
 * roles; the card walks them in order, one stage at a time.
 *
 * A role IS an agent identity: `name` is what shows up in presence, in the
 * activity feed and in @mentions, and colorFor(name) gives it its colour, so
 * two roles never look like the same worker on the canvas. `color` is the
 * role's crew colour, used only to tint its Doop mark.
 */
import { STORYBOOK_WORKER } from './storybookSource.ts'

export interface AgentRole {
  id: string
  /** the identity this agent works under — presence, tasks, @mentions */
  name: string
  /** the crew colour from doop.design's team section — tints the role's mark */
  color: string
  /** one line for the picker */
  blurb: string
  /** the agent's specialty, injected into its system prompt */
  brief: string
  /** critiques and corrects existing work — finishing without an edit is a
   *  legitimate outcome ("already meets the bar"), so no mutation is required */
  reviewer?: boolean
  /** extra @mention spellings beyond the id and the squashed name */
  aliases?: string[]
  /** defined by a person or a workspace (shared/customAgents.ts) rather than
   *  built in: its id is the handle people @mention, and it answers to
   *  nothing else, since a name typed by a person need not be a word */
  custom?: boolean
  /** a built-in agent whose instructions its team rewrote: the resident sets
   *  them apart as it does a custom agent's (shared/customAgents.ts) */
  briefByTeam?: boolean
}

/** The agents one canvas has: the built-in team, then the custom agents of its
 *  workspace (or, on a personal canvas, of its owner). Every lookup below
 *  takes one, so an agent defined in one workspace never answers in another. */
export type Roster = readonly AgentRole[]

export const AGENT_ROLES: AgentRole[] = [
  {
    id: 'doop',
    name: 'Doop',
    color: '#E8432E',
    blurb: 'Generalist designer — makes the thing',
    brief:
      'You are the generalist designer. You originate work: new frames, layouts, full redesigns, and any change that does not belong to a specialist. Build the deliverable the card asks for, complete and presentable.',
    aliases: ['design', 'designer'],
  },
  {
    id: 'ux',
    name: 'UX Lead',
    color: '#2743EE',
    blurb: 'Flow, hierarchy, states, affordances',
    brief:
      'You are the UX lead. Judge the design as an interface someone has to use: is the primary action obvious, is the reading order the decision order, are labels unambiguous, are empty/loading/error/disabled states accounted for, are targets and affordances legible as interactive? Fix structure and hierarchy — do not restyle for taste.',
    aliases: ['usability'],
  },
  {
    id: 'copy',
    name: 'Copywriter',
    color: '#8B5CF6',
    blurb: 'Headlines, microcopy, labels, CTAs',
    brief:
      'You are the copywriter. Own every word in the frame: headline, subhead, body, labels, button text, empty states, error messages. Make it specific, human and short — cut filler, kill vague verbs, prefer concrete nouns. Keep the layout intact; if a rewrite changes the line count, keep it inside the existing box.',
    aliases: ['content', 'words'],
  },
  {
    id: 'brand',
    name: 'Brand Compliance',
    color: '#D98E04',
    blurb: 'Palette, type, logo, tone of voice',
    brief:
      'You are brand compliance. Check the frame against the brand as it is established on this canvas — take the dominant palette, type family, scale, radii and tone from the other frames and any frame that reads as a brand or style guide. Flag and fix off-palette colours, stray fonts, inconsistent radii or shadows, misused logo treatment, and off-tone voice. Do not redesign; bring the frame into line.',
    reviewer: true,
    aliases: ['branding'],
  },
  {
    id: 'a11y',
    name: 'Accessibility',
    color: '#0E8FA0',
    blurb: 'Contrast, semantics, focus, target size',
    brief:
      'You are the accessibility reviewer. Check contrast against WCAG AA (4.5:1 body, 3:1 large text and meaningful UI edges), semantic structure (one h1, ordered headings, landmarks, real buttons and labels over styled divs), alt text on meaningful images, visible focus styles, and touch targets of at least 44px. Fix what fails without changing the design intent.',
    reviewer: true,
    aliases: ['accessible', 'accessibility'],
  },
  {
    id: 'polish',
    name: 'Visual Polish',
    color: '#0E9F6E',
    blurb: 'Spacing rhythm, alignment, final detail',
    brief:
      'You are the polish pass, and you go last. Tighten optical alignment, enforce one spacing scale, even out the type ramp, balance weights and densities, fix ragged edges and orphaned words, and make sure nothing overflows or collides at the frame size. Small, surgical changes only — never restructure.',
    reviewer: true,
    aliases: ['polish', 'detail'],
  },
]

export const DEFAULT_ROLE_ID = 'doop'
export const DEFAULT_ROLE_NAME = 'Doop'

/** Ready-made pipelines for the board's compose box. */
export const PIPELINE_PRESETS: { id: string; label: string; roles: string[] }[] = [
  { id: 'solo', label: 'Just Doop', roles: ['doop'] },
  { id: 'ship', label: 'Design → polish', roles: ['doop', 'polish'] },
  { id: 'full', label: 'Full pipeline', roles: ['doop', 'copy', 'brand', 'a11y', 'polish'] },
  { id: 'audit', label: 'Review only', roles: ['ux', 'brand', 'a11y'] },
]

/** The built-in team plus a canvas's custom agents. */
export function rosterWith(custom: readonly AgentRole[] | undefined): Roster {
  return custom?.length ? [...AGENT_ROLES, ...custom] : AGENT_ROLES
}

export function roleById(id: string | undefined, roster: Roster): AgentRole | undefined {
  return id ? roster.find((r) => r.id === id) : undefined
}

/** The role an agent name belongs to — undefined for outside agents (MCP). */
export function roleByAgentName(name: string | undefined, roster: Roster): AgentRole | undefined {
  const key = name?.toLowerCase()
  return key ? roster.find((r) => r.name.toLowerCase() === key) : undefined
}

/** Server-side jobs that show up in the Agents panel the way an agent does —
 *  a named worker with a task and a progress bar — but are no one's AI: they
 *  don't count as "you connected an agent", and there is no one to reply to. */
const JOB_WORKERS = new Set([STORYBOOK_WORKER.toLowerCase()])

export function isJobWorker(name: string | undefined): boolean {
  return !!name && JOB_WORKERS.has(name.toLowerCase())
}

/** The name a role id works under. An id the roster no longer has (a custom
 *  agent deleted while a card waited on it) falls to the default agent. */
export function roleName(id: string | undefined, roster: Roster = AGENT_ROLES): string {
  return roleById(id, roster)?.name ?? DEFAULT_ROLE_NAME
}

/** Keep only real role ids, in order, without repeats. Empty input = default. */
export function normalizePipeline(ids: unknown, roster: Roster): string[] {
  const list = Array.isArray(ids) ? ids : []
  const out: string[] = []
  for (const raw of list) {
    const id = String(raw)
    if (roleById(id, roster) && !out.includes(id)) out.push(id)
  }
  return out.length > 0 ? out.slice(0, roster.length) : [DEFAULT_ROLE_ID]
}

/** Every spelling that addresses a role in a comment: @doop, @UXLead, @ux…
 *  A custom agent answers to its handle alone. */
export function mentionsFor(role: AgentRole): string[] {
  if (role.custom) return [role.id]
  return [role.id, role.name.replace(/\s+/g, ''), ...(role.aliases ?? [])].map((m) => m.toLowerCase())
}

function mentionPattern(mention: string, flags: string): RegExp {
  return new RegExp(`@+(${mention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\b`, flags)
}

/** Every role a piece of text @mentions, in order of first appearance and
 *  without repeats. */
export function mentionedRoles(text: string, roster: Roster): AgentRole[] {
  const found: { role: AgentRole; at: number }[] = []
  for (const role of roster) {
    let first = -1
    for (const mention of mentionsFor(role)) {
      const at = text.search(mentionPattern(mention, 'i'))
      if (at >= 0 && (first < 0 || at < first)) first = at
    }
    if (first >= 0) found.push({ role, at: first })
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.role)
}

/** The role a piece of text @mentions, if any. First mention wins. */
export function mentionedRole(text: string, roster: Roster): AgentRole | undefined {
  return mentionedRoles(text, roster)[0]
}

/** The same text with every resident @mention turned into a plain name, so
 *  words that quote a request cannot become a new one. */
export function withoutMentions(text: string, roster: Roster): string {
  let out = text
  for (const role of roster)
    for (const mention of mentionsFor(role)) out = out.replace(mentionPattern(mention, 'gi'), '$1')
  return out
}
