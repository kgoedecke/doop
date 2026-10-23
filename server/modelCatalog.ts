import type { ModelOption } from '../shared/modelMenu.ts'

export interface ModelCatalog {
  models: ModelOption[]
  warning?: string
}

class CatalogAccessError extends Error {}

const CACHE_MS = 5 * 60_000
const RETRY_MS = 30_000
const cache = new Map<string, { identity: string; expiresAt: number; catalog: ModelCatalog }>()
const pending = new Map<string, Promise<ModelCatalog>>()

/** Only provider metadata crosses this boundary, never upstream errors or credentials. */
export async function fetchCatalogJson(url: URL, headers: HeadersInit, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { headers, signal, redirect: 'error' })
  if (!response.ok) {
    await response.body?.cancel()
    if (response.status === 401 || response.status === 403) throw new CatalogAccessError()
    throw new Error('Catalog request failed')
  }
  return response.json()
}

/** Share concurrent requests and retain the last successful list only for the
 * same user/provider/credential. An authentication failure clears that list. */
export async function loadModelCatalog(
  key: string,
  identity: string,
  label: string,
  load: (signal: AbortSignal) => Promise<ModelOption[]>,
): Promise<ModelCatalog> {
  const cached = cache.get(key)
  const previous = cached?.identity === identity ? cached : undefined
  if (previous && previous.expiresAt > Date.now()) return previous.catalog
  const requestKey = `${key}:${identity}`
  const inFlight = pending.get(requestKey)
  if (inFlight) return inFlight

  const task = (async () => {
    let catalog: ModelCatalog
    try {
      const models = await load(AbortSignal.timeout(10_000))
      catalog = {
        models,
        ...(!models.length ? { warning: `No compatible Doop agent models were returned by ${label}.` } : {}),
      }
    } catch (error) {
      const rejected = error instanceof CatalogAccessError
      const models = rejected ? [] : (previous?.catalog.models ?? [])
      catalog = {
        models,
        warning: rejected
          ? `Reconnect your ${label} account or check its permission to list models.`
          : models.length
            ? `Could not refresh ${label} models. Showing the last fetched list; retry in a moment.`
            : `Could not load ${label} models. Retry in a moment or reconnect your account.`,
      }
    }
    if (cache.size >= 1000 && !cache.has(key)) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(key, { identity, expiresAt: Date.now() + (catalog.warning ? RETRY_MS : CACHE_MS), catalog })
    return catalog
  })().finally(() => pending.delete(requestKey))
  pending.set(requestKey, task)
  return task
}
