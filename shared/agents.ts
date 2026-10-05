/**
 * The resident design team. Every board card names one or more of these
 * roles; the card walks them in order, one stage at a time.
 *
 * A role IS an agent identity: `name` is what shows up in presence, in the
 * activity feed and in @mentions, and colorFor(name) gives it its colour, so
 * two roles never look like the same worker on the canvas. `color` is the
 * role's crew colour, used only to tint its Doop mark.
 */

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
}

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

/** Ready-made pipelines for the board's compose box. */
export const PIPELINE_PRESETS: { id: string; label: string; roles: string[] }[] = [
  { id: 'solo', label: 'Just Doop', roles: ['doop'] },
  { id: 'ship', label: 'Design → polish', roles: ['doop', 'polish'] },
  { id: 'full', label: 'Full pipeline', roles: ['doop', 'copy', 'brand', 'a11y', 'polish'] },
  { id: 'audit', label: 'Review only', roles: ['ux', 'brand', 'a11y'] },
]

const byId = new Map(AGENT_ROLES.map((r) => [r.id, r]))
const byName = new Map(AGENT_ROLES.map((r) => [r.name.toLowerCase(), r]))

export function roleById(id: string | undefined): AgentRole | undefined {
  return id ? byId.get(id) : undefined
}

/** The role an agent name belongs to — undefined for outside agents (MCP). */
export function roleByAgentName(name: string | undefined): AgentRole | undefined {
  return name ? byName.get(name.toLowerCase()) : undefined
}

export function roleName(id: string | undefined): string {
  return roleById(id)?.name ?? roleById(DEFAULT_ROLE_ID)!.name
}

/** Keep only real role ids, in order, without repeats. Empty input = default. */
export function normalizePipeline(ids: unknown): string[] {
  const list = Array.isArray(ids) ? ids : []
  const out: string[] = []
  for (const raw of list) {
    const id = String(raw)
    if (byId.has(id) && !out.includes(id)) out.push(id)
  }
  return out.length > 0 ? out.slice(0, AGENT_ROLES.length) : [DEFAULT_ROLE_ID]
}

/** Every spelling that addresses a role in a comment: @doop, @UXLead, @ux… */
export function mentionsFor(role: AgentRole): string[] {
  return [role.id, role.name.replace(/\s+/g, ''), ...(role.aliases ?? [])].map((m) => m.toLowerCase())
}

/** Every role a piece of text @mentions, in order of first appearance and
 *  without repeats — a chat message's pipeline. */
export function mentionedRoles(text: string): AgentRole[] {
  const found: { role: AgentRole; at: number }[] = []
  for (const role of AGENT_ROLES) {
    let first = -1
    for (const mention of mentionsFor(role)) {
      const at = text.search(new RegExp(`@${mention}\\b`, 'i'))
      if (at >= 0 && (first < 0 || at < first)) first = at
    }
    if (first >= 0) found.push({ role, at: first })
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.role)
}

/** The role a piece of text @mentions, if any. First mention wins. */
export function mentionedRole(text: string): AgentRole | undefined {
  return mentionedRoles(text)[0]
}

/** The text with every resident @mention taken out — what the agent is
 *  actually asked to do, without its own name in the brief. */
export function stripMentions(text: string): string {
  let out = text
  for (const role of AGENT_ROLES) {
    for (const mention of mentionsFor(role)) out = out.replace(new RegExp(`@${mention}\\b`, 'gi'), '')
  }
  return out.replace(/[ \t]{2,}/g, ' ').trim()
}
