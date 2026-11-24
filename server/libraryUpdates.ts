import type { Actor, Canvas } from '../shared/types.ts'
import * as actions from './actions.ts'
import { runCanvasWrite } from './canvasWrites.ts'
import {
  ComponentError,
  libraryConsumers,
  requireLibraryPlan,
  requireLibraryPublisher,
  type LibrarySkippedConsumer,
  type LibraryUpdateOptions,
  type LibraryUpdateReport,
} from './componentActions.ts'
import { isLibrary, LibraryAdoptError } from './componentLibrary.ts'
import { checkpoint } from './journal.ts'
import * as propagation from './propagation.ts'
import { store } from './store.ts'
import { WorkBudgetError } from './workBudget.ts'

/** Bring every canvas of the workspace that uses this library up to its latest
 *  publication, in one step. Publishing never does this: it is its own act, by someone
 *  who may edit each canvas it changes, and it reports canvas by canvas what it did.
 *  Each pull is the ordinary one (pullFromLibrary): history is filed, approved frames
 *  keep their sign-off and the canvas's room is told.
 *
 *  Each canvas's pull is a write of its own through the canvas write entry (`pull-library`),
 *  committed here before the next (`checkpoint()`), so a canvas that is done stays done.
 *  When a canvas's step (its load, its pull, the wait for its frames) is refused or runs out
 *  of work budget after a pull was committed, the walk stops and the report says how far it
 *  got: that canvas as `failed`, the ones not reached that still use the library as
 *  `not_reached`. Before any pull was committed, or for anything that is not such a refusal
 *  (logged with its stack), the call fails as it always did.
 *
 *  Frame HTML is loaded per canvas (store.load), and a pull reads and rewrites the
 *  consumer's frames, so each consumer is loaded and held while it is worked on: one
 *  at a time, so a workspace of many canvases is never all in memory for this. */
export async function updateLibraryConsumers(
  libraryCanvasId: string,
  actor: Actor,
  options: LibraryUpdateOptions,
): Promise<LibraryUpdateReport> {
  const library = store.getCanvas(libraryCanvasId)
  if (!library) throw new ComponentError('canvas not found')
  requireLibraryPlan(library, 'Updating the canvases that use a library')
  requireLibraryPublisher(library, options.publisherId)
  if (!isLibrary(library.id))
    throw new ComponentError(
      'this canvas has not published a library, so no canvas follows it — publish_library comes first',
    )
  const report: LibraryUpdateReport = {
    library: { canvas_id: library.id, canvas_name: library.name },
    canvases: [],
    skipped: [],
  }
  const waiting = libraryConsumers(library).filter((consumer) => consumer.update_waiting)
  type Consumer = (typeof waiting)[number]
  const named = (consumer: Consumer) =>
    options.canRead(consumer.canvas_id) ? { canvas_id: consumer.canvas_id, canvas_name: consumer.canvas_name } : {}
  const noEditAccess = (consumer: Consumer): LibrarySkippedConsumer => ({
    ...named(consumer),
    reason: 'no_edit_access',
    message: 'this account may not edit that canvas; someone who can has to pull the update there',
  })
  /* has any pull been committed? From then on the call no longer fails for a refusal or a
     spent budget: it reports how far it got */
  let committed = false
  for (const [index, consumer] of waiting.entries()) {
    if (!options.canEdit(consumer.canvas_id)) {
      report.skipped.push(noEditAccess(consumer))
      continue
    }
    /* whether this canvas's own pull was committed before something failed */
    let landed = false
    try {
      const canvas = await store.load(consumer.canvas_id)
      /* deleted, or moved out of the workspace, while an earlier canvas was being read */
      if (!canvas) continue
      const release = store.hold(canvas.id)
      try {
        const { update, refusal } = await runCanvasWrite(canvas.id, {
          type: 'pull-library',
          library: library.id,
          actor,
        })
        /* a sub-commit per canvas, as this always made: the pull is sent and its frames enter
           the queue now, before the wait below (which would otherwise wait on a queue nothing
           has reached yet), and a canvas that is done stays done if a later one fails. Like
           every checkpoint it commits all the calling operation has done so far, not only the
           pull, as it did before the entry */
        checkpoint()
        committed = landed = true
        if (update) {
          /* the pull only queued its frames (all of them: the canvas is loaded): wait here,
             canvas held, for the ones it really changed. The wait blocks nothing (the queue
             works a frame per tick), and keeps the canvases this walks through in memory one
             at a time. */
          const drained = (await propagation.whenCanvasIdle(canvas.id)).propagate
          report.canvases.push({
            ...update,
            frames_changed: drained?.frames.length ?? 0,
            approvals_withdrawn: drained?.frames.filter((frame) => frame.approvalLost).length ?? 0,
          })
        }
        if (refusal) report.skipped.push({ ...named(consumer), reason: 'failed', message: refusal })
      } finally {
        release()
      }
    } catch (error) {
      const said = stopMessage(error)
      /* not a refusal that can be put into words: logged, and the call fails, as it always did */
      if (said === undefined) {
        console.error(`[library] updating the canvases using ${library.id} failed`, error)
        throw error
      }
      /* nothing committed yet: the call fails whole, its operation undone, as it always did */
      if (!committed) throw error
      report.skipped.push({
        ...named(consumer),
        reason: 'failed',
        message: landed
          ? `the update was applied here, but stopped before its frames were counted: ${said}`
          : `the update stopped here, and nothing was changed on this canvas: ${said}`,
      })
      notReached(library, waiting.slice(index + 1), report, named, noEditAccess, options)
      break
    }
  }
  if (report.canvases.length) {
    const count = report.canvases.length
    actions.logComponent(
      library.id,
      actor,
      `updated ${count} canvas${count === 1 ? '' : 'es'} to this library’s latest publication`,
    )
    /* the library's own panel counts who is behind: it reads again */
    actions.broadcastLibrary(library, actor)
  }
  return report
}

/** Why the walk stopped, in words fit for the person: a refusal's own message, a fixed one for
 *  a spent work budget; undefined for anything else (an internal failure, never shown). */
function stopMessage(error: unknown): string | undefined {
  if (error instanceof ComponentError || error instanceof LibraryAdoptError) return error.message
  if (error instanceof WorkBudgetError) return 'this update ran out of its work budget; run it again to continue'
  return undefined
}

/** The canvases the walk did not reach, as they stand now: one that no longer uses the library
 *  (or is gone) is left out. */
function notReached<Consumer extends { canvas_id: string }>(
  library: Canvas,
  rest: Consumer[],
  report: LibraryUpdateReport,
  named: (consumer: Consumer) => Partial<LibrarySkippedConsumer>,
  noEditAccess: (consumer: Consumer) => LibrarySkippedConsumer,
  options: LibraryUpdateOptions,
) {
  const using = new Set(libraryConsumers(library).map((consumer) => consumer.canvas_id))
  for (const consumer of rest) {
    if (!using.has(consumer.canvas_id)) continue
    report.skipped.push(
      options.canEdit(consumer.canvas_id)
        ? {
            ...named(consumer),
            reason: 'not_reached',
            message: 'not reached: the update stopped at an earlier canvas; nothing was changed here',
          }
        : noEditAccess(consumer),
    )
  }
}
