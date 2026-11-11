import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type { FrameApproval } from '../actor.js'

/* A canvas actor's own SQLite: the canvas's frames and their design history,
   as the Postgres frames and frame_versions tables hold them on main. After
   editing, run `bun run actors:migrations`; the actor applies pending
   migrations when it wakes. */

export const frames = sqliteTable('frames', {
  id: text().primaryKey(),
  canvasId: text().notNull(),
  pageId: text(),
  name: text().notNull(),
  x: real().notNull(),
  y: real().notNull(),
  width: real().notNull(),
  height: real().notNull(),
  html: text().notNull(),
  createdAt: integer().notNull(),
  updatedAt: integer().notNull(),
  updatedBy: text().notNull(),
  demo: integer({ mode: 'boolean' }),
  hidden: integer({ mode: 'boolean' }),
  locked: integer({ mode: 'boolean' }),
  /** stacking order on its page (shared/frameStack.ts); unset stacks by createdAt */
  z: real(),
  /** degrees clockwise about the centre (shared/frameRotation.ts); unset is 0 */
  rotation: real(),
  approval: text({ mode: 'json' }).$type<FrameApproval>(),
})

/** Design history: the HTML (and size) a frame had before a burst of edits replaced it. */
export const frameVersions = sqliteTable(
  'frame_versions',
  {
    id: text().primaryKey(),
    frameId: text().notNull(),
    html: text().notNull(),
    width: real().notNull(),
    height: real().notNull(),
    savedAt: integer().notNull(),
    savedBy: text().notNull(),
    savedByKind: text(),
  },
  (table) => [index('frame_versions_frame_idx').on(table.frameId, table.savedAt)],
)
