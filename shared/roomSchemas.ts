import { z } from 'zod'
import { finite } from './schemaFields.ts'
import type { ClientMessage, PeerViewport } from './types.ts'
import { isPeerViewport } from './viewport.ts'

/* The room's client messages as the server checks them on arrival (server/index.ts): a message
   that does not parse is dropped, never acted on or relayed to the canvas's other visitors, who
   render what they are sent (a cursor's x goes straight into a style).

   `ClientMessage` in shared/types.ts stays the documented type; the assertion at the bottom
   fails to compile when it and these schemas disagree, so a new message or field needs both.

   The browser does not import this module: zod stays out of its bundle. It checks the
   viewports it receives with `isPeerViewport`, the same predicate the schema below uses. */

/** An id the room keys presence by or relays to every peer: a client's, a frame's, a page's.
 *  Bound so no visitor can hand every peer a megabyte key; real ids are 12 to 40 characters. */
const id = z.string().min(1).max(200)

/* A join is checked lightly: one dropped leaves the visitor waiting for an `init` that never
   comes. Only `clientId` is bound, as it becomes the visitor's presence key; the canvas, page
   and frame are looked up (an unknown canvas is closed 4404, an unknown page or frame opens the
   default page), and they come from the URL, so they are any string, as before. */
const join = z.object({
  type: z.literal('join'),
  canvasId: z.string(),
  clientId: id,
  /* neither is read: the server names a visitor from their session */
  name: z.string(),
  kind: z.enum(['user', 'agent']),
  pagesOnDemand: z.boolean().optional(),
  composesFrames: z.boolean().optional(),
  pageId: z.string().optional(),
  frameId: z.string().optional(),
})

/** a camera followers can apply: finite, with a positive zoom and stage (shared/viewport.ts) */
export const peerViewportSchema = z.custom<PeerViewport>(isPeerViewport, 'not a usable viewport')

export const clientMessageSchema = z.discriminatedUnion('type', [
  join,
  z.object({ type: z.literal('page:load'), pageId: id }),
  /* a list of any length: the server keeps the known pages and caps them (shownPages) */
  z.object({ type: z.literal('pages:shown'), pageIds: z.array(z.string()) }),
  z.object({ type: z.literal('cursor'), x: finite, y: finite }),
  z.object({ type: z.literal('viewport'), viewport: peerViewportSchema }),
  z.object({ type: z.literal('editing'), frameId: id.nullable() }),
  z.object({
    type: z.literal('frame:drag'),
    frameId: id,
    x: finite,
    y: finite,
    width: finite,
    height: finite,
    rotation: finite.optional(),
  }),
])

/* the schemas and the documented union are the same type: identical, not just assignable both
   ways, so an optional field added to one side alone fails too */
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
const schemasMatchTheUnion: Same<z.infer<typeof clientMessageSchema>, ClientMessage> = true
void schemasMatchTheUnion
