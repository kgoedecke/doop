import type { DrizzleMigrations } from 'terse-sdk/drizzle'

/** drizzle-kit writes migrations.js (the durable-sqlite driver's bundle); this types it for src/actor.ts. */
declare const migrations: DrizzleMigrations
export default migrations
