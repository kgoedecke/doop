/**
 * Backfill embeddings script — generates and saves Voyage multimodal embeddings
 * for background library images that do not yet have an embedding vector.
 *
 * Runs against the configured database: DATABASE_URL, or PGlite under ./data/pg.
 *
 * Usage: bun x tsx --env-file-if-exists=.env scripts/backfill-embeddings.ts [--limit N] [--force]
 */

import { initDb } from '../server/db/index.ts'
import * as backgrounds from '../server/backgrounds.ts'
import * as storage from '../server/storage.ts'
import * as voyage from '../server/voyage.ts'

interface Options {
  limit: number
  force: boolean
}

function parseArgs(argv: string[]): Options {
  const limitArg = argv.indexOf('--limit')
  const limit = limitArg === -1 ? Infinity : Number(argv[limitArg + 1])
  if (Number.isNaN(limit) || limit < 0) {
    throw new Error('--limit must be a non-negative number')
  }
  return {
    limit,
    force: argv.includes('--force'),
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))

  if (!voyage.embeddingEnabled()) {
    console.error('error: VOYAGE_API_KEY is not set in environment')
    process.exit(1)
  }

  await initDb()
  await backgrounds.initBackgrounds()

  const all = backgrounds.listBackgrounds()
  const pending = all.filter((e) => opts.force || !e.embedding).slice(0, opts.limit)

  console.log(`library contains ${all.length} image(s); ${pending.length} selected for embedding backfill`)

  let success = 0
  let failed = 0

  for (let i = 0; i < pending.length; i++) {
    const entry = pending[i]!
    const num = i + 1
    const prefix = `[${num}/${pending.length}] ${entry.id}`

    try {
      const bytes = await storage.getObject(backgrounds.displayKey(entry.id))
      if (!bytes) {
        console.warn(`${prefix}: skipped (image bytes missing from storage)`)
        failed++
        continue
      }

      const vector = await voyage.embedImage(bytes)
      if (!vector) {
        console.warn(`${prefix}: embedding API returned null`)
        failed++
        continue
      }

      const updated = await backgrounds.updateBackground(entry.id, { embedding: vector })
      if (updated?.embedding) {
        console.log(`${prefix}: embedded (${vector.length} dims)`)
        success++
      } else {
        console.warn(`${prefix}: update failed`)
        failed++
      }
    } catch (e) {
      failed++
      console.error(`${prefix}: error — ${e instanceof Error ? e.message : e}`)
    }
  }

  console.log(`done: ${success} embedded successfully, ${failed} failed`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
