import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types.ts'

/* The notifier sits on the canvas event bus behind the real action layer, so
   these tests post real comments and only stub what leaves the process:
   persistence, the SMTP mailer, the recipient lookup and workspace rolls. */
const mocks = vi.hoisted(() => ({
  sendMail: vi.fn(async (_mail: { to: string; subject: string; text: string }) => {}),
  mailable: vi.fn(async (ids: string[]) => ids.map((id) => ({ id, name: id, email: `${id}@example.com` }))),
  workspaceMembers: vi.fn((_id: string): string[] => []),
}))
vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
}))
vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))
vi.mock('../server/mailer.ts', () => ({ mailerConfigured: true, sendMail: mocks.sendMail }))
vi.mock('../server/notificationPrefs.ts', () => ({ mailableForComments: mocks.mailable }))
vi.mock('../server/workspaces.ts', () => ({
  workspaceMemberIds: mocks.workspaceMembers,
  isWorkspaceMember: (id: string, userId: string) => mocks.workspaceMembers(id).includes(userId),
  hasRole: () => false,
}))

const actions = await import('../server/actions.ts')
const events = await import('../server/events.ts')
const notify = await import('../server/commentNotifications.ts')
const { store } = await import('../server/store.ts')

const CANVAS: Canvas = {
  id: 'c1',
  name: 'Landing',
  ownerId: 'alice',
  memberIds: ['bob'],
  workspaceId: 'ws1',
  linkAccess: 'edit', // dave, below, comes in through the share link
  createdAt: 0,
  updatedAt: 0,
  frames: [],
}
const FRAME: Frame = {
  id: 'f1',
  canvasId: CANVAS.id,
  name: 'Hero',
  html: '<p/>',
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'alice',
}

let unsubscribe = () => {}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  mocks.workspaceMembers.mockReturnValue(['carol'])
  actions.wire(
    () => {},
    () => {},
  )
  actions.hydrateLogs({
    tasks: new Map(),
    feedback: new Map(),
    comments: new Map([[CANVAS.id, []]]),
    activity: new Map(),
    decisions: new Map(),
    proposals: new Map(),
  })
  vi.spyOn(store, 'getFrame').mockImplementation(async (id) => (id === FRAME.id ? FRAME : undefined))
  vi.spyOn(store, 'getCanvasMetadata').mockImplementation((id) => (id === CANVAS.id ? CANVAS : undefined))
  unsubscribe = events.onCanvasEvent(notify.onCanvasEvent)
})

afterEach(async () => {
  unsubscribe()
  /* drain anything a test left in the window so it cannot leak into the next */
  await vi.advanceTimersByTimeAsync(notify.COALESCE_MS)
  vi.useRealTimers()
})

async function comment(text: string, from = 'alice', userId = from) {
  return (await actions.addElementComment(FRAME.id, { selector: 'h1', snippet: '<h1/>', text }, from, userId))!
}

async function deliver() {
  await vi.advanceTimersByTimeAsync(notify.COALESCE_MS)
}

const sentTo = () => mocks.sendMail.mock.calls.map(([m]) => m.to).sort()

describe('who is told', () => {
  it('emails the invited and workspace members, never the author', async () => {
    await comment('Too small', 'alice')
    await deliver()
    expect(sentTo()).toEqual(['bob@example.com', 'carol@example.com'])
  })

  it('tells a share-link visitor about replies to their thread, and not the replier', async () => {
    const root = await comment('Can this be bigger?', 'dave')
    mocks.sendMail.mockClear()
    await deliver()
    mocks.sendMail.mockClear()
    await actions.replyToComment(root.id, 'Sure', 'alice', 'alice')
    await deliver()
    expect(sentTo()).toEqual(['bob@example.com', 'carol@example.com', 'dave@example.com'])
  })

  it("sends an agent's reply to the account that ran it", async () => {
    const root = await comment('Make it pop', 'dave')
    await deliver()
    mocks.sendMail.mockClear()
    /* MCP attributes an agent reply to the connecting user — alice here */
    await actions.replyToComment(root.id, 'Done — bumped the heading', 'Doop', 'alice', 'agent')
    await deliver()
    expect(sentTo()).toContain('alice@example.com')
    expect(sentTo()).toContain('dave@example.com')
  })

  it('sends nothing when the recipient opted out, was banned, or is gone', async () => {
    mocks.workspaceMembers.mockReturnValue([]) // bob is the only recipient left
    mocks.mailable.mockResolvedValueOnce([])
    await comment('Hello', 'alice')
    await deliver()
    expect(mocks.sendMail).not.toHaveBeenCalled()
  })

  it('sends nothing to someone who lost access inside the window', async () => {
    const root = await comment('Can this be bigger?', 'dave') // a share-link visitor
    await deliver()
    mocks.sendMail.mockClear()
    await actions.replyToComment(root.id, 'Sure', 'alice', 'alice')
    /* before the batch sends: bob is removed, carol's workspace membership
       ends, and the share link dave came in through is turned off */
    vi.spyOn(store, 'getCanvasMetadata').mockReturnValue({ ...CANVAS, memberIds: [], linkAccess: 'none' })
    mocks.workspaceMembers.mockReturnValue([])
    await deliver()
    expect(mocks.sendMail).not.toHaveBeenCalled()
  })

  it('sends nothing when the canvas was deleted inside the window', async () => {
    await comment('Hello', 'alice')
    vi.spyOn(store, 'getCanvasMetadata').mockReturnValue(undefined)
    await deliver()
    expect(mocks.sendMail).not.toHaveBeenCalled()
  })
})

describe('coalescing', () => {
  it('bundles a burst from one person into one email per recipient', async () => {
    await comment('One', 'alice')
    await comment('Two', 'alice')
    await comment('Three', 'alice')
    expect(notify.pendingBatches()).toBe(2)
    await deliver()
    expect(mocks.sendMail).toHaveBeenCalledTimes(2)
    const toBob = mocks.sendMail.mock.calls.map(([m]) => m).find((m) => m.to === 'bob@example.com')!
    expect(toBob.subject).toBe('alice left 3 comments on “Landing”')
    expect(toBob.text).toContain('“One”')
    expect(toBob.text).toContain('“Three”')
    expect(notify.pendingBatches()).toBe(0)
  })

  it('counts several authors as "new comments"', async () => {
    await comment('One', 'alice')
    await comment('Two', 'dave')
    await deliver()
    const toBob = mocks.sendMail.mock.calls.map(([m]) => m).find((m) => m.to === 'bob@example.com')!
    expect(toBob.subject).toBe('2 new comments on “Landing”')
  })

  it('waits the full window before sending', async () => {
    await comment('One', 'alice')
    await vi.advanceTimersByTimeAsync(notify.COALESCE_MS - 1000)
    expect(mocks.sendMail).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(mocks.sendMail).toHaveBeenCalled()
  })
})

describe('the email itself', () => {
  const person = { id: 'bob', name: 'Bob', email: 'bob@example.com' }

  it('names the author and frame, quotes the text, and deep-links the thread', async () => {
    const root = await comment('Too small', 'alice')
    const mail = notify.digest(person, CANVAS, [{ comment: root, frameName: FRAME.name, actorKind: 'user' }])
    expect(mail.to).toBe('bob@example.com')
    expect(mail.subject).toBe('alice commented on “Landing”')
    expect(mail.text).toContain('Hi Bob,')
    expect(mail.text).toContain('alice commented on “Hero”:')
    expect(mail.text).toContain('“Too small”')
    expect(mail.text).toContain(`/c/c1?frame=f1&comment=${root.id}`)
    expect(mail.text).toContain('/settings?pane=account')
  })

  it('links a reply to its root, since only roots have pins', async () => {
    const root = await comment('Too small', 'dave')
    const reply = (await actions.replyToComment(root.id, 'Agreed', 'alice', 'alice'))!
    const mail = notify.digest(person, CANVAS, [{ comment: reply, frameName: FRAME.name, actorKind: 'user' }])
    expect(mail.subject).toBe('alice replied on “Landing”')
    expect(mail.text).toContain('alice replied in “Hero”:')
    expect(mail.text).toContain(`&comment=${root.id}`)
    expect(mail.text).not.toContain(`&comment=${reply.id}`)
  })

  it('trims very long comments', async () => {
    const root = await comment('x'.repeat(2000), 'alice')
    const mail = notify.digest(person, CANVAS, [{ comment: root, frameName: FRAME.name, actorKind: 'user' }])
    expect(mail.text).toContain('x'.repeat(597) + '…')
    expect(mail.text).not.toContain('x'.repeat(598))
  })
})

describe('recipientsFor', () => {
  it('is empty when nobody but the author is attached to the canvas', async () => {
    mocks.workspaceMembers.mockReturnValue([])
    const lonely: Canvas = { ...CANVAS, memberIds: [], workspaceId: undefined }
    const root = await comment('Note to self', 'alice')
    expect(notify.recipientsFor(lonely, root, 'user')).toEqual([])
  })
})
