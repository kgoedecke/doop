import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, Frame, ServerMessage } from '../shared/types.ts'
import type { CanvasEvent } from '../server/events.ts'
import { isCanvasComment } from '../shared/comments.ts'

/**
 * Comments anywhere on the canvas: a comment pinned to a world point on a
 * page rather than to an element inside a frame. Persistence and the room
 * are stubbed; everything else (the action layer, the event bus, links, the
 * resident agent's kickoff text) runs for real.
 */

vi.mock('../server/db/persist.ts', () => ({
  saveFrame: () => {},
  saveFrameNow: async () => {},
  saveCanvas: () => {},
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
}))
vi.mock('../server/distill.ts', () => ({ onDecision: () => {} }))

const actions = await import('../server/actions.ts')
const events = await import('../server/events.ts')
const { commentLink } = await import('../server/links.ts')
const { createFrameInput, describeCommentAnchor, placeBeside, placementFor } = await import('../server/resident.ts')
const { store } = await import('../server/store.ts')
const { DEFAULT_ROLE_ID, roleName } = await import('../shared/agents.ts')

const AGENT = roleName(DEFAULT_ROLE_ID)
const HERO: Frame = {
  id: 'f1',
  canvasId: 'c1',
  pageId: 'p1',
  name: 'Hero',
  html: '<h1>Hi</h1><p/>',
  x: 0,
  y: 0,
  width: 640,
  height: 480,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'alice',
}
const PRICING: Frame = { ...HERO, id: 'f2', name: 'Pricing', x: 1000, y: 0 }
const CANVAS: Canvas = {
  id: 'c1',
  name: 'Landing',
  ownerId: 'alice',
  createdAt: 0,
  updatedAt: 0,
  pages: [
    { id: 'p1', name: 'Home' },
    { id: 'p2', name: 'Checkout' },
  ],
  frames: [HERO, PRICING],
}

const broadcast = vi.fn<(canvasId: string, msg: ServerMessage) => void>()
let unsubscribe = () => {}
const seen: CanvasEvent[] = []

beforeEach(() => {
  broadcast.mockClear()
  seen.length = 0
  actions.wire(broadcast, () => {})
  actions.hydrateLogs({
    tasks: new Map(),
    feedback: new Map(),
    comments: new Map([[CANVAS.id, []]]),
    activity: new Map([[CANVAS.id, []]]),
    decisions: new Map([[CANVAS.id, []]]),
    proposals: new Map(),
  })
  vi.spyOn(store, 'getCanvas').mockImplementation((id) => (id === CANVAS.id ? CANVAS : undefined))
  vi.spyOn(store, 'getFrame').mockImplementation((id) => CANVAS.frames.find((f) => f.id === id))
  /* a comment stamps its element's id into the frame: apply it to the fixture */
  vi.spyOn(store, 'updateFrame').mockImplementation((id, patch) => {
    const f = store.getFrame(id)
    return f ? Object.assign(f, patch) : undefined
  })
  unsubscribe = events.onCanvasEvent((_id, event) => void seen.push(event))
})

afterEach(() => {
  unsubscribe()
  vi.restoreAllMocks()
})

const place = (text = 'Move the pricing closer', from = 'alice') =>
  actions.addCanvasComment(CANVAS.id, { pageId: 'p1', x: 820, y: 240, text }, from, from)

describe('addCanvasComment', () => {
  it('pins the comment to the page point with no frame or element', () => {
    const c = place()!
    expect(c).toMatchObject({ canvasId: 'c1', pageId: 'p1', x: 820, y: 240, snippet: '', from: 'alice' })
    expect(c.frameId).toBeUndefined()
    expect(isCanvasComment(c)).toBe(true)
    expect(actions.getComments(CANVAS.id)).toEqual([c])
  })

  it('reaches the room and the activity feed, and the event bus without a frame', () => {
    const c = place()!
    expect(broadcast).toHaveBeenCalledWith('c1', { type: 'comment', comment: c })
    expect(actions.getActivity(CANVAS.id)[0]?.message).toBe('commented on the canvas: “Move the pricing closer”')
    expect(seen).toEqual([{ type: 'comment.created', comment: c, frame: undefined, actorKind: 'user' }])
  })

  it('refuses an unknown canvas, a page the canvas does not have, a bad point or blank text', () => {
    expect(actions.addCanvasComment('nope', { pageId: 'p1', x: 0, y: 0, text: 'hi' }, 'alice')).toBeUndefined()
    expect(actions.addCanvasComment('c1', { pageId: 'p9', x: 0, y: 0, text: 'hi' }, 'alice')).toBeUndefined()
    expect(actions.addCanvasComment('c1', { pageId: 'p1', x: NaN, y: 0, text: 'hi' }, 'alice')).toBeUndefined()
    expect(actions.addCanvasComment('c1', { pageId: 'p1', x: 0, y: Infinity, text: 'hi' }, 'alice')).toBeUndefined()
    expect(actions.addCanvasComment('c1', { pageId: 'p1', x: 0, y: 0, text: '   ' }, 'alice')).toBeUndefined()
    expect(actions.getComments(CANVAS.id)).toEqual([])
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('routes an @mention to the resident agent like an element comment', () => {
    const c = place(`@${DEFAULT_ROLE_ID} add a testimonial strip here`)!
    expect(c.forAgent).toBe(true)
    expect(c.targetAgent).toBe(AGENT)
    expect(actions.pendingWorkAgents(CANVAS.id)).toEqual([AGENT])
    expect(actions.takeAgentCommentsFor(CANVAS.id, AGENT, 'alice').map((x) => x.id)).toEqual([c.id])
  })
})

describe('threads on a canvas comment', () => {
  it('opens for replies without a frame, and replies inherit the point', () => {
    const root = place()!
    expect(actions.openThread(root.id)).toEqual({ root })
    const reply = actions.replyToComment(root.id, 'Agreed', 'bob', 'bob')!
    expect(reply).toMatchObject({ parentId: root.id, pageId: 'p1', x: 820, y: 240, snippet: '' })
    expect(reply.frameId).toBeUndefined()
    expect(actions.commentThread(reply).map((c) => c.text)).toEqual(['Move the pricing closer', 'Agreed'])
    expect(actions.getActivity(CANVAS.id)[0]?.message).toBe('replied to a comment on the canvas: “Agreed”')
  })

  it('resolves like any thread and reports the resolution without a frame', () => {
    const root = place(`@${DEFAULT_ROLE_ID} tighten the gap`)!
    actions.replyToComment(root.id, 'On it', AGENT, 'alice', 'agent')
    seen.length = 0
    actions.resolveComment(root.id, AGENT)
    expect(actions.getComments(CANVAS.id).every((c) => c.resolvedAt)).toBe(true)
    expect(actions.openThread(root.id)).toBeUndefined()
    expect(seen.at(-1)).toMatchObject({ type: 'comment.resolved', frame: undefined, by: AGENT })
    /* an @agent instruction that got carried out is a decision, frame or not */
    expect(actions.getDecisions(CANVAS.id)).toMatchObject([{ text: '@doop tighten the gap', source: 'comment' }])
    expect(actions.getDecisions(CANVAS.id)[0]?.frameId).toBeUndefined()
  })

  it('still needs the frame for an element comment thread', async () => {
    const root = (await actions.addElementComment(
      HERO.id,
      { selector: 'h1', snippet: '<h1/>', text: 'Bigger' },
      'alice',
    ))!
    expect(actions.openThread(root.id)).toEqual({ root, frame: HERO })
    vi.spyOn(store, 'getFrame').mockReturnValue(undefined)
    expect(actions.openThread(root.id)).toBeUndefined()
  })
})

describe('where a canvas comment leads', () => {
  it('links to the canvas page with the thread, not to a frame', () => {
    const root = place()!
    const reply = actions.replyToComment(root.id, 'Agreed', 'bob')!
    expect(commentLink(root)).toBe(`http://localhost:4300/c/c1?page=p1&comment=${root.id}`)
    expect(commentLink(reply)).toBe(`http://localhost:4300/c/c1?page=p1&comment=${root.id}`)
  })

  it('tells the resident agent the point, the page and the frames around it', () => {
    const between = place()!
    expect(describeCommentAnchor(between, CANVAS)).toBe(
      'on the canvas at (820, 240) on page "Home" — not pinned to any element; nearest frames: f1 ("Hero"), f2 ("Pricing")',
    )
    const inside = actions.addCanvasComment(CANVAS.id, { pageId: 'p1', x: 100, y: 100, text: 'here' }, 'alice')!
    expect(describeCommentAnchor(inside, CANVAS)).toContain('nearest frames: f1 ("Hero")')
    expect(describeCommentAnchor(inside, CANVAS)).not.toContain('Pricing')
    const elsewhere = actions.addCanvasComment(CANVAS.id, { pageId: 'p2', x: 5, y: 5, text: 'here' }, 'alice')!
    expect(describeCommentAnchor(elsewhere, CANVAS)).toBe(
      'on the canvas at (5, 5) on page "Checkout" — not pinned to any element',
    )
  })

  it('puts a frame the resident agent creates for a canvas comment on its page, beside the pin', () => {
    const c = actions.addCanvasComment(
      CANVAS.id,
      { pageId: 'p2', x: 300, y: 200, text: `@${DEFAULT_ROLE_ID} add a FAQ here` },
      'alice',
      'alice',
    )!
    const placement = placementFor(c, CANVAS)
    expect(placement).toEqual({ pageId: 'p2', near: { x: 300, y: 200 } })
    const input = createFrameInput({ name: 'FAQ', width: 800, height: 500, html: '<html></html>' }, placement, CANVAS)
    expect(input).toEqual({ name: 'FAQ', width: 800, height: 500, html: '<html></html>', pageId: 'p2', x: 340, y: 200 })
  })

  it('moves a new frame down past anything beside the pin it would overlap', () => {
    /* right of the Hero (0..640 × 0..480): the first clear step below it */
    const underHero = placeBeside({ x: 100, y: 100 }, { width: 800, height: 500 }, [HERO, PRICING])
    expect(underHero.x).toBe(140)
    expect(underHero.y).toBeGreaterThanOrEqual(480)
    /* between the frames: the box would run into Pricing (1000..1640) */
    expect(placeBeside({ x: 820, y: 240 }, { width: 800, height: 500 }, [HERO, PRICING])).toEqual({ x: 860, y: 480 })
  })

  it("keeps a frame asked for by an element comment on that frame's page, and lets the model pick a spot", async () => {
    const c = (await actions.addElementComment(
      HERO.id,
      { selector: 'h1', snippet: '<h1/>', text: 'add a FAQ' },
      'alice',
    ))!
    expect(placementFor(c, CANVAS)).toEqual({ pageId: 'p1' })
    const chosen = createFrameInput(
      { name: 'FAQ', width: 800, height: 500, html: '<html></html>', x: 5, y: 6 },
      { pageId: 'p2', near: { x: 0, y: 0 } },
      CANVAS,
    )
    expect(chosen).toMatchObject({ pageId: 'p2', x: 5, y: 6 })
    /* a card run (no comment) keeps the store's own placement */
    expect(createFrameInput({ html: '<html></html>' }, undefined, CANVAS)).toEqual({
      name: 'Frame',
      width: 800,
      height: 500,
      html: '<html></html>',
    })
  })

  it('keeps describing element comments by their element', async () => {
    const c = (await actions.addElementComment(
      HERO.id,
      { selector: 'h1', snippet: '<h1>Hi</h1>', text: 'x' },
      'alice',
    ))!
    expect(c.elementId).toMatch(/^[a-z0-9]{6}$/)
    expect(describeCommentAnchor(c, CANVAS)).toBe(
      `on frame f1 "Hero", the element with data-doop-id="${c.elementId}"\n  element HTML at comment time: <h1>Hi</h1>`,
    )
    /* the element lost its id (an agent rewrote the frame): the snippet is what is left */
    expect(describeCommentAnchor({ ...c, elementId: undefined }, CANVAS)).toBe(
      'on frame f1 "Hero", an element that is no longer in the frame\n  element HTML at comment time: <h1>Hi</h1>',
    )
  })
})
