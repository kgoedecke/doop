import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type { Actor, FrameApproval } from '../../shared/types.js'

/* A canvas actor's own SQLite: its frames and their design history. Pages,
   activity and open bursts are small and live in @Persisted fields instead.
   After editing, run `bun run actors:migrations`; the actor applies pending
   migrations when it wakes. */

export const frames = sqliteTable('frames', {
  id: text().primaryKey(),
  canvasId: text().notNull(),
  pageId: text().notNull(),
  /** canvas order: frames are listed, and drawn, by this */
  position: integer().notNull(),
  name: text().notNull(),
  x: real().notNull(),
  y: real().notNull(),
  width: real().notNull(),
  height: real().notNull(),
  createdAt: integer().notNull(),
  updatedAt: integer().notNull(),
  updatedBy: text().notNull(),
  demo: integer({ mode: 'boolean' }),
  hidden: integer({ mode: 'boolean' }),
  locked: integer({ mode: 'boolean' }),
  approval: text({ mode: 'json' }).$type<FrameApproval>(),
  html: text().notNull(),
})

/** The state each burst of edits started from, newest MAX_FRAME_VERSIONS per frame. */
export const versions = sqliteTable(
  'versions',
  {
    id: text().primaryKey(),
    frameId: text().notNull(),
    html: text().notNull(),
    width: real().notNull(),
    height: real().notNull(),
    savedAt: integer().notNull(),
    savedBy: text().notNull(),
    savedByKind: text().$type<Actor['kind']>(),
  },
  (t) => [index('versions_by_frame').on(t.frameId, t.savedAt)],
)
