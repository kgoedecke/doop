import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, ServerMessage } from '../shared/types.ts'

/* The chat mirrors into Postgres and broadcasts; these tests only care about
   how a message turns into a card and how the agent's answer threads back. */
vi.mock('../server/db/persist.ts', () => ({
  CHAT_LOG_CAP: 300,
  deleteChat: () => {},
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveChat: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
}))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')

const CANVAS = 'canvas-1'
const canvas: Canvas = { id: CANVAS, name: 'Test', createdAt: 0, updatedAt: 0, frames: [] }

let sent: ServerMessage[]

beforeEach(() => {
  sent = []
  actions.wire(
    (_canvasId, msg) => {
      sent.push(msg)
    },
    () => {},
  )
  actions.hydrateLogs({
    tasks: new Map(),
    feedback: new Map(),
    comments: new Map(),
    chat: new Map(),
    activity: new Map(),
    decisions: new Map(),
    proposals: new Map(),
  })
  vi.spyOn(store, 'getCanvas').mockImplementation((id) => (id === CANVAS ? canvas : undefined))
})

describe('canvas chat', () => {
  it('posts a plain message without queueing anything', () => {
    const m = actions.addChatMessage(CANVAS, 'looks great to me', 'alice', 'u1')!
    expect(m.text).toBe('looks great to me')
    expect(m.fromKind).toBe('user')
    expect(m.taskId).toBeUndefined()
    expect(m.mentions).toBeUndefined()
    expect(actions.getTasks(CANVAS)).toHaveLength(0)
    expect(actions.getChat(CANVAS)).toEqual([m])
    expect(sent).toContainEqual({ type: 'chat', message: m })
  })

  it('turns @mentions into a card for those agents, in mention order', () => {
    const m = actions.addChatMessage(CANVAS, '@polish then @doop make the hero taller', 'alice', 'u1')!
    expect(m.mentions).toEqual(['polish', 'doop'])
    const card = actions.getTasks(CANVAS).find((t) => t.id === m.taskId)!
    expect(card.pipeline).toEqual(['polish', 'doop'])
    expect(card.queuedBy).toBe('alice')
    expect(card.queuedByUserId).toBe('u1')
    /* the agent reads the request, not its own name */
    expect(card.status).toBe('then make the hero taller')
  })

  it('keeps the whole text as the brief when it is nothing but a mention', () => {
    const m = actions.addChatMessage(CANVAS, '@a11y', 'alice')!
    const card = actions.getTasks(CANVAS).find((t) => t.id === m.taskId)!
    expect(card.status).toBe('@a11y')
  })

  it('ignores empty messages and unknown canvases', () => {
    expect(actions.addChatMessage(CANVAS, '   ', 'alice')).toBeUndefined()
    expect(actions.addChatMessage('nope', 'hello', 'alice')).toBeUndefined()
  })

  it('threads the agent answer under the message that queued the card', () => {
    const asked = actions.addChatMessage(CANVAS, '@doop add a footer', 'alice')!
    const actor = actions.resolveActor({ name: 'Doop', kind: 'agent' })
    const reply = actions.chatReplyForCard(CANVAS, asked.taskId!, actor, 'Added a  three-column\nfooter.')!
    expect(reply.fromKind).toBe('agent')
    expect(reply.from).toBe('Doop')
    expect(reply.replyToId).toBe(asked.id)
    expect(reply.taskId).toBe(asked.taskId)
    expect(reply.text).toBe('Added a three-column footer.')
    expect(reply.at).toBeGreaterThan(asked.at)
    expect(actions.getChat(CANVAS).map((m) => m.id)).toEqual([reply.id, asked.id])
  })

  it('says nothing for cards that did not come from the chat', () => {
    const card = actions.addQueuedCard(CANVAS, 'board card', 'alice', ['doop'])!
    const actor = actions.resolveActor({ name: 'Doop', kind: 'agent' })
    expect(actions.chatReplyForCard(CANVAS, card.id, actor, 'done')).toBeUndefined()
  })
})

describe('chat history cap', () => {
  it('prunes the rows that fall off the cap', async () => {
    const persist = await import('../server/db/persist.ts')
    const deleted = vi.spyOn(persist, 'deleteChat')
    for (let i = 0; i < persist.CHAT_LOG_CAP; i++) actions.addChatMessage(CANVAS, `m${i}`, 'alice')
    expect(deleted).toHaveBeenLastCalledWith([])
    const oldest = actions.getChat(CANVAS).at(-1)!
    actions.addChatMessage(CANVAS, 'one more', 'alice')
    expect(actions.getChat(CANVAS)).toHaveLength(persist.CHAT_LOG_CAP)
    expect(deleted).toHaveBeenLastCalledWith([oldest.id])
  })
})
