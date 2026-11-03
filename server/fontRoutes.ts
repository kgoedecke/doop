import express, { Router, type Request, type Response } from 'express'
import { MAX_FONT_BYTES, type FontScope } from '../shared/fonts.ts'
import { FontInputError, addFont, canUseScope, deleteFont, listFonts } from './fonts.ts'

/** /api/fonts: the font libraries Settings and Workspace manage. `?workspace=`
 *  names a workspace's library (members only); without it the library is the
 *  signed-in person's own. The /api session gate upstream means impersonating
 *  admins can look but not change anything. */
export const fontsRouter = Router()

function scopeOf(req: Request, res: Response): FontScope | null {
  const workspace = req.query.workspace
  const scope: FontScope = typeof workspace === 'string' && workspace ? { workspaceId: workspace } : { personal: true }
  if (canUseScope(scope, req.user!.id)) return scope
  res.status(403).json({ error: 'you are not a member of this workspace' })
  return null
}

fontsRouter.get('/', (req, res) => {
  const scope = scopeOf(req, res)
  if (scope) res.json(listFonts(scope, req.user!.id))
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
