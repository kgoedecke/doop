import { defineConfig } from 'drizzle-kit'

/** Migration generation for the canvas actor's SQLite: `bun run actors:migrations`
 *  after editing src/actor-db/schema.ts. The actor applies them itself when it
 *  wakes (`migrate` in src/actor.ts), never drizzle-kit. */
export default defineConfig({
  dialect: 'sqlite',
  driver: 'durable-sqlite',
  schema: './src/actor-db/schema.ts',
  out: './src/actor-db/migrations',
})
