/**
 * Custom agents: specialists a person or a workspace adds to the built-in team
 * (shared/agents.ts). One is an ordinary `AgentRole` with `custom: true`; the
 * resident agent runs it the way it runs the Copywriter, with the agent's
 * instructions as its specialty. A canvas has its workspace's custom agents,
 * or on a personal canvas its owner's, the way it has a font library.
 *
 * The handle (its role id, what people @mention) and the name (the identity it
 * works under in presence, tasks and comment threads) are fixed once it
 * exists: open work points at them. Everything else can change.
 */
import { AGENT_ROLES, DEFAULT_ROLE_ID, mentionsFor, type AgentRole } from './agents.ts'

export const MAX_CUSTOM_AGENTS = 20
export const MAX_AGENT_NAME = 32
export const MAX_AGENT_BLURB = 80
export const MIN_AGENT_BRIEF = 20
export const MAX_AGENT_BRIEF = 2000

/** a lowercase word: a letter, then letters and digits */
const HANDLE = /^[a-z][a-z0-9]{1,23}$/
const COLOR = /^#[0-9a-f]{6}$/i
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

/** The swatches the editor offers; any #rrggbb is accepted. */
export const CUSTOM_AGENT_COLORS = [
  '#E8432E',
  '#2743EE',
  '#8B5CF6',
  '#D98E04',
  '#0E8FA0',
  '#0E9F6E',
  '#DB2777',
  '#475569',
] as const

/** Where a custom agent lives: one workspace, or one person's own canvases. */
export type AgentScope = { workspaceId: string } | { personal: true }

export interface CustomAgent extends AgentRole {
  custom: true
  createdAt: number
}

/** What the editor sends to create an agent. */
export interface CustomAgentInput {
  handle: string
  name: string
  color: string
  blurb: string
  brief: string
  reviewer: boolean
}

/** What it sends to change one; the handle and the name stay. */
export type CustomAgentPatch = Partial<Pick<CustomAgentInput, 'color' | 'blurb' | 'brief' | 'reviewer'>>

/** What it sends to change a built-in agent for one team: the same fields,
 *  and whether the agent is switched off. */
export type BuiltInAgentPatch = CustomAgentPatch & { disabled?: boolean }

/** A built-in agent as one team has it: its values with the team's changes
 *  applied, whether it is on, and whether anything differs from how it ships. */
export interface BuiltInAgent extends AgentRole {
  enabled: boolean
  edited: boolean
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

/** Whether a string is shaped like a custom agent's handle. Code that cannot
 *  see a canvas's agents (an automation step's parser) keeps such an id; the
 *  canvas's roster decides what it names when the work runs. */
export function isAgentHandle(id: string): boolean {
  return HANDLE.test(id)
}

/** A handle no built-in agent answers to already. */
function handleTaken(handle: string): boolean {
  return AGENT_ROLES.some((role) => mentionsFor(role).includes(handle))
}

/** A name a built-in agent or a server job already works under. */
function nameTaken(name: string): boolean {
  const key = name.toLowerCase()
  return AGENT_ROLES.some((role) => role.name.toLowerCase() === key)
}

/** A suggested handle for a name: its letters and digits, lowercased. */
export function handleFor(name: string): string {
  const squashed = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/^[0-9]+/, '')
  return squashed.slice(0, 24)
}

function text(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : ''
}

function blurbOf(raw: unknown): Parsed<string> {
  const blurb = text(raw)
  if (!blurb) return { ok: false, error: 'add a one-line description' }
  if (blurb.length > MAX_AGENT_BLURB)
    return { ok: false, error: `keep the description under ${MAX_AGENT_BLURB} characters` }
  return { ok: true, value: blurb }
}

function briefOf(raw: unknown): Parsed<string> {
  /* line breaks are kept: instructions read better as a list */
  const brief = typeof raw === 'string' ? raw.trim() : ''
  if (brief.length < MIN_AGENT_BRIEF) return { ok: false, error: 'describe what the agent does in a sentence or two' }
  if (brief.length > MAX_AGENT_BRIEF)
    return { ok: false, error: `keep the instructions under ${MAX_AGENT_BRIEF} characters` }
  return { ok: true, value: brief }
}

function colorOf(raw: unknown): Parsed<string> {
  return typeof raw === 'string' && COLOR.test(raw)
    ? { ok: true, value: raw.toUpperCase() }
    : { ok: false, error: 'pick a colour' }
}

/** Check a new agent against the built-in team; the caller checks it against
 *  the custom agents already in its scope. */
export function parseCustomAgentInput(raw: unknown): Parsed<CustomAgentInput> {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const name = text(input.name)
  if (name.length < 2 || name.length > MAX_AGENT_NAME || CONTROL.test(name) || name.includes('@'))
    return { ok: false, error: `name the agent in 2 to ${MAX_AGENT_NAME} characters, without @` }
  if (nameTaken(name)) return { ok: false, error: `${name} is already on the team` }
  const handle = typeof input.handle === 'string' ? input.handle.trim().replace(/^@+/, '').toLowerCase() : ''
  if (!HANDLE.test(handle))
    return { ok: false, error: 'the handle is 2 to 24 lowercase letters and digits, starting with a letter' }
  if (handleTaken(handle)) return { ok: false, error: `@${handle} already belongs to a built-in agent` }
  const blurb = blurbOf(input.blurb)
  if (!blurb.ok) return blurb
  const brief = briefOf(input.brief)
  if (!brief.ok) return brief
  const color = colorOf(input.color)
  if (!color.ok) return color
  return {
    ok: true,
    value: {
      handle,
      name,
      color: color.value,
      blurb: blurb.value,
      brief: brief.value,
      reviewer: input.reviewer === true,
    },
  }
}

/** A built-in agent's patch; the default agent cannot be switched off, since
 *  everything addressed to no one (and to an agent that is off) goes to it. */
export function parseBuiltInAgentPatch(roleId: string, raw: unknown): Parsed<BuiltInAgentPatch> {
  if (!AGENT_ROLES.some((role) => role.id === roleId)) return { ok: false, error: 'no such built-in agent' }
  const fields = parseCustomAgentPatch(raw)
  if (!fields.ok) return fields
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  if (!('disabled' in input)) return fields
  if (input.disabled === true && roleId === DEFAULT_ROLE_ID)
    return { ok: false, error: 'Doop is the default agent and stays on: work addressed to no one goes to it' }
  return { ok: true, value: { ...fields.value, disabled: input.disabled === true } }
}

export function parseCustomAgentPatch(raw: unknown): Parsed<CustomAgentPatch> {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const patch: CustomAgentPatch = {}
  if ('blurb' in input) {
    const blurb = blurbOf(input.blurb)
    if (!blurb.ok) return blurb
    patch.blurb = blurb.value
  }
  if ('brief' in input) {
    const brief = briefOf(input.brief)
    if (!brief.ok) return brief
    patch.brief = brief.value
  }
  if ('color' in input) {
    const color = colorOf(input.color)
    if (!color.ok) return color
    patch.color = color.value
  }
  if ('reviewer' in input) patch.reviewer = input.reviewer === true
  return { ok: true, value: patch }
}
