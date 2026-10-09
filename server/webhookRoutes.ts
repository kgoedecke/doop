import { Router, type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import { WEBHOOK_EVENTS } from '../shared/webhooks.ts'
import {
  WebhookInputError,
  createWebhook,
  deleteWebhook,
  listWebhooks,
  rotateWebhookSecret,
  testWebhook,
  updateWebhook,
} from './webhooks.ts'

/** /api/webhooks: the settings page's CRUD over a user's outbound webhooks.
 *  The /api session gate upstream means impersonating admins can look but
 *  not change anything. */
export const webhooksRouter = Router()

const events = z.array(z.enum(WEBHOOK_EVENTS)).min(1)
const createSchema = z.object({ url: z.string().trim().min(1), events })
const patchSchema = z
  .object({ url: z.string().trim().min(1).optional(), events: events.optional(), enabled: z.boolean().optional() })
  .refine((p) => p.url !== undefined || p.events !== undefined || p.enabled !== undefined, 'nothing to change')

/** User-input problems become a 400 with the message; everything else is a 500. */
type Req = Request<{ id: string }>
function handle(fn: (req: Req, res: Response) => Promise<void>) {
  return (req: Req, res: Response, next: NextFunction) => {
    fn(req, res).catch((err: unknown) => {
      if (err instanceof WebhookInputError) res.status(400).json({ error: err.message })
      else next(err)
    })
  }
}

webhooksRouter.get('/', (req, res) => {
  res.json(listWebhooks(req.user!.id))
})

webhooksRouter.post(
  '/',
  handle(async (req, res) => {
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'a URL and at least one event are required' })
      return
    }
    const { info, secret } = await createWebhook(req.user!.id, parsed.data)
    res.json({ ...info, secret })
  }),
)

webhooksRouter.patch(
  '/:id',
  handle(async (req, res) => {
    const parsed = patchSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid webhook change' })
      return
    }
    const updated = await updateWebhook(req.user!.id, req.params.id, parsed.data)
    if (!updated) res.status(404).json({ error: 'webhook not found' })
    else res.json(updated)
  }),
)

webhooksRouter.delete(
  '/:id',
  handle(async (req, res) => {
    if (!(await deleteWebhook(req.user!.id, req.params.id))) res.status(404).json({ error: 'webhook not found' })
    else res.json({ ok: true })
  }),
)

webhooksRouter.post(
  '/:id/rotate',
  handle(async (req, res) => {
    const secret = await rotateWebhookSecret(req.user!.id, req.params.id)
    if (!secret) res.status(404).json({ error: 'webhook not found' })
    else res.json({ secret })
  }),
)

webhooksRouter.post(
  '/:id/test',
  handle(async (req, res) => {
    const result = await testWebhook(req.user!.id, req.params.id)
    if (!result) res.status(404).json({ error: 'webhook not found' })
    else res.json(result)
  }),
)
