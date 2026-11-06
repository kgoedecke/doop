import type { WorkspaceDetail } from '../../shared/types'
import { api } from './api'

/**
 * The last detail fetched for each workspace, so the Workspace page can draw
 * its people and plan on its first frame instead of a skeleton. Home warms
 * it while a workspace's canvases are in view, since its settings are one
 * rail row away; the page still refetches on arrival and replaces it.
 *
 * Every fetch is its own request: a refresh after an edit must not ride on
 * one that left before the edit. Each is numbered, and an answer (or a
 * failure) older than the one already kept never replaces it.
 */
/* a failed fetch leaves `detail: null` at its number, so an older answer
   landing after it cannot bring the dropped detail back */
const details = new Map<string, { detail: WorkspaceDetail | null; seq: number }>()
const warming = new Set<string>()
let lastSeq = 0

export function cachedWorkspace(id: string): WorkspaceDetail | null {
  return details.get(id)?.detail ?? null
}

/** Fetches a workspace's detail afresh and keeps it unless a newer answer already landed. */
export async function fetchWorkspace(id: string): Promise<WorkspaceDetail> {
  const seq = ++lastSeq
  const keep = (detail: WorkspaceDetail | null) => {
    if (seq > (details.get(id)?.seq ?? 0)) details.set(id, { detail, seq })
  }
  try {
    const detail = await api.getWorkspace(id)
    keep(detail)
    return detail
  } catch (error) {
    keep(null)
    throw error
  }
}

/** Warms the cache, one warm-up per workspace at a time; a failure is the Workspace page's to report. */
export function prefetchWorkspace(id: string): void {
  if (warming.has(id)) return
  warming.add(id)
  fetchWorkspace(id)
    .catch(() => undefined)
    .finally(() => warming.delete(id))
}
