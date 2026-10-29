import { describe, expect, it } from 'vitest'
import { openThreadCount, pageThreads, threadState } from '../src/lib/comments'
import { isComposingEnter } from '../src/lib/keys'
import type { Canvas, ElementComment } from '../shared/types'

/**
 * The Comments panel lists the threads on the page in view — pinned to its
 * frames or to the canvas itself: replies fold under their root, resolved
 * roots read as resolved, and the rail badge counts only the open ones.
 */

const frame = (id: string, pageId?: string) => ({
  id,
  canvasId: 'c',
  name: id,
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  html: '',
  ...(pageId ? { pageId } : {}),
})
const canvas = {
  id: 'c',
  name: 'c',
  pages: [
    { id: 'p1', name: 'Page 1' },
    { id: 'p2', name: 'Page 2' },
  ],
  frames: [frame('legacy'), frame('hero', 'p1'), frame('pricing', 'p2')],
} as unknown as Canvas

function comment(id: string, frameId: string, at: number, extra: Partial<ElementComment> = {}): ElementComment {
  return { id, canvasId: 'c', frameId, elementId: 'h1h1h1', snippet: '', from: 'Ada', text: id, at, ...extra }
}

/* a comment pinned to a point on the canvas: a page and world coordinates, no frame */
function canvasComment(id: string, pageId: string, at: number, extra: Partial<ElementComment> = {}): ElementComment {
  return { id, canvasId: 'c', pageId, x: 10, y: 20, snippet: '', from: 'Ada', text: id, at, ...extra }
}

/* the store keeps comments newest first */
const comments: ElementComment[] = [
  comment('reply-late', 'hero', 50, { parentId: 'root-a' }),
  comment('root-c', 'pricing', 40),
  comment('root-b', 'legacy', 30, { resolvedAt: 35, resolvedBy: 'Bob' }),
  comment('reply-early', 'hero', 20, { parentId: 'root-a' }),
  comment('orphan', 'hero', 15, { parentId: 'gone' }),
  comment('root-a', 'hero', 10),
]

describe('pageThreads', () => {
  it('groups replies under their root, oldest first, and drops orphans', () => {
    const threads = pageThreads(comments, canvas, 'p1')
    const a = threads.find((t) => t.root.id === 'root-a')
    expect(a?.replies.map((r) => r.id)).toEqual(['reply-early', 'reply-late'])
    expect(a?.frame?.name).toBe('hero')
    expect(threads.some((t) => t.root.id === 'orphan')).toBe(false)
  })

  it('keeps to the page in view, counting frames without a pageId as the first page', () => {
    expect(pageThreads(comments, canvas, 'p1').map((t) => t.root.id)).toEqual(['root-a', 'root-b'])
    expect(pageThreads(comments, canvas, 'p2').map((t) => t.root.id)).toEqual(['root-c'])
    expect(pageThreads(comments, canvas, null).map((t) => t.root.id)).toEqual(['root-a', 'root-b'])
    expect(pageThreads(comments, null, 'p1')).toEqual([])
  })

  it('orders threads by their latest activity and reads resolution off the root', () => {
    const [first, second] = pageThreads(comments, canvas, 'p1')
    expect(first?.lastAt).toBe(50)
    expect(second?.lastAt).toBe(30)
    expect(threadState(first!)).toBe('open')
    expect(threadState(second!)).toBe('resolved')
  })
})

describe('isComposingEnter', () => {
  /* the panel's reply field sends on Enter, except the Enter that confirms
     an IME composition — that one is still choosing characters */
  it('lets a plain Enter send and holds a composition Enter back', () => {
    expect(isComposingEnter({ key: 'Enter', keyCode: 13, nativeEvent: { isComposing: false } })).toBe(false)
    expect(isComposingEnter({ key: 'Enter', keyCode: 13, nativeEvent: { isComposing: true } })).toBe(true)
    /* Safari: composition already ended, only the keyCode gives it away */
    expect(isComposingEnter({ key: 'Enter', keyCode: 229, nativeEvent: { isComposing: false } })).toBe(true)
    expect(isComposingEnter({ key: 'a', keyCode: 229, nativeEvent: { isComposing: true } })).toBe(false)
  })
})

describe('openThreadCount', () => {
  it('counts only unresolved roots on the page', () => {
    expect(openThreadCount(comments, canvas, 'p1')).toBe(1)
    expect(openThreadCount(comments, canvas, 'p2')).toBe(1)
    expect(openThreadCount([], canvas, 'p1')).toBe(0)
  })
})

describe('comments pinned to the canvas', () => {
  const mixed: ElementComment[] = [
    canvasComment('pin-reply', 'p2', 70, { parentId: 'pin-b' }),
    canvasComment('pin-b', 'p2', 60),
    canvasComment('pin-a', 'p1', 45),
    ...comments,
  ]

  it('lists them on their page without a frame, replies folded under the root', () => {
    const p1 = pageThreads(mixed, canvas, 'p1')
    expect(p1.map((t) => t.root.id)).toEqual(['root-a', 'pin-a', 'root-b'])
    expect(p1.find((t) => t.root.id === 'pin-a')?.frame).toBeUndefined()
    const p2 = pageThreads(mixed, canvas, 'p2')
    expect(p2.map((t) => t.root.id)).toEqual(['pin-b', 'root-c'])
    expect(p2[0]?.replies.map((r) => r.id)).toEqual(['pin-reply'])
    expect(p2[0]?.lastAt).toBe(70)
  })

  it('counts them in the open badge', () => {
    expect(openThreadCount(mixed, canvas, 'p1')).toBe(2)
    expect(openThreadCount(mixed, canvas, 'p2')).toBe(2)
    expect(openThreadCount([canvasComment('done', 'p1', 1, { resolvedAt: 2 })], canvas, 'p1')).toBe(0)
  })
})
