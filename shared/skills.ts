/**
 * Skills: named instructions a workspace (or a person, for their personal
 * canvases) writes once and asks for by name. Writing `/handle` in a request
 * adds that skill's instructions to the run that does the work, whichever
 * agent takes it. Spec: .context/specs/skills.md.
 *
 * The handle is fixed once a skill exists: queued work may name it.
 */
import type { AgentScope, Parsed } from './customAgents.ts'

export const MAX_SKILLS = 50
export const MAX_SKILLS_PER_RUN = 5
export const MAX_SKILL_DESCRIPTION = 120
export const MIN_SKILL_BODY = 20
export const MAX_SKILL_BODY = 8000

/** a lowercase word that may carry hyphens: brand-check */
const HANDLE = '[a-z][a-z0-9-]{1,31}'
const WHOLE_HANDLE = new RegExp(`^${HANDLE}$`)
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

export interface Skill {
  handle: string
  description: string
  body: string
  createdAt: number
  updatedAt: number
}

/** What the editor sends to create a skill. */
export type SkillInput = Pick<Skill, 'handle' | 'description' | 'body'>

/** What it sends to change one; the handle stays. */
export type SkillPatch = Partial<Pick<Skill, 'description' | 'body'>>

/** A skill as a canvas's /handle menu lists it: never its body. */
export type OfferedSkill = Pick<Skill, 'handle' | 'description'>

/** `GET /api/canvases/:id/skills`: the skills a request there can name, and
 *  the scope this viewer may add one to (null when they may not). */
export interface CanvasSkills {
  skills: OfferedSkill[]
  addIn: AgentScope | null
}

function descriptionOf(raw: unknown): Parsed<string> {
  /* control characters are checked before whitespace is squashed, so a stray
     bell or escape is refused rather than turned into a space */
  const description = typeof raw === 'string' ? raw : ''
  if (CONTROL.test(description.trim())) return { ok: false, error: 'keep the description to one plain line' }
  const line = description.trim().replace(/\s+/g, ' ')
  if (!line || line.length > MAX_SKILL_DESCRIPTION)
    return { ok: false, error: `describe the skill in 1 to ${MAX_SKILL_DESCRIPTION} characters` }
  return { ok: true, value: line }
}

function bodyOf(raw: unknown): Parsed<string> {
  /* line breaks are kept: instructions read better as a list */
  const body = typeof raw === 'string' ? raw.trim() : ''
  if (body.length < MIN_SKILL_BODY || body.length > MAX_SKILL_BODY)
    return { ok: false, error: `write the instructions in ${MIN_SKILL_BODY} to ${MAX_SKILL_BODY} characters` }
  return { ok: true, value: body }
}

/** Check a new skill; the caller checks its handle against the scope's. */
export function parseSkillInput(raw: unknown): Parsed<SkillInput> {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const handle = typeof input.handle === 'string' ? input.handle.trim().replace(/^\/+/, '').toLowerCase() : ''
  if (!WHOLE_HANDLE.test(handle))
    return { ok: false, error: 'the handle is 2 to 32 lowercase letters, digits and hyphens, starting with a letter' }
  const description = descriptionOf(input.description)
  if (!description.ok) return description
  const body = bodyOf(input.body)
  if (!body.ok) return body
  return { ok: true, value: { handle, description: description.value, body: body.value } }
}

export function parseSkillPatch(raw: unknown): Parsed<SkillPatch> {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const patch: SkillPatch = {}
  if ('description' in input) {
    const description = descriptionOf(input.description)
    if (!description.ok) return description
    patch.description = description.value
  }
  if ('body' in input) {
    const body = bodyOf(input.body)
    if (!body.ok) return body
    patch.body = body.value
  }
  return { ok: true, value: patch }
}

/* a /handle starts the text or follows whitespace or "(", and ends at
   whitespace, the end or punctuation that itself ends there, so /c/abc,
   https://x.com/brand and /brand.html are not skills */
const MENTION = new RegExp(`(?:^|[\\s(])/(${HANDLE})(?=[.,;:!?)]*(?:$|\\s))`, 'g')

/** Every `/handle` the text names, in order of first appearance. Only
 *  candidates: the server keeps the ones the canvas's scope has. */
export function skillHandlesIn(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(MENTION), (match) => match[1] ?? ''))]
}

/* the same rule as MENTION, for a handle still being typed: the slash starts
   the text or follows whitespace or "(", and only handle characters follow */
const PARTIAL = /(?:^|[\s(])\/([a-z0-9-]*)$/

/** The `/handle` being typed just before the caret, for the composer's skill
 *  menu: where its slash is and what follows it. */
export function partialHandleAt(text: string, caret: number): { start: number; query: string } | undefined {
  const before = text.slice(0, caret)
  const match = PARTIAL.exec(before)
  if (!match) return undefined
  const query = match[1] ?? ''
  return { start: before.length - query.length - 1, query }
}

/** The system block for the skills a run's requests name with `/handle`, or
 *  undefined when they name none of `skills` (the canvas's). A handle with no
 *  skill is left as text; past MAX_SKILLS_PER_RUN the rest are too. */
export function skillsBlock(skills: Skill[], text: string): string | undefined {
  const named = skillHandlesIn(text)
    .map((handle) => skills.find((skill) => skill.handle === handle))
    .filter((skill): skill is Skill => !!skill)
    .slice(0, MAX_SKILLS_PER_RUN)
  if (!named.length) return undefined
  return [
    '# Skills requested for this work',
    "These skills were asked for by name (`/handle` in the request or in your role's instructions). Follow their instructions for this work, alongside everything above.",
    ...named.map((skill) => `## /${skill.handle}: ${skill.description}\n\n${skill.body}`),
  ].join('\n\n')
}
