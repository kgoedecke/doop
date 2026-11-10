import express, { Router, type Request, type Response } from 'express'
import { MAX_FONT_BYTES, type FontScope } from '../shared/fonts.ts'
import { FontInputError, addFont, canUseScope, deleteFont, listFonts } from './fonts.ts'
import { auth } from './auth.ts'
import { assertCanvasRead, PrivateResourceError } from './privateResources.ts'

/** /api/fonts?canvas=<id>: the selected canvas's private font library.
 *  Normal browser session authentication is applied upstream. */
export const fontsRouter = Router()

function scopeOf(req: Request, res: Response): FontScope | null {
  const canvasId = req.query.canvas
  if (typeof canvasId !== 'string' || !canvasId) {
    res.status(400).json({ error: 'choose a canvas for the font library' })
    return null
  }
  const scope: FontScope = { canvasId }
  if (canUseScope(scope, req.user!.id)) return scope
  res.status(404).json({ error: 'canvas is not available' })
  return null
}

fontsRouter.get('/', async (req, res) => {
  res.set('Cache-Control', 'private, no-store').vary('Cookie')
  const scope = scopeOf(req, res)
  if (!scope) return
  try {
    const cookie = req.headers.cookie ?? ''
    const reader = {
      actorId: req.user!.id,
      currentActor: async () => (await auth.api.getSession({ headers: new Headers({ cookie }) }))?.user.id,
    }
    await assertCanvasRead({ reader, canvasId: scope.canvasId })
    return res.json(listFonts(scope, reader.actorId))
  } catch (error) {
    return res.status(error instanceof PrivateResourceError ? 404 : 503).json({ error: 'font library is unavailable' })
  }
})

/* raw font bytes in; the file name rides a header since the body is the file */
fontsRouter.post('/', express.raw({ type: () => true, limit: MAX_FONT_BYTES + 1024 }), async (req, res) => {
  const scope = scopeOf(req, res)
  if (!scope) return
  const header = req.get('x-file-name')
  let fileName = ''
  try {
    fileName = header ? decodeURIComponent(header) : ''
  } catch {
    /* a malformed name is only cosmetic */
  }
  try {
    const font = await addFont(scope, req.user!, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), fileName)
    res.json(font)
  } catch (e) {
    if (e instanceof FontInputError) res.status(400).json({ error: e.message })
    else {
      console.error('[fonts] upload failed', e)
      res.status(500).json({ error: 'the font could not be saved — try again' })
    }
  }
})

fontsRouter.delete('/:id', async (req, res) => {
  try {
    if (await deleteFont(req.params.id, req.user!.id)) res.json({ ok: true })
    else res.status(404).json({ error: 'font not found' })
  } catch (e) {
    console.error('[fonts] delete failed', e)
    res.status(500).json({ error: 'the font could not be removed — try again' })
  }
})
