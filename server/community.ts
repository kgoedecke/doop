import express from 'express'
import { store } from './store.ts'
import { getUserName } from './auth.ts'
import { isCommunityCategory, type Canvas, type CommunityItem } from '../shared/types.ts'

/**
 * The community gallery, mounted at /api/community (behind the session gate
 * in index.ts). Owners opt a canvas in from the share modal; everyone
 * signed in can browse the listings and copy one into their own account.
 *
 * Deliberately NOT a change to canAccessCanvas: a published canvas is still
 * private to its collaborators. The gallery hands out frame ids (which the
 * public /i/ image pipeline already renders for anyone holding one) and
 * fresh copies — never the source canvas, its HTML, or a seat in its room.
 */
export const communityRouter = express.Router()

const MAX_DESCRIPTION = 280

/** What a canvas must have to be worth listing: at least one frame the
 *  owner (or their agents) actually made, not just the welcome tour. */
export function publishableFrames(canvas: Canvas) {
  return canvas.frames.filter((frame) => !frame.demo)
}

export function parseListing(body: unknown): { description: string; category: CommunityItem['category'] } | string {
  const { description, category } = (body ?? {}) as { description?: unknown; category?: unknown }
  if (!isCommunityCategory(category)) return 'category must be one of the gallery shelves'
  if (description !== undefined && typeof description !== 'string') return 'description must be text'
  const clean = (description ?? '').trim()
  if (clean.length > MAX_DESCRIPTION) return `description must be ${MAX_DESCRIPTION} characters or fewer`
  return { description: clean, category }
}

async function toItem(canvas: Canvas): Promise<CommunityItem> {
  /* every real frame, oldest first — the preview modal promises the whole
     design, and ids plus sizes are cheap enough to ship for all of them */
  const frames = publishableFrames(canvas)
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt)
  return {
    id: canvas.id,
    name: canvas.name,
    ...(canvas.description ? { description: canvas.description } : {}),
    category: canvas.category ?? 'other',
    authorName: (canvas.ownerId && (await getUserName(canvas.ownerId))) || 'Unknown',
    publishedAt: canvas.publishedAt ?? canvas.createdAt,
    updatedAt: canvas.updatedAt,
    copyCount: canvas.copyCount ?? 0,
    frames: frames.map((frame) => ({ id: frame.id, name: frame.name, width: frame.width, height: frame.height })),
  }
}

/** Every listing, newest first. Sorting by trend is the client's choice —
 *  the whole gallery is small enough to ship at once. */
communityRouter.get('/', async (_req, res) => {
  const canvases = await Promise.all(store.listPublished().map((c) => store.syncCanvas(c.id)))
  const items = await Promise.all(canvases.filter((c): c is Canvas => !!c && !!publishableFrames(c).length).map(toItem))
  res.json(items)
})

/** Copy a listing into the caller's account. The copy keeps the listing's
 *  name and drops the welcome tour; the source stays untouched apart from
 *  its copy count. */
communityRouter.post('/:id/copy', async (req, res) => {
  const source = store.getCanvasMetadata(req.params.id)
  if (!source || source.publishedAt === undefined) return res.status(404).json({ error: 'not in the gallery' })
  try {
    const copy = await store.duplicateCanvas(source.id, req.user!.id, req.user!.name, {
      name: source.name,
      dropDemo: true,
    })
    if (!copy) return res.status(404).json({ error: 'not in the gallery' })
    store.recordCommunityCopy(source.id)
    res.json(copy)
  } catch (error) {
    console.error('[community] copy failed', error)
    res.status(500).json({ error: 'could not copy this design' })
  }
})
