import { useEffect } from 'react'
import { api, errorMessage, type CanvasLibrary } from './api'
import { useT } from './i18n'
import { safeRelativeTarget } from './safeTarget'
import { useStore } from './store'

/**
 * Picking the library flow up again after Stripe Checkout. Checkout is a full
 * page navigation away and back (to the workspace page), so what the person was
 * doing is kept in this browser: which canvas, which workspace, and the one
 * component they were publishing, if any. The workspace page sends them back to
 * the canvas once the plan is live, and the Components panel takes the note
 * once: it moves the canvas into the workspace when it is in none, then opens
 * the publish dialog. It never publishes.
 * Spec: .context/specs/workspace-component-library.md.
 */

export interface LibraryResumeIntent {
  canvasId: string
  workspaceId: string
  /** they started from this component's "Publish to library…" */
  componentId?: string
  /** when checkout was started, epoch ms */
  at: number
  /** the workspace page saw the plan go live after checkout */
  paid?: boolean
}

const KEY = 'doop:library-resume'
/** Long enough for a card form and a bank's confirmation, short enough that a
 *  checkout abandoned in the morning does nothing in the afternoon. */
export const RESUME_TTL_MS = 30 * 60_000
/* ids are nanoids; anything else in storage is not ours to build a path from */
const ID = /^[A-Za-z0-9_-]{1,64}$/

function parse(raw: string | null, now: number): LibraryResumeIntent | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<LibraryResumeIntent> | null
    if (!value || typeof value.canvasId !== 'string' || !ID.test(value.canvasId)) return null
    if (typeof value.workspaceId !== 'string' || !ID.test(value.workspaceId)) return null
    if (typeof value.at !== 'number' || now < value.at || now - value.at > RESUME_TTL_MS) return null
    return {
      canvasId: value.canvasId,
      workspaceId: value.workspaceId,
      ...(typeof value.componentId === 'string' && ID.test(value.componentId)
        ? { componentId: value.componentId }
        : {}),
      at: value.at,
      ...(value.paid === true ? { paid: true } : {}),
    }
  } catch {
    return null
  }
}

/** The note this browser holds, or null: none, malformed or past its time. */
export function readLibraryResume(now = Date.now()): LibraryResumeIntent | null {
  try {
    return parse(localStorage.getItem(KEY), now)
  } catch {
    return null
  }
}

export function clearLibraryResume() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* storage is blocked: there was nothing to clear */
  }
}

/** Checkout is about to open for a library reason: note what to return to. */
export function rememberLibraryResume(intent: Omit<LibraryResumeIntent, 'at' | 'paid'>, now = Date.now()) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...intent, at: now }))
  } catch {
    /* storage refused the write: the person returns to the canvas by hand, as before */
  }
}

/** Back from checkout on the workspace page with the plan live: mark the note
 *  and say where to go, a path on this origin, or null when the note is for
 *  another workspace or gone. */
export function confirmLibraryResume(workspaceId: string, now = Date.now()): string | null {
  const intent = readLibraryResume(now)
  if (!intent || intent.workspaceId !== workspaceId) return null
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...intent, paid: true }))
  } catch {
    return null
  }
  return safeRelativeTarget(`/c/${intent.canvasId}`)
}

/** Checkout was cancelled for this workspace: nothing to return to. */
export function cancelLibraryResume(workspaceId: string) {
  if (readLibraryResume()?.workspaceId === workspaceId) clearLibraryResume()
}

/** Whether a note is waiting for this canvas, for opening the panel that takes it. */
export function libraryResumeWaits(canvasId: string, now = Date.now()): boolean {
  return readLibraryResume(now)?.canvasId === canvasId
}

/** What to do with a note on the open canvas:
 *  - `none`: leave it (another canvas's, or nothing known yet, or the plan is not live yet)
 *  - `drop`: it no longer fits (the canvas sits elsewhere now, or this person may not publish)
 *  - `move`: the canvas is in no workspace and the plan was seen live: move it in, then publish
 *  - `publish`: open the publish dialog */
export type ResumeStep = 'none' | 'drop' | 'move' | 'publish'

export function resumeStep(
  intent: LibraryResumeIntent,
  view: { canvasId: string; canEdit: boolean; status: CanvasLibrary | null },
): ResumeStep {
  const { status } = view
  if (intent.canvasId !== view.canvasId || !status) return 'none'
  if (!view.canEdit) return 'drop'
  if (status.entitled) return status.workspaceId === intent.workspaceId && status.canPublish ? 'publish' : 'drop'
  /* in no workspace yet: only a plan this browser saw go live moves the canvas */
  if (!status.workspaceId) return intent.paid ? 'move' : 'none'
  /* its workspace still needs the plan: the webhook may yet land */
  if (status.blocked === 'plan_required' && status.workspaceId === intent.workspaceId) return 'none'
  return 'drop'
}

/** The Components panel's side: take the note once, and act on it. The note
 *  leaves storage before anything is done, so a reload or a second tab cannot
 *  repeat it. */
export function useLibraryResume({
  canvasId,
  canEdit,
  status,
  reload,
  onPublish,
}: {
  canvasId: string | undefined
  canEdit: boolean
  status: CanvasLibrary | null
  /** read the library status again (the canvas moved) */
  reload: () => void
  /** open the publish dialog, for one component when they started from one */
  onPublish: (only?: string) => void
}) {
  const t = useT()
  useEffect(() => {
    if (!canvasId) return
    const intent = readLibraryResume()
    if (!intent) return
    const step = resumeStep(intent, { canvasId, canEdit, status })
    if (step === 'none') return
    clearLibraryResume()
    if (step === 'drop') return
    if (step === 'publish') return onPublish(intent.componentId)
    api.moveCanvas(canvasId, intent.workspaceId).then(
      () => {
        reload()
        onPublish(intent.componentId)
      },
      (error: unknown) => useStore.getState().pushNotice(errorMessage(error, t('home.moveFailed'))),
    )
    /* acts when the status arrives or changes; the callbacks are the panel's own setters */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasId, canEdit, status])
}
