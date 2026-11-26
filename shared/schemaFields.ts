import { z } from 'zod'

/* zod fields the server's schemas share: the REST bodies (server/frameSchemas.ts) and the
   room's messages (shared/roomSchemas.ts). */

/** A number a position, size or angle can be: not a string, not NaN, not infinity. Its message
 *  is the one a 400 names the field with (`width: must be a finite number`). */
export const finite = z.number({ invalid_type_error: 'must be a finite number' }).finite('must be a finite number')
