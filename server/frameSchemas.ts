import { z } from 'zod'
import { finite } from '../shared/schemaFields.ts'

/* The bodies of POST /api/canvases/:id/frames and PATCH /api/frames/:id, parsed by `validated`
   (server/validated.ts) before the route writes anything: a field of the wrong type is a 400
   naming it, never a frame whose width is a string. Every field is optional, as before.

   `hidden` and `locked` are taken as sent and coerced by the routes as before: only a literal
   `true` hides a frame (tests/frameHidden.test.ts pins `hidden: 'yes'` as shown). */

/** What a frame is made or edited with. */
const fields = {
  name: z.string(),
  pageId: z.string(),
  x: finite,
  y: finite,
  width: finite,
  height: finite,
  html: z.string(),
  /** the stacking order the Layers panel sets */
  z: finite,
}
const coerced = { hidden: z.unknown(), locked: z.unknown() }

/** A field a new frame may leave out, or send as null (a NaN arrives as null): the store
 *  gives it its default, as it always has. */
const orDefault = <Field extends z.ZodTypeAny>(field: Field) => field.nullish().transform((value) => value ?? undefined)

/** A new frame: `hidden`, `locked` and `z` let undo bring a deleted frame back as it was. A
 *  null `pageId` is still a 400, as it was. */
export const frameCreateSchema = z.object({
  name: orDefault(fields.name),
  pageId: fields.pageId.optional(),
  x: orDefault(fields.x),
  y: orDefault(fields.y),
  width: orDefault(fields.width),
  height: orDefault(fields.height),
  html: orDefault(fields.html),
  z: orDefault(fields.z),
  rotation: orDefault(finite),
  ...coerced,
})

/** An edit of a frame: only the fields it sends change, and null is no value for any of them
 *  but `rotation`, where it straightens. The rest of the body is kept as sent: `expectedUpdatedAt`
 *  and `requestId` are the route's, and an edit handed to the canvas's actor is checked there
 *  for fields it does not take (server/actorBrowserEdits.ts). */
export const framePatchSchema = z
  .object({ ...fields, rotation: finite.nullable() })
  .partial()
  .extend(coerced)
  .passthrough()
