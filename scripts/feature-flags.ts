/**
 * Per-user feature flags (server/featureFlags.ts), by account email.
 *
 * Runs against the database this process is configured for: DATABASE_URL, or
 * the local PGlite under ./data when unset (stop `bun run dev` first: PGlite
 * takes one process at a time). A running server picks changes up within 30
 * seconds.
 *
 *   bun run flags list      [flag]
 *   bun run flags enable    <flag> <email>...
 *   bun run flags disable   <flag> <email>...
 *   bun run flags move-back <email>...
 *
 * canvas-actors: canvases these people make from now on (new ones and their
 * copies of any canvas) keep their frames and design history in a Terse
 * canvas actor; it needs TERSE_ACTOR_URL and TERSE_API_KEY on the server.
 * Canvases they already had stay in Postgres. Turning the flag off is the way
 * back: each canvas on an actor returns to Postgres the next time it is
 * opened.
 *
 * move-back turns canvas-actors off for these people and moves every canvas
 * they still have on an actor back at once, as the actor holds it now (it
 * needs the Terse variables too). Run it with the server stopped, or restart
 * the server afterwards: a running one still writes those canvases to their
 * actors.
 */

import { actorCanvasesOf, moveCanvasToPostgres } from '../server/canvasMoves.ts'
import { initDb } from '../server/db/index.ts'
import {
  CANVAS_ACTORS,
  FEATURE_FLAGS,
  featureFlags,
  isFeatureFlag,
  usersByEmail,
  type FeatureFlag,
} from '../server/featureFlags.ts'

/* the database pool would keep the process alive */
await main(process.argv.slice(2))
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => process.exit())

async function main([command, flag, ...emails]: string[]) {
  if (command === 'list') {
    await initDb()
    for (const name of flag ? [parseFlag(flag)] : FEATURE_FLAGS) {
      const holders = await featureFlags.list(name)
      console.log(`${name}: ${holders.length ? holders.join(', ') : 'nobody'}`)
    }
    return
  }
  if (command === 'move-back') return moveBack([flag, ...emails].filter((email): email is string => !!email))
  if ((command !== 'enable' && command !== 'disable') || !flag || !emails.length) return usage()
  const name = parseFlag(flag)
  await initDb()
  const found =
    command === 'enable' ? await featureFlags.enable(name, emails) : await featureFlags.disable(name, emails)
  const missing = emails.filter((email) => !found.includes(email.trim().toLowerCase()))
  console.log(`${command}d ${name} for ${found.length ? found.join(', ') : 'nobody'}`)
  if (missing.length) {
    console.error(`no account for ${missing.join(', ')}`)
    process.exitCode = 1
  }
}

async function moveBack(emails: string[]) {
  if (!emails.length) return usage()
  await initDb()
  /* first, so no canvas of theirs moves to an actor again */
  await featureFlags.disable(CANVAS_ACTORS, emails)
  const users = await usersByEmail(emails)
  for (const canvas of await actorCanvasesOf(users.map((user) => user.id))) {
    const moved = await moveCanvasToPostgres(canvas.id)
    console.log(`moved ${canvas.name} (${canvas.id}): ${moved.frames} frames, ${moved.versions} versions`)
  }
  console.log('Restart the server if it was running: it still writes these canvases to their actors.')
}

function parseFlag(flag: string): FeatureFlag {
  if (isFeatureFlag(flag)) return flag
  console.error(`unknown flag "${flag}"; known: ${FEATURE_FLAGS.join(', ')}`)
  process.exit(1)
}

function usage() {
  console.error(
    'usage: bun run flags list [flag] | enable <flag> <email>... | disable <flag> <email>... | move-back <email>...',
  )
  process.exitCode = 1
}
