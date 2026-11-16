import { createHash } from 'node:crypto'
import { renderRegistryComponent } from './registryRenderer.ts'
import { prepareRegistryImport } from './shadcnRegistry.ts'
import type { RegistryTheme } from './registryTheme.ts'

/**
 * Pictures of registry items for the component library: each item rendered
 * the way an import would render it (themed by the canvas when asked) and
 * kept, so a registry browsed twice, or by two people, renders once.
 */

const MAX_CACHED = 400
const CACHE_MS = 24 * 60 * 60 * 1000
/* a failure is remembered briefly, so a broken item is not re-rendered on every scroll */
const FAILURE_MS = 10 * 60 * 1000
/* renders run a Chromium page each; the rest wait their turn */
const MAX_RUNNING = 3
const MAX_WAITING = 60

export class ThumbnailBusyError extends Error {}

interface Entry {
  at: number
  ttl: number
  image: Promise<Buffer>
}

const cache = new Map<string, Entry>()
let running = 0
const waiting: (() => void)[] = []

async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= MAX_RUNNING) {
    if (waiting.length >= MAX_WAITING) throw new ThumbnailBusyError('Too many previews rendering; try again shortly')
    await new Promise<void>((resolve) => waiting.push(resolve))
  }
  running++
  try {
    return await work()
  } finally {
    running--
    waiting.shift()?.()
  }
}

/** Where an item's `-demo` example would be: beside it in the same index, or
 *  at the sibling URL when the item was read on its own (`…/r/marquee.json`). */
function demoOf(source: string, name: string): { source: string; name: string }[] {
  if (name.endsWith('-demo')) return []
  const demo = `${name}-demo`
  const url = new URL(source)
  const own = new RegExp(`/${name.replace(/[.]/g, '\\.')}(\\.json)?$`)
  if (!own.test(url.pathname)) return [{ source, name: demo }]
  url.pathname = url.pathname.replace(own, (_match, json: string | undefined) => `/${demo}${json ?? ''}`)
  return [{ source: url.href, name: demo }]
}

function keyOf(source: string, name: string, theme: RegistryTheme | undefined): string {
  const look = theme?.mapped.length ? `${theme.overrides}|${theme.renderTokens}` : ''
  return createHash('sha1').update(`${source}\n${name}\n${look}`).digest('hex')
}

/** A WebP of one registry item, from the cache when it has one. */
export function registryThumbnail(source: string, name: string, theme?: RegistryTheme): Promise<Buffer> {
  const key = keyOf(source, name, theme)
  const now = Date.now()
  const known = cache.get(key)
  if (known && now - known.at < known.ttl) {
    /* most recently used last, so the oldest is the one dropped */
    cache.delete(key)
    cache.set(key, known)
    return known.image
  }
  const entry: Entry = { at: now, ttl: CACHE_MS, image: Promise.resolve(Buffer.alloc(0)) }
  entry.image = slot(async () => {
    /* a bare wrapper (a marquee, a card with a moving border) shows nothing on
       its own; the registry's `-demo` example shows it in use, so it is the
       picture when there is one */
    for (const candidate of [...demoOf(source, name), { source, name }]) {
      let prepared: Awaited<ReturnType<typeof prepareRegistryImport>>
      try {
        prepared = await prepareRegistryImport([candidate])
      } catch (error) {
        if (candidate.name !== name) continue
        throw error
      }
      try {
        const rendered = await renderRegistryComponent(prepared.selected[0]!, prepared.items, theme, { image: true })
        if (rendered.image) return rendered.image
      } catch (error) {
        /* a demo that needs more than the renderer has: picture the item itself */
        if (candidate.name === name) throw error
      }
    }
    throw new Error('No preview')
  })
  entry.image.catch((error: unknown) => {
    /* busy is not the item's fault: forget it at once */
    if (error instanceof ThumbnailBusyError) cache.delete(key)
    else entry.ttl = FAILURE_MS
  })
  cache.set(key, entry)
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!)
  return entry.image
}

/** Test seam. */
export function resetRegistryThumbnails() {
  cache.clear()
}
