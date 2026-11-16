import type { RegistrySelection } from '../../shared/shadcnRegistry'
import { api, ApiError } from './api'

/**
 * The component library's item pictures. The server renders each one in
 * Chromium, so they are asked for two at a time, only once a card scrolls
 * into view, and kept for the session as object URLs.
 */

const RUNNING = 2
const KEPT = 300
const RETRIES = 4
const RETRY_MS = 3000

const pictures = new Map<string, Promise<string>>()
const queue: (() => void)[] = []
let running = 0

async function turn<T>(work: () => Promise<T>): Promise<T> {
  if (running >= RUNNING) await new Promise<void>((resolve) => queue.push(resolve))
  running++
  try {
    return await work()
  } finally {
    running--
    queue.shift()?.()
  }
}

async function load(canvasId: string, item: RegistrySelection, matchTokens: boolean): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      const blob = await turn(() => api.registryThumbnail(canvasId, item, matchTokens))
      return URL.createObjectURL(blob)
    } catch (error) {
      /* the server's render queue was full: wait, then ask again */
      if (error instanceof ApiError && error.status === 503 && attempt < RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS))
        continue
      }
      throw error
    }
  }
}

/** An object URL for the item's picture; rejects when it cannot be rendered. */
export function registryPicture(canvasId: string, item: RegistrySelection, matchTokens: boolean): Promise<string> {
  const key = `${canvasId}\n${matchTokens ? 1 : 0}\n${item.source}\n${item.name}`
  const known = pictures.get(key)
  if (known) return known
  const picture = load(canvasId, item, matchTokens)
  pictures.set(key, picture)
  picture.catch(() => {})
  while (pictures.size > KEPT) {
    const [oldest, url] = pictures.entries().next().value!
    pictures.delete(oldest)
    void url.then(URL.revokeObjectURL, () => {})
  }
  return picture
}
