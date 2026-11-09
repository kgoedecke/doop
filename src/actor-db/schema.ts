import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type { FrameApproval } from '../actor.js'

/* A canvas actor's own SQLite: the canvas's frames, as the Postgres frames
   table holds them on main. After editing, run `bun run actors:migrations`;
   the actor applies pending migrations when it wakes. */

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
  approval: text({ mode: 'json' }).$type<FrameApproval>(),
})
