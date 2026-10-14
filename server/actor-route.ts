import type express from 'express'

/** Express 4 does not forward rejected async handlers to its error middleware. */
export function actorRoute<Params = { id: string }>(
  handler: (req: express.Request<Params>, res: express.Response) => Promise<unknown>,
): express.RequestHandler<Params> {
  return (req, res, next) => {
    void handler(req, res).catch((error) => {
      console.error('[actor request]', error)
      if (!res.headersSent) res.status(503).json({ error: 'canvas service unavailable' })
      else next(error)
    })
  }
}
