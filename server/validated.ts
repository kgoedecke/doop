import type express from 'express'
import type { z } from 'zod'

/* A REST body checked at the route, before anything reads it: a body that does not match its
   schema is answered 400 naming the field, and the route gets the parsed body, typed by the
   schema, instead of `req.body`, which Express types `any`. New routes take their body this way:

     const body = validated(res, frameCreateSchema, req.body)
     if (!body) return
*/

/** `body` parsed by `schema`, or `undefined` once `res` has been answered 400 with the first
 *  field that failed and why (`width: must be a finite number`; `body` when the body itself is
 *  the problem). A missing body is parsed as `{}`, so a schema of optional fields takes an
 *  empty request. */
export function validated<Schema extends z.ZodTypeAny>(
  res: express.Response,
  schema: Schema,
  body: unknown,
): z.infer<Schema> | undefined {
  const parsed = schema.safeParse(body ?? {})
  if (parsed.success) return parsed.data
  const issue = parsed.error.issues[0]
  res.status(400).json({ error: `${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}` })
  return undefined
}
