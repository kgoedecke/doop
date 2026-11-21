/**
 * People @mentioned in a comment. A mention is `@` and the person's name as
 * their account spells it (`@Ana Souza`), matched without case, at the start
 * of the text or after a space or punctuation, and ending where a letter or
 * digit does not follow. The editor's picker writes exactly that, and an
 * agent tags someone by writing it too, so the text is the whole record:
 * nothing beside it is stored, and the server reads the mentions again from
 * the text when it decides who to tell.
 *
 * Longer names win over a prefix of them (`@Ana Souza` over `@Ana`), and two
 * mentions never share characters. Names are not unique: where several people
 * share the one written, the editor sends the ids it picked alongside the text,
 * and a name nobody picked among several reaches nobody rather than a guess
 * (resolvePersonMentions).
 */

import { withoutMentions, type Roster } from './agents.ts'

export interface Mentionable {
  id: string
  name: string
}

export interface MentionMatch<P extends Mentionable = Mentionable> {
  person: P
  /** index of the `@` */
  start: number
  /** index just past the name */
  end: number
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/* what continues a name: a letter (accents written as combining marks too),
   a digit or an underscore. A mention starts after anything else but an @ */
const NAME_CHAR = '[\\p{L}\\p{M}\\p{N}_]'
const startsMention = (before: string | undefined) => !before || !new RegExp(`${NAME_CHAR}|@`, 'u').test(before)

/** Every mention in the text, in order. */
export function findMentions<P extends Mentionable>(text: string, people: readonly P[]): MentionMatch<P>[] {
  if (!text.includes('@')) return []
  const found: MentionMatch<P>[] = []
  const taken = (start: number, end: number) => found.some((m) => start < m.end && m.start < end)
  const byLength = [...people].filter((p) => p.name.trim()).sort((a, b) => b.name.length - a.name.length)
  for (const person of byLength) {
    const pattern = new RegExp(`@${escape(person.name.trim())}(?!${NAME_CHAR})`, 'giu')
    for (const m of text.matchAll(pattern)) {
      const start = m.index ?? 0
      const end = start + m[0].length
      if (startsMention(text[start - 1]) && !taken(start, end)) found.push({ person, start, end })
    }
  }
  return found.sort((a, b) => a.start - b.start)
}

/** The people the text mentions, each once, in order of first mention. */
export function mentionedPeople<P extends Mentionable>(text: string, people: readonly P[]): P[] {
  const seen = new Set<string>()
  const out: P[] = []
  for (const { person } of findMentions(text, people)) {
    if (seen.has(person.id)) continue
    seen.add(person.id)
    out.push(person)
  }
  return out
}

/** How the editor's picker marks an agent it picked among the ids it sends
 *  (`agent:polish`), so a person named like the agent's handle is not taken
 *  for it. */
export const AGENT_PICK = 'agent:'

export interface ResolvedMentions {
  /** the people the text mentions, each once */
  ids: string[]
  /** the text with every person's mention blanked out, for the agent
   *  matcher: `@Brand Smith` must not read as `@brand` */
  roleText: string
}

/** Who a comment's text mentions among `people`. A name several people share
 *  goes to those of them in `picked` (the ids the editor's picker chose), and
 *  to nobody when none of them was picked. Where the picker chose an agent
 *  (`AGENT_PICK`) whose handle is written there, and none of the people the
 *  name could be, the mention is the agent's and is left in `roleText`. */
export function resolvePersonMentions(
  text: string,
  people: readonly Mentionable[],
  picked: readonly string[] = [],
): ResolvedMentions {
  const byName = new Map<string, Mentionable[]>()
  for (const p of people) {
    const key = p.name.trim().toLowerCase()
    if (!key) continue
    byName.set(key, [...(byName.get(key) ?? []), p])
  }
  const names = [...byName.keys()].map((key) => ({ id: key, name: key }))
  const agentPicks = picked.filter((p) => p.startsWith(AGENT_PICK)).map((p) => p.slice(AGENT_PICK.length).toLowerCase())
  const agentAt = (m: MentionMatch, handle: string) =>
    handle.length >= m.end - m.start - 1 &&
    text.slice(m.start + 1, m.start + 1 + handle.length).toLowerCase() === handle
  const ids = new Set<string>()
  let roleText = text
  for (const m of findMentions(text, names)) {
    const sharing = byName.get(m.person.id) ?? []
    const pickedHere = sharing.filter((p) => picked.includes(p.id))
    if (!pickedHere.length && agentPicks.some((handle) => agentAt(m, handle))) continue
    const chosen = sharing.length === 1 ? sharing : pickedHere
    for (const p of chosen) ids.add(p.id)
    roleText = roleText.slice(0, m.start) + ' '.repeat(m.end - m.start) + roleText.slice(m.end)
  }
  return { ids: [...ids], roleText }
}

/** The text cut into plain runs and mentions, for drawing mentions apart. */
export function mentionSegments<P extends Mentionable>(
  text: string,
  people: readonly P[],
): ({ text: string; person?: undefined } | { text: string; person: P })[] {
  const out: ({ text: string; person?: undefined } | { text: string; person: P })[] = []
  let at = 0
  for (const m of findMentions(text, people)) {
    if (m.start > at) out.push({ text: text.slice(at, m.start) })
    out.push({ text: text.slice(m.start, m.end), person: m.person })
    at = m.end
  }
  if (at < text.length) out.push({ text: text.slice(at) })
  return out
}

/** The `@query` being typed at the caret, if any: from an `@` where a mention
 *  may start (findMentions' rule), up to the caret, on one line. Names have
 *  spaces, so the query may too, up to a length no name reaches. */
export function activeMentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at < 0) return null
  if (!startsMention(before[at - 1])) return null
  const query = before.slice(at + 1)
  if (query.length > 40 || /[\n@]/.test(query) || /^\s/.test(query) || /\s{2}/.test(query)) return null
  return { start: at, query }
}

/** Whether a name answers a typed query: the whole name, or any of its words,
 *  starts with it. A trailing space counts, so `@Ana ` still leads to
 *  `Ana Souza` but a name just picked (`@Ana Souza `) answers nothing more. */
export function nameMatches(name: string, query: string): boolean {
  const q = query.trimStart().toLowerCase()
  if (!q) return true
  const n = name.toLowerCase()
  return n.startsWith(q) || n.split(/\s+/).some((word) => word.startsWith(q))
}

/** The text with every agent @mention turned into a plain name, except inside
 *  a person's mention: words an agent writes about a request must not become
 *  a new one, but `@Brand Smith` stays a mention of Brand Smith. */
export function withoutAgentMentions(text: string, roster: Roster, people: readonly Mentionable[]): string {
  return mentionSegments(text, people)
    .map((part) => (part.person ? part.text : withoutMentions(part.text, roster)))
    .join('')
}
