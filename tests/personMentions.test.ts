import { describe, expect, it } from 'vitest'
import { AGENT_ROLES, DEFAULT_ROLE_ID, mentionedRole } from '../shared/agents.ts'
import {
  AGENT_PICK,
  activeMentionQuery,
  resolvePersonMentions,
  withoutAgentMentions,
  findMentions,
  mentionedPeople,
  mentionSegments,
  nameMatches,
} from '../shared/personMentions.ts'

const ana = { id: 'u1', name: 'Ana Souza' }
const anaB = { id: 'u2', name: 'Ana' }
const bo = { id: 'u3', name: 'Bo' }
const people = [anaB, ana, bo]

describe('findMentions', () => {
  it('finds a name with spaces, case aside', () => {
    expect(mentionedPeople('hey @ana souza, look', people)).toEqual([ana])
  })

  it('prefers the longer name over a prefix of it', () => {
    expect(findMentions('@Ana Souza and @Ana', people).map((m) => m.person.id)).toEqual(['u1', 'u2'])
  })

  it('needs the name to end where a letter would go on', () => {
    expect(mentionedPeople('@Bob is not Bo', people)).toEqual([])
    expect(mentionedPeople('thanks @Bo!', people)).toEqual([bo])
  })

  it('is not an email address', () => {
    expect(mentionedPeople('mail ana@Bo.com', people)).toEqual([])
  })

  it('reads an accent written as a combining mark as part of the name', () => {
    expect(mentionedPeople('@Jose\u0301 hi', [{ id: 'j', name: 'Jose' }])).toEqual([])
  })

  it('starts after punctuation, as the picker does', () => {
    expect(mentionedPeople('(@Bo)', people)).toEqual([bo])
    expect(activeMentionQuery('(@B', 3)).toEqual({ start: 1, query: 'B' })
  })

  it('lists each person once, in order', () => {
    expect(mentionedPeople('@Bo @Ana Souza @Bo', people)).toEqual([bo, ana])
  })
})

describe('mentionSegments', () => {
  it('cuts the text around each mention', () => {
    expect(mentionSegments('hi @Bo, ok', people)).toEqual([
      { text: 'hi ' },
      { text: '@Bo', person: bo },
      { text: ', ok' },
    ])
  })
})

describe('activeMentionQuery', () => {
  it('reads the query typed after an @ at the caret', () => {
    expect(activeMentionQuery('hi @An', 6)).toEqual({ start: 3, query: 'An' })
    expect(activeMentionQuery('@Ana S', 6)).toEqual({ start: 0, query: 'Ana S' })
  })

  it('is nothing inside a word, across lines or after a space right after @', () => {
    expect(activeMentionQuery('ana@b', 5)).toBeNull()
    expect(activeMentionQuery('@a\nb', 4)).toBeNull()
    expect(activeMentionQuery('@ x', 3)).toBeNull()
  })
})

describe('nameMatches', () => {
  it('matches the start of the name or of any word', () => {
    expect(nameMatches('Ana Souza', 'sou')).toBe(true)
    expect(nameMatches('Ana Souza', 'ana s')).toBe(true)
    expect(nameMatches('Ana Souza', 'za')).toBe(false)
  })

  it('stops matching once the whole name and a space are typed', () => {
    expect(nameMatches('Ana Souza', 'ana ')).toBe(true)
    expect(nameMatches('Ana Souza', 'ana souza ')).toBe(false)
  })
})

describe('resolvePersonMentions', () => {
  const sam1 = { id: 's1', name: 'Sam' }
  const sam2 = { id: 's2', name: 'sam' }

  it('reaches a name several people share only through the pick', () => {
    expect(resolvePersonMentions('@Sam look', [sam1, sam2]).ids).toEqual([])
    expect(resolvePersonMentions('@Sam look', [sam1, sam2], ['s2']).ids).toEqual(['s2'])
    expect(resolvePersonMentions('@Sam look', [sam2, sam1], ['s2']).ids).toEqual(['s2'])
  })

  it('gives a name to its owner, never to a shorter one', () => {
    expect(resolvePersonMentions('@Ana Souza ok', people).ids).toEqual(['u1'])
  })

  it('blanks people out of the text the agent matcher reads', () => {
    const brand = { id: 'b', name: `${DEFAULT_ROLE_ID} Fan` }
    const { ids, roleText } = resolvePersonMentions(`hi @${DEFAULT_ROLE_ID} Fan`, [brand])
    expect(ids).toEqual(['b'])
    expect(mentionedRole(roleText, AGENT_ROLES)).toBeUndefined()
    expect(mentionedRole(`hi @${DEFAULT_ROLE_ID} Fan`, AGENT_ROLES)).toBeDefined()
  })

  it('leaves a picked agent to the agent matcher, over a person named like it', () => {
    const named = { id: 'p', name: DEFAULT_ROLE_ID }
    const text = `@${DEFAULT_ROLE_ID} tidy this`
    expect(resolvePersonMentions(text, [named]).ids).toEqual(['p'])
    const agent = resolvePersonMentions(text, [named], [`${AGENT_PICK}${DEFAULT_ROLE_ID}`])
    expect(agent.ids).toEqual([])
    expect(mentionedRole(agent.roleText, AGENT_ROLES)?.id).toBe(DEFAULT_ROLE_ID)
    /* a person picked as well keeps their mention */
    expect(resolvePersonMentions(text, [named], [`${AGENT_PICK}${DEFAULT_ROLE_ID}`, 'p']).ids).toEqual(['p'])
  })

  it('leaves a picked agent whose handle a shorter name begins', () => {
    const short = { id: 'p', name: 'cop' }
    const text = '@copy-editor please'
    expect(resolvePersonMentions(text, [short], [`${AGENT_PICK}copy-editor`]).ids).toEqual([])
  })
})

describe('withoutAgentMentions', () => {
  it("turns agent mentions into names and keeps people's", () => {
    const fan = { id: 'f', name: `${DEFAULT_ROLE_ID} Fan` }
    expect(withoutAgentMentions(`@${DEFAULT_ROLE_ID} asked; cc @${DEFAULT_ROLE_ID} Fan`, AGENT_ROLES, [fan])).toBe(
      `${DEFAULT_ROLE_ID} asked; cc @${DEFAULT_ROLE_ID} Fan`,
    )
  })
})
