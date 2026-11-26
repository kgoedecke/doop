import type { z } from 'zod'
import * as actions from './actions.ts'
import type { SharedToolName, TOOL_SHAPES } from './agentToolShapes.ts'
import { captureFeature } from './featureEvents.ts'
import { type Surface } from './inlineData.ts'
import { addPage, pageList, savePages } from './pageTools.ts'
import { prototypeReport, prototypeUrl, setPrototypeStart } from './prototypeTools.ts'
import { samePages } from '../shared/pages.ts'
import type { Actor, Canvas } from '../shared/types.ts'

/**
 * One handler for each simple tool that MCP agents (server/mcp.ts) and the Doop Agent (server/resident.ts) both
 * call: it does the work and says what to answer, so the two get the same answer. Each surface keeps only what it
 * does around any call: MCP checks the account may use the canvas and adds the feedback waiting for the agent; the
 * Doop Agent counts what its run delivered. The input is already checked against the tool's shape
 * (agentToolShapes.ts) on both. Tools that stream, render or keep run state of their own keep a handler per surface.
 */

export interface SharedToolContext {
  canvas: Canvas
  actor: Actor
  /** the account the agent works for, whose feature events these are */
  userId: string | undefined
  surface: Surface
}

export type SharedToolOutcome =
  | {
      ok: true
      data: Record<string, unknown>
      /** the call changed how the canvas is organised (its name, its pages): a run that did only this delivered work */
      arranged?: boolean
    }
  | { ok: false; error: string }

type SharedToolInput<Name extends SharedToolName> = z.output<z.ZodObject<(typeof TOOL_SHAPES)[Name]>>

interface SharedToolHandler<Name extends SharedToolName> {
  /** what the account needs on the canvas: a read needs only to view it */
  access: 'view' | 'edit'
  run(input: SharedToolInput<Name>, context: SharedToolContext): SharedToolOutcome
}

/** A frame id given to clear: null, or the empty string the Doop Agent cleared with before it took null. */
const frameIdOrNull = (given: string | null): string | null => given?.trim() || null

const HANDLERS: { [Name in SharedToolName]?: SharedToolHandler<Name> } = {
  update_canvas: {
    access: 'edit',
    run({ name }, { canvas, actor }) {
      const before = canvas.name
      const renamed = actions.renameCanvas(canvas.id, name, actor)
      if (!renamed) return { ok: false, error: `canvas ${canvas.id} not found` }
      return { ok: true, data: { ok: true, id: renamed.id, name: renamed.name }, arranged: renamed.name !== before }
    },
  },
  create_canvas_page: {
    access: 'edit',
    run({ name }, { canvas, actor }) {
      const created = addPage(canvas.id, name, actor)
      if (!created.ok) return created
      return { ok: true, data: { ok: true, ...created.value }, arranged: true }
    },
  },
  set_canvas_pages: {
    access: 'edit',
    run({ expectedPages, pages }, { canvas, actor }) {
      const before = pageList(canvas)
      const saved = savePages(canvas, expectedPages, pages, actor)
      if (!saved.ok) return saved
      return { ok: true, data: { ok: true, pages: saved.value }, arranged: !samePages(before, saved.value) }
    },
  },
  get_prototype: {
    access: 'view',
    run(_input, { canvas }) {
      return { ok: true, data: prototypeReport(canvas) }
    },
  },
  set_prototype_start: {
    access: 'edit',
    run({ pageId, frame_id }, { canvas, actor, userId, surface }) {
      const frameId = frameIdOrNull(frame_id)
      const result = setPrototypeStart(canvas, pageId || undefined, frameId, actor)
      if (!result.ok) return result
      captureFeature(userId, 'prototype_start_set', surface, { canvas_id: canvas.id, cleared: frameId === null })
      return { ok: true, data: { ok: true, pages: result.pages, prototype_url: prototypeUrl(canvas.id) } }
    },
  },
}

/** A handler with its input type erased: the surface checked the input against the tool's shape before calling. */
type CheckedHandler = {
  access: 'view' | 'edit'
  run(input: Record<string, unknown>, context: SharedToolContext): SharedToolOutcome
}

/** The shared handler of a tool, if it has one. */
export function sharedToolHandler(name: string): CheckedHandler | undefined {
  return Object.hasOwn(HANDLERS, name) ? (HANDLERS[name as SharedToolName] as CheckedHandler | undefined) : undefined
}
