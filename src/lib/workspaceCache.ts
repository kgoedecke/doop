import type { WorkspaceDetail } from '../../shared/types'
import { api } from './api'

/**
 * The last detail fetched for each workspace, so the Workspace page can draw
 * its people and plan on its first frame instead of a skeleton. Home warms
 * it while a workspace's canvases are in view, since its settings are one
 * rail row away; the page still refetches on arrival and replaces it.
 */
const details = new Map<string, WorkspaceDetail>()
const pending = new Map<string, Promise<WorkspaceDetail>>()

export function cachedWorkspace(id: string): WorkspaceDetail | null {
  return details.get(id) ?? null
}

/** Fetches a workspace's detail, sharing a request already in flight. */
export function loadWorkspace(id: string): Promise<WorkspaceDetail> {
  const inFlight = pending.get(id)
  if (inFlight) return inFlight
  const request = api
    .getWorkspace(id)
    .then((detail) => {
      details.set(id, detail)
      return detail
    })
    .catch((error: unknown) => {
      details.delete(id)
      throw error
    })
    .finally(() => pending.delete(id))
  pending.set(id, request)
  return request
}

/** Warms the cache; a failure is the Workspace page's to report. */
export function prefetchWorkspace(id: string): void {
  loadWorkspace(id).catch(() => undefined)
}
