import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import * as schema from '../../server/db/schema.ts'

/** Unit suites that stub collaboration persistence still need real frame membership. */
const client = new PGlite()
await client.exec(await readFile('server/db/migrations/0023_frame_membership.sql', 'utf8'))
export const db = drizzle(client, { schema })
export const close = () => client.close()
