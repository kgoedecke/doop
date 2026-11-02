import type { Canvas, ElementComment, Frame } from '../../shared/types'
import { canvasPages, framePageId } from '../../shared/pages'
import { isCanvasComment } from '../../shared/comments'
import { useStore } from './store'

/** One comment thread: its root pin plus the replies under it. */
export interface CommentThreadGroup {
  root: ElementComment
  /** oldest → newest */
  replies: ElementComment[]
  /** the frame the thread is pinned to; absent when it is pinned to the canvas */
  frame?: Frame
  /** when the thread last moved: the newest reply, or the root itself */
  lastAt: number
}

export type ThreadState = 'open' | 'resolved'

export function threadState(thread: Pick<CommentThreadGroup, 'root'>): ThreadState {
  return thread.root.resolvedAt ? 'resolved' : 'open'
}

/** The threads on one page — pinned to its frames or to the canvas itself —
 *  newest activity first. Replies whose root is not in `comments` (the store
 *  keeps a bounded window) are dropped rather than shown as headless threads. */
export function pageThreads(
  comments: ElementComment[],
  canvas: Pick<Canvas, 'id' | 'pages' | 'frames'> | null,
  pageId: string | null,
): CommentThreadGroup[] {
  if (!canvas) return []
  const page = pageId ?? canvasPages(canvas)[0]!.id
  const frames = new Map(canvas.frames.filter((f) => framePageId(canvas, f) === page).map((f) => [f.id, f]))
  const replies = new Map<string, ElementComment[]>()
  for (const c of comments) {
    if (!c.parentId) continue
    const list = replies.get(c.parentId) ?? []
    list.push(c)
    replies.set(c.parentId, list)
  }
  const threads: CommentThreadGroup[] = []
  for (const root of comments) {
    if (root.parentId) continue
    let frame: Frame | undefined
    if (isCanvasComment(root)) {
      if (root.pageId !== page) continue
    } else {
      frame = root.frameId ? frames.get(root.frameId) : undefined
      if (!frame) continue
    }
    const own = (replies.get(root.id) ?? []).sort((a, b) => a.at - b.at)
    const lastAt = own.length ? own[own.length - 1]!.at : root.at
    threads.push({ root, replies: own, ...(frame ? { frame } : {}), lastAt })
  }
  return threads.sort((a, b) => b.lastAt - a.lastAt)
}

/** How many threads on the page are still open — the rail badge. */
export function openThreadCount(
  comments: ElementComment[],
  canvas: Pick<Canvas, 'id' | 'pages' | 'frames'> | null,
  pageId: string | null,
): number {
  return pageThreads(comments, canvas, pageId).filter((t) => threadState(t) === 'open').length
}

/** Open threads on the page in view — the rail and tab badges. */
export function useOpenThreadCount(): number {
  return useStore((s) => openThreadCount(s.comments, s.canvas, s.activePageId))
}
