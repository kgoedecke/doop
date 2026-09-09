/**
 * Background library importer — bulk-loads a folder of images into the
 * backgrounds table (the search_backgrounds catalog) and object storage.
 *
 * Runs against the database this process is configured for: DATABASE_URL,
 * or the local PGlite under ./data when unset. Per image it does what an
 * admin upload does (server/backgrounds.ts createBackground): skip locked
 * preview tiles, re-encode a display WebP and a thumbnail, describe with
 * Claude vision, upload, insert. Images already in the table (by content
 * hash) are skipped, so a crashed run resumes where it stopped.
 *
 * --tags <file.json> skips the model: a map of source sha1 → the tag
 * fields, for hand-curated libraries (files missing from the map are
 * skipped). Without a tags file and without ANTHROPIC_API_KEY, rows are
 * created disabled with blank tags for someone to fill in later.
 *
 * Usage: bun x tsx --env-file-if-exists=.env scripts/import-backgrounds.ts <folder> [--limit N] [--tags tags.json]
 */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { initDb } from '../server/db/index.ts'
import * as backgrounds from '../server/backgrounds.ts'
import type { BackgroundTags } from '../server/backgrounds.ts'

const CONCURRENCY = 4

interface Options {
  folder: string
  limit: number
  tags?: Record<string, BackgroundTags>
}

function parseArgs(argv: string[]): Options {
  const valueFlags = new Set(['--limit', '--tags'])
  const folder = argv.find((a, i) => !a.startsWith('--') && !valueFlags.has(argv[i - 1] ?? ''))
  if (!folder) {
    console.error('usage: import-backgrounds.ts <folder> [--limit N] [--tags tags.json]')
    process.exit(1)
  }
  const limitArg = argv.indexOf('--limit')
  const tagsArg = argv.indexOf('--tags')
  return {
    folder,
    limit: limitArg === -1 ? Infinity : Number(argv[limitArg + 1]),
    tags:
      tagsArg === -1
        ? undefined
        : (JSON.parse(readFileSync(argv[tagsArg + 1], 'utf8')) as Record<string, BackgroundTags>),
  }
}

async function importOne(file: string, opts: Options): Promise<void> {
  const bytes = readFileSync(file)
  const sha = createHash('sha1').update(bytes).digest('hex')
  const tags = opts.tags?.[sha]
  if (opts.tags && !tags) {
    console.log(`skip  ${path.basename(file)} (not in the tags file)`)
    return
  }
  const outcome = await backgrounds.createBackground(bytes, { tags: tags && backgrounds.normalizeTags(tags) })
  if (outcome.status === 'duplicate') {
    console.log(`skip  ${path.basename(file)} (already imported as ${outcome.entry.id})`)
    return
  }
  const { entry, tagged, error } = outcome
  const how = tagged === 'none' ? `untagged, disabled${error ? ` — ${error}` : ''}` : entry.description
  console.log(`added ${path.basename(file)} → ${entry.id} · ${entry.tone} ${entry.style} · ${how}`)
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  await initDb()
  await backgrounds.initBackgrounds()
  const known = new Set(backgrounds.listBackgrounds().map((e) => e.source))

  const files = readdirSync(opts.folder)
    .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
    .sort()
    .map((f) => path.join(opts.folder, f))
    .filter((f) => !known.has(createHash('sha1').update(readFileSync(f)).digest('hex')))
    .slice(0, opts.limit)

  console.log(`${known.size} in the library, ${files.length} new file(s) to import`)

  let next = 0
  let failed = 0
  const worker = async () => {
    while (next < files.length) {
      const file = files[next++]
      try {
        await importOne(file, opts)
      } catch (e) {
        failed++
        console.error(`fail  ${path.basename(file)}: ${e instanceof Error ? e.message : e}`)
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  console.log(`done: ${backgrounds.listBackgrounds().length} in the library, ${failed} failed`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
