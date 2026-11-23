import { z } from 'zod'
import { activeComponents, PROP_TYPES, USE_TAG, type ComponentDef } from '../shared/components.ts'
import type { Actor, Canvas, Frame } from '../shared/types.ts'
import {
  catalog,
  catalogEntry,
  changeInstances,
  componentDetail,
  ComponentError,
  findComponent,
  findDeletedComponent,
  importableEntry,
  libraryCatalog,
  libraryConsumers,
  publishToLibrary,
  unpublishFromLibrary,
  usageExample,
  touchedFrames,
  insertInstance,
  instancesIn,
} from './componentActions.ts'
import { isLibrary, librariesForCanvas } from './componentLibrary.ts'
import * as actions from './actions.ts'
import { componentReuseNotes, componentSystemNotes, frameReuseNotes } from './reuseNotes.ts'
import { store } from './store.ts'
import { inlineDataRefusal, type Surface } from './inlineData.ts'
import { optional, WorkBudgetError } from './workBudget.ts'
import { WriteRefusedError } from './writeRefusal.ts'
import { transaction } from './journal.ts'
import { readableSources, runCanvasWrite, type ComponentView } from './canvasWrites.ts'
import { updateLibraryConsumers } from './libraryUpdates.ts'
import type { ComponentChange } from './changeChecks.ts'

/**
 * The component tools every agent gets, over MCP (server/mcp.ts) or in the server
 * (server/resident.ts): one schema and one handler each, so the two cannot drift.
 * Spec: .context/specs/components.md.
 */

export const propSchema = z.object({
  name: z.string().describe('Lowercase, it becomes an attribute: "label", "tone", "show-icon"'),
  type: z.enum(PROP_TYPES).optional().describe('text (default), image, link, boolean, or enum with options'),
  default: z.string().optional().describe('enum and boolean only; text-like defaults are the template content'),
  options: z
    .array(z.string())
    .optional()
    .describe('enum values. An enum sets data-<name> on the root, for CSS to key on'),
  description: z.string().optional().describe('When to use it, in a line'),
})

export const codeSchema = z
  .object({
    path: z.string().max(500).optional().describe('Source file or package, e.g. "src/components/ui/button.tsx"'),
    name: z.string().max(200).optional().describe('Export name, e.g. "Button"'),
    snippet: z.string().max(4000).optional().describe('How it is used in code, or how props map to it'),
  })
  .describe('Where this lives in code, read by whoever implements a design that uses it')

export interface ToolContext {
  canvas: Canvas
  actor: Actor
  /** may this account read that other canvas? a library is only imported from one it can */
  canRead: (canvasId: string) => boolean
  /** may this account change that other canvas? update_library_everywhere writes only where it can */
  canEdit: (canvasId: string) => boolean
  /** canvases this account can read, for the library listing */
  readableCanvases: () => Canvas[]
  /** the account acting: the person an agent works for. Publishing is checked against it */
  userId: string | undefined
  /** which agent is calling, for the tools a refusal may point it at */
  surface?: Surface
}

export type ToolResult = {
  data: unknown
  note?: string
  /** the frames the call touched: the ones it wrote and the ones following a component it changed */
  frames?: Frame[]
  /** set by a call that changes components rather than writing frames itself: each component
   *  it changed, with the frames showing it (its main and every frame using it), any one of
   *  which shows the change. No frames: nothing on the canvas looks any different. */
  changed?: ComponentChange[]
}

/** Every component of a canvas at its revision: what a write that added or changed none leaves alone. */
function componentsStamp(canvasId: string): string {
  return (store.getCanvas(canvasId)?.components ?? []).map((def) => `${def.id}:${def.rev}:${def.status}`).join(',')
}

/** A component a call changed, and the frames that show it. */
function changeOf(def: ComponentDef, frames: readonly Frame[]): ComponentChange {
  return { id: def.id, name: def.name, frameIds: frames.map((frame) => frame.id) }
}

interface ComponentTool {
  name: string
  title: string
  description: string
  readOnly: boolean
  destructive?: boolean
  shape: z.ZodRawShape
  /** a promise only where the tool has to load other canvases (update_library_everywhere) */
  run(input: Record<string, unknown>, context: ToolContext): ToolResult | Promise<ToolResult>
}

/** One create_components call: a canvas's starting kit, not its whole library. */
export const MAX_BATCH_COMPONENTS = 12

const COMPONENT_REF = z.string().describe('Component name or id')
const FRAME_ID = z.string().describe('Frame id from get_canvas')
const LIBRARY_NOTE =
  'This canvas is a workspace library: other canvases keep the last published version until you publish_library here (when the human wants the change shared) and each pulls it with sync_component (or, when the human asks for it everywhere, update_library_everywhere here).'
const IMPACT_NOTE =
  'Check one affected frame with get_frame_screenshot. Approved frames keep their sign-off: following a component is not an edit of the frame.'

/** Whether the instances have the change yet: said, because the call returns before they do. */
function propagationNote(result: { propagation?: { status: string; frames: number } }): string[] {
  const { status, frames } = result.propagation ?? { status: 'none', frames: 0 }
  const count = `${frames} frame${frames === 1 ? '' : 's'}`
  if (status === 'queued')
    return [
      `Instances follow the component: the ${count} in impact.frames are being rendered again in the background, with no edit of the frames themselves. get_frame and get_frame_screenshot wait a moment for it; on a large canvas the last frames can take longer.`,
    ]
  if (status === 'deferred')
    return [
      `This server has component propagation switched off for now: the ${count} in impact.frames keep the previous revision until each is next written or its page is next read.`,
    ]
  return []
}

function summary(canvas: Canvas, def: ComponentDef) {
  return catalogEntry(canvas, def)
}

function outcomeFrames(context: ToolContext, def: ComponentDef, extra: string[] = []): Frame[] {
  return touchedFrames(context.canvas, def, extra)
}

/** What a routed write answers of its component, read in the write's own step; read here instead
 *  when the canvas had gone by then (it never has in practice), as the tools did before. */
function viewOr(canvas: Canvas, def: ComponentDef, view: ComponentView | undefined, extra: string[] = []) {
  return view ?? { entry: summary(canvas, def), frames: outcomeFrames({ canvas } as ToolContext, def, extra) }
}

const asProps = (value: unknown) => value as Record<string, string> | undefined

const inferredProps = (names: string[]) => (names.length ? { inferred_props: names } : {})

/** Names the server made up are the ones worth a second look, while nothing uses them yet. */
function inferredNote(names: string[]): string {
  if (!names.length) return ''
  return ` Props inferred from the markup: ${names.join(', ')}. To name one yourself, write data-doop-prop on its element (now: update_component with find + replace on the template, before instances set it); pass props to give one a type or description.`
}

export const COMPONENT_TOOLS: ComponentTool[] = [
  {
    name: 'list_components',
    title: 'List components',
    description:
      "List the reusable components on a canvas: each name, its props and slots as a one-line signature, a ready-to-paste <doop-use> and how often it is used. Check this BEFORE writing markup: anything on this list must be used through <doop-use>, never redrawn. workspace_libraries lists what the canvas's workspace has published and this canvas does not use yet: write <doop-use> with that name and it is added, linked to its library. With libraries=true, also lists components on other canvases this account can read, ready for import_component.",
    readOnly: true,
    shape: {
      query: z.string().optional().describe('Only components whose name or description contains this'),
      libraries: z.boolean().optional().describe('Also list importable components from other canvases'),
    },
    run({ query, libraries }, { canvas, readableCanvases }) {
      const wanted = typeof query === 'string' ? query.toLowerCase() : ''
      const matches = (def: ComponentDef) =>
        !wanted || def.name.toLowerCase().includes(wanted) || def.description.toLowerCase().includes(wanted)
      const components = catalog(canvas, activeComponents(canvas.components).filter(matches))
      const shared = libraryCatalog(canvas)
        .map((library) => ({
          ...library,
          components: library.components.filter(
            (entry) =>
              !wanted ||
              entry.name.toLowerCase().includes(wanted) ||
              (entry.description ?? '').toLowerCase().includes(wanted),
          ),
        }))
        .filter((library) => library.components.length)
      return {
        data: {
          components,
          ...(shared.length ? { workspace_libraries: shared } : {}),
          ...(libraries
            ? {
                libraries: readableCanvases()
                  .filter((other) => other.id !== canvas.id && activeComponents(other.components).length)
                  .map((other) => ({
                    canvas_id: other.id,
                    canvas_name: other.name,
                    components: activeComponents(other.components).filter(matches).map(importableEntry),
                  })),
              }
            : {}),
          ...(components.length || shared.length
            ? {}
            : {
                note: 'No components match. If a block repeats, make it one with create_component.',
              }),
        },
      }
    },
  },
  {
    name: 'get_component',
    title: 'Read a component',
    description:
      'Read one component in full: its template (each element keyed with data-doop-part, the keys overrides use), its CSS, props, slots, where it is used, earlier revisions and where it lives in code. Read this before update_component.',
    readOnly: true,
    shape: { component: COMPONENT_REF },
    run({ component }, { canvas }) {
      const def = findComponent(canvas.id, String(component))
      if (!def) throw new ComponentError(`no component “${String(component)}” on this canvas`)
      return { data: componentDetail(canvas, def) }
    },
  },
  {
    name: 'create_component',
    title: 'Create a component',
    description:
      'Make a reusable component from new markup (html + css) or from an element already in a frame (frame_id + element). From markup, the main lands on the canvas\'s Components page and no instance is placed anywhere: to use it, write <doop-use component="…"> in a frame\'s HTML or call insert_instance. From an element (its data-doop-id from get_frame), that element stays where it is and becomes the main; other copies of it stay plain markup until you replace each with <doop-use> in edit_frame_html (insert_instance only adds one, it replaces nothing). Unless the markup already says otherwise, leaf text, image sources and link targets become props, named after what each element is (title, label, image, link, text) or its class; the result lists them. Name your own with data-doop-prop="label" (text), data-doop-prop="src:photo" (an image; on an <img> a bare name binds its src too), data-doop-prop="href:link,--accent:accent" (attributes, custom properties), data-doop-if="tone=ghost" or "show-icon" (conditional elements), data-doop-slot="actions" (content each instance supplies, add data-doop-slot-suggest="Button"). An enum prop in props sets data-<name> on the root, so variants are plain CSS: .btn[data-tone="ghost"] { … }. Give it a description saying when to use it: it is how the next agent knows.',
    readOnly: false,
    shape: {
      name: z.string().describe('Short and unique, e.g. "Button", "Pricing Card"'),
      description: z.string().optional().describe('When to use this. Later agents choose by it'),
      frame_id: z.string().optional().describe('With element: make this existing element the main'),
      element: z.string().optional().describe("The element's data-doop-id from get_frame"),
      html: z.string().optional().describe('New markup, one root element'),
      css: z.string().optional().describe('With html: the rules it needs, unscoped; they get scoped for you'),
      width: z.number().optional().describe('With html: the main frame width, default 480'),
      height: z.number().optional().describe('With html: the main frame height, default 240'),
      props: z.array(propSchema).optional().describe('Enum props, and metadata for bound ones'),
      auto_props: z.boolean().optional().describe('false = do not infer props'),
      code: codeSchema.optional(),
    },
    async run(input, { canvas, actor }) {
      const shared = {
        name: String(input.name ?? ''),
        description: input.description as string | undefined,
        props: input.props as never,
        code: input.code as never,
        autoProps: input.auto_props as boolean | undefined,
      }
      if (typeof input.html === 'string') {
        const created = await runCanvasWrite(canvas.id, {
          type: 'create-component',
          from: {
            kind: 'html',
            ...shared,
            html: input.html,
            css: input.css as string | undefined,
            width: input.width as number | undefined,
            height: input.height as number | undefined,
          },
          actor,
          view: true,
        })
        const { component: def, inferred } = created
        const view = viewOr(canvas, def, created.view)
        return {
          data: {
            ok: true,
            component: view.entry,
            main_frame_id: def.mainFrameId,
            ...inferredProps(inferred),
          },
          note: [
            `The main is frame main_frame_id on the Components page. No instance was placed: to use it, write ${usageExample(def)} in a frame's HTML, or call insert_instance. Call get_frame_screenshot on main_frame_id, and fit that frame to it with update_frame's fit_to_content "both".${inferredNote(inferred)}`,
            ...(optional(() => componentReuseNotes(canvas, def, shared.autoProps)) ?? []),
          ].join('\n'),
          frames: view.frames,
          changed: [changeOf(def, view.frames)],
        }
      }
      if (typeof input.frame_id !== 'string' || typeof input.element !== 'string')
        throw new ComponentError('pass html, or frame_id with element')
      const created = await runCanvasWrite(canvas.id, {
        type: 'create-component',
        from: {
          kind: 'element',
          ...shared,
          frameId: input.frame_id,
          element: input.element,
        },
        actor,
        view: true,
      })
      const { component, inferred } = created
      const view = viewOr(canvas, component, created.view)
      return {
        data: {
          ok: true,
          component: view.entry,
          main_frame_id: component.mainFrameId,
          ...inferredProps(inferred),
        },
        note: [
          `Use it with ${usageExample(component)}.${inferredNote(inferred)}`,
          ...(optional(() => componentReuseNotes(canvas, component, shared.autoProps)) ?? []),
        ].join('\n'),
        frames: view.frames,
        changed: [changeOf(component, view.frames)],
      }
    },
  },
  {
    name: 'create_components',
    title: 'Create several components',
    description: `Make up to ${MAX_BATCH_COMPONENTS} components from new markup in one call: the way to set up a canvas's component system (the primitives and patterns its screens are built from) before the first screen. Each entry takes what create_component takes from html: name, description, html (one root element), css, width, height, props, auto_props, code. Entries are made in order, so a later one can <doop-use> an earlier one: list primitives first (Button, Input, Badge), then what is built from them (Card, NavItem, Sidebar). Each entry stands alone: one that is refused is reported with its reason and the others are still made. The mains land on the Components page and no instance is placed anywhere; use them with <doop-use> in frame HTML. To make a component from an element already in a frame, use create_component.`,
    readOnly: false,
    shape: {
      components: z
        .array(
          z.object({
            name: z.string().describe('Short and unique, e.g. "Button"'),
            description: z.string().optional().describe('When to use this. Later agents choose by it'),
            html: z.string().describe('Markup, one root element'),
            css: z.string().optional().describe('The rules it needs, unscoped; they get scoped for you'),
            width: z.number().optional().describe('The main frame width, default 480'),
            height: z.number().optional().describe('The main frame height, default 240'),
            props: z.array(propSchema).optional().describe('Enum props, and metadata for bound ones'),
            auto_props: z.boolean().optional().describe('false = do not infer props'),
            code: codeSchema.optional(),
          }),
        )
        .min(1)
        .max(MAX_BATCH_COMPONENTS)
        .describe('In dependency order: a component another one nests comes first'),
    },
    async run(input, { canvas, actor }) {
      const entries = (Array.isArray(input.components) ? input.components : []) as Record<string, unknown>[]
      if (!entries.length) throw new ComponentError('pass at least one component')
      if (entries.length > MAX_BATCH_COMPONENTS)
        throw new ComponentError(`at most ${MAX_BATCH_COMPONENTS} components per call; send the rest in another call`)
      /* each entry its own unit, made in order (server/canvasWrites.ts) */
      const created = await runCanvasWrite(canvas.id, {
        type: 'create-components',
        entries: entries.map((entry) => ({
          name: String(entry.name ?? ''),
          description: entry.description as string | undefined,
          props: entry.props as never,
          code: entry.code as never,
          autoProps: entry.auto_props as boolean | undefined,
          html: String(entry.html ?? ''),
          css: entry.css as string | undefined,
          width: entry.width as number | undefined,
          height: entry.height as number | undefined,
        })),
        actor,
        view: true,
      })
      const made = created.flatMap((entry) => (entry.ok ? [entry] : []))
      const notes = made.flatMap((entry) => entry.notes ?? [])
      const results = created.map((entry, index) =>
        entry.ok
          ? {
              index,
              ok: true as const,
              component: viewOr(canvas, entry.component, entry.view).entry,
              main_frame_id: entry.component.mainFrameId,
              ...inferredProps(entry.inferred),
            }
          : { index, ok: false as const, name: entry.name, error: entry.error },
      )
      const failed = results.filter((result) => !result.ok)
      const usage = made.map((entry) => usageExample(entry.component)).join('\n')
      return {
        data: { ok: failed.length === 0, created: made.length, failed: failed.length, results },
        note: [
          made.length
            ? `Made ${made.length} component${made.length === 1 ? '' : 's'} on the Components page. No instance was placed: compose screens from them with\n${usage}\nCall get_frame_screenshot on a main_frame_id or two, and fit a main to its content with update_frame's fit_to_content "both". Props each one inferred are in its inferred_props.`
            : 'Nothing was made.',
          ...(failed.length
            ? [
                `${failed.length} entr${failed.length === 1 ? 'y was' : 'ies were'} refused (see results): fix ${failed.length === 1 ? 'it' : 'them'} and send ${failed.length === 1 ? 'it' : 'them'} again. An entry that nests a refused one is refused too.`,
              ]
            : []),
          ...notes,
        ].join('\n'),
        frames: made.flatMap((entry) => viewOr(canvas, entry.component, entry.view).frames),
        changed: made.map((entry) => changeOf(entry.component, viewOr(canvas, entry.component, entry.view).frames)),
      }
    },
  },
  {
    name: 'update_component',
    title: 'Update a component',
    description:
      "Change a component's main; every instance on the canvas follows in the background within moments, keeping its props and overrides, so this is how a sweeping design change is one call rather than one edit per screen. Small changes to the markup: find + replace on the template (from get_component). CSS is not searched: to change a style, pass the whole stylesheet as css. Rewrites: html (or template, the name get_component reads it back under; never both), keeping data-doop-part attributes where you can so overrides stay attached. The result reports the impact: which frames hold instances and are queued to follow (propagation), how many of them are approved (they keep their sign-off), which overrides no longer have an element to apply to. Pass dry_run=true to read that report first, which you should for a component with many instances. A changed main is one undo-able revision: restore_component_version goes back.",
    readOnly: false,
    destructive: true,
    shape: {
      component: COMPONENT_REF,
      find: z.string().optional().describe('Exact text in the template; must occur once'),
      replace: z.string().optional(),
      html: z.string().optional().describe('New template markup, one root element'),
      template: z.string().optional().describe('The same as html, under the name get_component returns it by'),
      css: z
        .string()
        .optional()
        .describe('The rules the template needs, unscoped; replaces what this tool wrote before'),
      name: z.string().optional(),
      description: z.string().optional(),
      props: z.array(propSchema).optional().describe('Full replacement of the prop metadata'),
      code: codeSchema.optional(),
      expected_rev: z.number().optional().describe('Refuse if the component has moved past this revision'),
    },
    async run(input, { canvas, actor, canRead }) {
      if (input.html !== undefined && input.template !== undefined)
        throw new ComponentError('pass the new markup once, as html or as template, not both')
      const html = input.html ?? input.template
      const result = await runCanvasWrite(canvas.id, {
        type: 'update-component',
        component: String(input.component),
        input: {
          ...(input.find !== undefined ? { find: String(input.find), replace: String(input.replace ?? '') } : {}),
          ...(html !== undefined ? { html: String(html) } : {}),
          ...(input.css !== undefined ? { css: String(input.css) } : {}),
          ...(input.name !== undefined ? { name: String(input.name) } : {}),
          ...(input.description !== undefined ? { description: String(input.description) } : {}),
          ...(input.props !== undefined ? { props: input.props as never } : {}),
          ...(input.code !== undefined ? { code: input.code as never } : {}),
          ...(input.expected_rev !== undefined ? { expectedRev: Number(input.expected_rev) } : {}),
        },
        actor,
        view: true,
      })
      const { view: written, ...updated } = result
      const view = viewOr(canvas, result.component, written)
      /* on a library canvas the impact above counts this canvas alone: say who else follows it */
      const shared = isLibrary(canvas.id)
        ? libraryConsumers(canvas).filter((consumer) => canRead(consumer.canvas_id))
        : []
      return {
        data: {
          ok: true,
          ...updated,
          component: view.entry,
          rev: result.component.rev,
          ...(shared.length ? { library_used_by: shared } : {}),
        },
        note: [
          ...propagationNote(result),
          isLibrary(canvas.id) ? `${IMPACT_NOTE} ${LIBRARY_NOTE}` : IMPACT_NOTE,
          ...(optional(() => componentReuseNotes(canvas, result.component)) ?? []),
        ].join('\n'),
        frames: view.frames,
        changed: [changeOf(result.component, view.frames)],
      }
    },
  },
  {
    name: 'insert_instance',
    title: 'Place a component',
    description: `Place one instance of a component into a frame, inside or beside an element, and get back its instance_id. When you are already writing the frame's HTML, write <${USE_TAG}> in it instead.`,
    readOnly: false,
    shape: {
      frame_id: FRAME_ID,
      component: COMPONENT_REF,
      props: z.record(z.string()).optional().describe('Prop values, e.g. { "label": "Sign up", "tone": "ghost" }'),
      target: z.string().optional().describe('A data-doop-id. Defaults to the page body'),
      position: z
        .enum(['append', 'prepend', 'before', 'after'])
        .optional()
        .describe('Relative to target; default append'),
    },
    run(input, { canvas, actor }) {
      const { frame, instanceId } = insertInstance(
        canvas.id,
        {
          frameId: String(input.frame_id),
          component: String(input.component),
          props: asProps(input.props),
          target: input.target as string | undefined,
          position: input.position as never,
        },
        actor,
      )
      return { data: { ok: true, instance_id: instanceId, frame_id: frame.id }, frames: [frame] }
    },
  },
  {
    name: 'update_instances',
    title: 'Change instances',
    description:
      "Change instances in one frame in a single undo step: set props, override one element (keyed by part, from get_component), reset overrides back to the main, or detach. Instance ids come from get_frame's instances list. An override is sparse: everything else keeps following the main. Detaching keeps the look and cuts the link, for that instance only (instances nested inside it stay linked).",
    readOnly: false,
    shape: {
      frame_id: FRAME_ID,
      instances: z
        .array(
          z.object({
            instance_id: z.string(),
            props: z.record(z.string()).optional().describe('Merged over current props; "" clears one'),
            overrides: z
              .record(z.any())
              .optional()
              .describe('By part key, e.g. { "abcd": { "style": { "color": "red" }, "text": "Hi", "hidden": true } }'),
            reset: z
              .union([z.boolean(), z.array(z.string())])
              .optional()
              .describe('true = everything, or these part keys'),
            detach: z.boolean().optional(),
          }),
        )
        .min(1),
    },
    run(input, { canvas, actor }) {
      const list = input.instances as {
        instance_id: string
        props?: Record<string, string>
        overrides?: Record<string, never>
        reset?: boolean | string[]
        detach?: boolean
      }[]
      const { frame, missing } = changeInstances(
        canvas.id,
        String(input.frame_id),
        list.map((entry) => ({
          instanceId: entry.instance_id,
          props: entry.props,
          overrides: entry.overrides,
          reset: entry.reset,
          detach: entry.detach,
        })),
        actor,
      )
      /* the change is in: reading the instances back is a courtesy the budget may not cover */
      const instances = optional(() => instancesIn(frame))
      return {
        data: { ok: true, ...(instances ? { instances } : {}), ...(missing.length ? { not_found: missing } : {}) },
        ...(instances ? {} : { note: 'The change was applied. Call get_frame to read the instances back.' }),
        frames: [frame],
      }
    },
  },
  {
    name: 'delete_component',
    title: 'Delete a component',
    description:
      'Delete a component. Nothing changes in any design and no frame is rewritten: its instances keep exactly the markup they have and simply stop following it, its main stays in its frame as ordinary markup, and a component built from it keeps rendering as it did. It leaves the catalog, <doop-use> of it is refused, and get_canvas lists it under deletedComponents while instances of it remain. restore_component brings it back with every instance linked again. Pass detach_instances=true only when the human wants the leftovers to be plain markup for good: that rewrites every frame using it, in the background, and cannot be restored (it also works on a component that is already deleted).',
    readOnly: false,
    destructive: true,
    shape: {
      component: COMPONENT_REF,
      detach_instances: z
        .boolean()
        .optional()
        .describe('Also turn every instance into plain markup, in the background. Not undone by restore_component'),
    },
    async run({ component, detach_instances }, { canvas, actor }) {
      const ref = String(component)
      const pending = findDeletedComponent(canvas.id, ref)
      /* detaching what an earlier delete left behind is the same call again */
      const result =
        pending && detach_instances === true
          ? { deleted: pending.name, component_id: pending.id, already_deleted: true }
          : await runCanvasWrite(canvas.id, { type: 'delete-component', component: ref, actor })
      const detached =
        detach_instances === true
          ? await runCanvasWrite(canvas.id, {
              type: 'detach-instances',
              component: result.component_id,
              actor,
              frames: true,
            })
          : undefined
      const { touched = [], frameIds: _frameIds, ...detach } = detached ?? {}
      return {
        data: { ok: true, ...result, ...(detached ? { detach } : {}) },
        note: detached
          ? detached.queued
            ? `Detaching ${detached.instances} instance${detached.instances === 1 ? '' : 's'} in ${detached.frames} frame${detached.frames === 1 ? '' : 's'} in the background, a frame at a time: they become plain markup that keeps its look. This is not undone by restore_component.`
            : 'Nothing on the canvas uses it, so there was nothing to detach.'
          : 'No frame was changed: its instances look the same and no longer follow it. restore_component brings it back; delete_component with detach_instances=true turns what is left into plain markup.',
        frames: touched,
        /* nothing looks any different, its instances detached or not */
        changed: [{ id: result.component_id, name: result.deleted, frameIds: [] }],
      }
    },
  },
  {
    name: 'restore_component',
    title: 'Restore a deleted component',
    description:
      'Bring back a component that delete_component removed (get_canvas lists those still in use under deletedComponents). Its instances were never changed, so they are linked again as they are, and it is back in the catalog. Its main is the markup that still carries it; if that is gone, a new main is written on the Components page from the kept definition. If its name was given to another component meanwhile it comes back as “<name> (restored)”. Instances that were detached stay plain markup.',
    readOnly: false,
    shape: { component: COMPONENT_REF.describe('Name or id of the deleted component') },
    async run({ component }, { canvas, actor }) {
      const restored = await runCanvasWrite(canvas.id, {
        type: 'restore-component',
        component: String(component),
        actor,
        view: true,
      })
      const { component: def, main } = restored
      const view = viewOr(canvas, def, restored.view)
      return {
        data: { ok: true, component: view.entry, main, main_frame_id: def.mainFrameId },
        note:
          main === 'written'
            ? 'Its old main was gone, so a new one was written on the Components page (main_frame_id).'
            : 'Its instances follow it again.',
        frames: view.frames,
        changed: [changeOf(def, view.frames)],
      }
    },
  },
  {
    name: 'restore_component_version',
    title: 'Restore a component revision',
    description:
      'Put a component back to an earlier revision (listed by get_component) and carry that to every instance in the background, keeping their props and overrides. It is a new revision, so this can be undone too.',
    readOnly: false,
    destructive: true,
    shape: { component: COMPONENT_REF, rev: z.number() },
    async run({ component, rev }, { canvas, actor }) {
      const { view: written, ...result } = await runCanvasWrite(canvas.id, {
        type: 'restore-component-version',
        component: String(component),
        rev: Number(rev),
        actor,
        view: true,
      })
      const view = viewOr(canvas, result.component, written)
      const note = propagationNote(result).join('\n')
      return {
        data: { ok: true, ...result, component: view.entry, rev: result.component.rev },
        ...(note ? { note } : {}),
        frames: view.frames,
        changed: [changeOf(result.component, view.frames)],
      }
    },
  },
  {
    name: 'import_component',
    title: 'Import a component from a library',
    description:
      'Add a component, and whatever it is built from, from another canvas. From a workspace library (list_components → workspace_libraries) it is linked to what that library published and has no main here: change it on the library canvas. Writing <doop-use> with its name does the same without this call; use this when two libraries publish the same name. From any other canvas this account can read (list_components with libraries=true) it is copied with a main of its own. Either way a later change at the origin shows up as library_update_available and arrives only when sync_component pulls it, so publishing alone never changes this canvas.',
    readOnly: false,
    shape: {
      source_canvas_id: z.string().describe('The library canvas'),
      component: COMPONENT_REF,
    },
    async run({ source_canvas_id, component }, { canvas, actor, canRead }) {
      const source = String(source_canvas_id)
      /* a workspace library goes by the canvas, like its fonts: whoever may edit here may use it */
      const shared = librariesForCanvas(canvas).some((library) => library.canvasId === source)
      if (!shared && !canRead(source)) throw new ComponentError('this account cannot read that canvas')
      const before = componentsStamp(canvas.id)
      const { component: def, view } = await runCanvasWrite(canvas.id, {
        type: 'import-component',
        from: source,
        component: String(component),
        actor,
        view: true,
      })
      const shown = viewOr(canvas, def, view)
      return {
        data: { ok: true, component: shown.entry },
        note: `Use it with ${usageExample(def)}.`,
        /* a copy has a main of its own to look at; a linked one shows nowhere here yet. Importing
           what the canvas already has adds nothing, and is no change */
        changed: componentsStamp(canvas.id) === before ? [] : [changeOf(def, shown.frames)],
      }
    },
  },
  {
    name: 'sync_component',
    title: 'Pull a library update',
    description:
      "Bring an imported component up to what its library last published (or, for a copy from another canvas, that canvas's current revision), carrying it to every instance here. Without component, pulls every workspace-library update waiting on this canvas in one call. Instance overrides are kept; edits made to a copied main are replaced. Approved frames keep their sign-off. It works on one canvas: after publish_library, call it on each canvas listed in that result's used_by, or use update_library_everywhere on the library canvas when the human wants every canvas updated at once.",
    readOnly: false,
    destructive: true,
    shape: {
      component: COMPONENT_REF.optional().describe('Component name or id; omit for every waiting library update'),
    },
    async run({ component }, { canvas, actor, canRead }) {
      if (component === undefined || component === '') {
        const result = await runCanvasWrite(canvas.id, {
          type: 'sync-library-updates',
          readable: readableSources(canvas.id, canRead),
          actor,
          view: true,
        })
        return {
          data: { ok: true, updated: result.updated.length > 0, components: result.updated.map((def) => def.name) },
          ...(result.waiting ? {} : { note: 'No workspace-library update is waiting on this canvas.' }),
          frames: result.frames ?? [],
          changed: result.updated.map((def) => changeOf(def, outcomeFrames({ canvas } as ToolContext, def))),
        }
      }
      const ref = String(component)
      const { view, ...result } = await runCanvasWrite(canvas.id, {
        type: 'sync-component',
        component: ref,
        readable: readableSources(canvas.id, canRead),
        actor,
        view: true,
      })
      const shown = viewOr(canvas, result.component, view)
      return {
        data: { ok: true, updated: result.updated, component: shown.entry },
        frames: result.updated ? shown.frames : [],
        changed: result.updated ? [changeOf(result.component, shown.frames)] : [],
      }
    },
  },
  {
    name: 'publish_library',
    title: 'Publish components to the workspace library',
    description:
      "Share this canvas's components with every canvas in its workspace. Publishing snapshots them: other canvases use the published state, never work in progress, and a canvas already using one sees library_update_available and pulls it when it chooses, so publishing changes no other canvas by itself. The result's used_by lists the canvases using this library and which components each still has to pull (sync_component there, or update_library_everywhere when the human asks for the change on every canvas). Without components, everything this canvas owns is published; with them, only those (each with what it is built from). unpublish=true stops sharing instead (the named components, or all); canvases using them keep their definition and every instance. Publish when the human asks for it in any words (make this available to the team, share it with our other canvases), not on your own initiative: it is how a team's design system reaches their other canvases. Needs a canvas in a workspace on the Team plan, and a workspace can keep publishing to its owner and admins; when it is refused for either reason, tell the human rather than working around it.",
    readOnly: false,
    shape: {
      components: z.array(z.string()).optional().describe('Component names or ids; omit for all'),
      unpublish: z.boolean().optional().describe('Stop sharing instead of publishing'),
    },
    run({ components, unpublish }, { canvas, actor, canRead, userId }) {
      const refs = Array.isArray(components) && components.length ? components.map(String) : undefined
      /* other canvases by name: only the ones this account can open */
      const usedBy = () => libraryConsumers(canvas).filter((consumer) => canRead(consumer.canvas_id))
      if (unpublish === true) {
        const result = unpublishFromLibrary(canvas.id, refs, actor, userId)
        return { data: { ok: true, unpublished: result.unpublished, is_library: result.library.library } }
      }
      const result = publishToLibrary(canvas.id, refs, actor, userId)
      const unpublished = result.library.changes.filter((entry) => entry.change !== 'unchanged')
      return {
        data: {
          ok: true,
          published: result.published,
          removed: result.removed,
          /* whether this canvas shares anything with its workspace right now */
          is_library: result.library.library,
          still_unpublished: unpublished.map((entry) => entry.name),
          used_by: usedBy(),
        },
        note: 'Published. Canvases in used_by with update_waiting keep the previous version until sync_component is called on each. Only when the human asks for the change everywhere: update_library_everywhere.',
      }
    },
  },
  {
    name: 'update_library_everywhere',
    title: 'Update every canvas using this library',
    description:
      "Pull this library canvas's latest publication into every canvas of the workspace that uses it, in one call: what sync_component does on one canvas, done on all of them. Use it ONLY when the human asks for the change everywhere / across all canvases, never as a follow-up to publish_library on your own initiative: it changes other people's canvases (approved frames keep their sign-off). Ask the human before running it. It applies what is published, so publish_library comes first (its used_by shows which canvases are waiting). The result reports per canvas which components were updated, how many frames changed (approvals_withdrawn is always 0: approved frames keep their sign-off); skipped lists canvases this account may not edit, or where the pull was refused, and each of those still needs sync_component by someone who can. Relay the report to the human.",
    readOnly: false,
    destructive: true,
    shape: {},
    async run(_input, { canvas, actor, canEdit, canRead, userId }) {
      const report = await updateLibraryConsumers(canvas.id, actor, {
        canEdit,
        canRead,
        publisherId: userId,
      })
      const count = report.canvases.length
      return {
        data: { ok: true, ...report },
        note:
          count + report.skipped.length === 0
            ? 'Every canvas using this library already has its latest publication. Changes made here since then reach nobody until publish_library.'
            : `Updated ${count} canvas${count === 1 ? '' : 'es'}; frames_changed counts the frames on each that now show the update (they follow their components: no frame was edited). Tell the human which canvases changed${report.skipped.length ? ', and which were skipped and why' : ''}.`,
      }
    },
  },
]

export const COMPONENT_TOOL_NAMES = COMPONENT_TOOLS.map((tool) => tool.name)

/** Every string a call submits (markup, css, find/replace, prop values), for the base64 check. */
function submittedText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(submittedText).join('\n')
  if (value && typeof value === 'object') return Object.values(value).map(submittedText).join('\n')
  return ''
}

/** What the call's targets already hold: the component (its stored template, styles and head, and
 *  its main frame) and the frame it writes to. Carrying those over is not a new upload. */
function currentMarkup(input: Record<string, unknown>, context: ToolContext): string {
  const parts: string[] = []
  const html = (frameId: unknown) => {
    if (typeof frameId !== 'string') return
    try {
      const frame = store.getFrame(frameId)
      if (frame?.canvasId === context.canvas.id) parts.push(frame.html)
    } catch {
      /* not loaded: nothing to compare against */
    }
  }
  if (typeof input.component === 'string') {
    const def = findComponent(context.canvas.id, input.component)
    if (def) {
      parts.push(def.template, def.css, def.rawCss, ...def.head)
      html(def.mainFrameId)
    }
  }
  html(input.frame_id)
  return parts.join('\n')
}

/** Run a tool's handler, turning a ComponentError into a message the agent can act on. */
export async function runComponentTool(
  name: string,
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<{ ok: true; result: ToolResult } | { ok: false; error: string }> {
  const tool = COMPONENT_TOOLS.find((candidate) => candidate.name === name)
  if (!tool) return { ok: false, error: `unknown tool ${name}` }
  const inline = inlineDataRefusal(submittedText(input), currentMarkup(input, context), context.surface)
  if (inline) return { ok: false, error: inline }
  try {
    /* one unit (server/journal.ts): a refusal comes back as this call's error, not as a
       throw out of the operation, so what the tool had changed is undone here. Awaited
       inside, so an async tool's ComponentError is caught like any other */
    return { ok: true, result: await transaction(() => tool.run(input, context)) }
  } catch (error) {
    if (error instanceof ComponentError || error instanceof WorkBudgetError || error instanceof WriteRefusedError)
      return { ok: false, error: error.message }
    throw error
  }
}

/** The usage event a library tool call counts as, if it did something: MCP and
 *  the resident agent report it on the person the agent works for. */
export function libraryFeatureEvent(name: string, input: Record<string, unknown>, data: unknown): string | undefined {
  const result = (data ?? {}) as { updated?: boolean; component?: { library?: unknown }; components?: string[] }
  if (name === 'publish_library') return input.unpublish === true ? undefined : 'library_published'
  if (name === 'sync_component')
    return result.updated && result.component?.library ? 'library_update_pulled' : undefined
  if (name === 'import_component') return result.component?.library ? 'library_component_used' : undefined
  if (name === 'update_library_everywhere') return 'library_updated_everywhere'
  return undefined
}

/** What an agent should hear after writing a frame: what could not be done with its components and,
 *  for a whole-frame write (`review`: create, replace, a finished stream), what it should have reused:
 *  a screen using none of the canvas's components, blocks repeated by hand, colours the canvas has as tokens. */
export function componentWriteNotes(frame: Frame, { review = false }: { review?: boolean } = {}): string[] {
  const notes = actions.takeComponentIssues(frame.id).map((issue) => `COMPONENT: ${issue.message}`)
  const canvas = review ? store.getCanvas(frame.canvasId) : undefined
  if (canvas) notes.push(...(optional(() => frameReuseNotes(canvas, frame)) ?? []))
  return notes
}

/** Frames whose stream has already heard the component-system note: said once, not per chunk. */
const toldThisStream = new Set<string>()
const SYSTEM_NOTE = 'COMPONENT SYSTEM:'

/** The notes one chunk of a stream hears. Mid-stream, only the component-system note, the first
 *  time the screen's markup shows it is being drawn without components (the agent can still change
 *  course); the last chunk hears the whole review, without that note again. */
export function streamChunkNotes(frame: Frame, { start, done }: { start?: boolean; done?: boolean }): string[] {
  if (start) toldThisStream.delete(frame.id)
  const told = toldThisStream.has(frame.id)
  if (done) {
    toldThisStream.delete(frame.id)
    const notes = componentWriteNotes(frame, { review: true })
    return told ? notes.filter((note) => !note.startsWith(SYSTEM_NOTE)) : notes
  }
  if (told) return []
  const canvas = store.getCanvas(frame.canvasId)
  const notes = canvas ? (optional(() => componentSystemNotes(canvas, frame)) ?? []) : []
  if (notes.length) toldThisStream.add(frame.id)
  return notes
}
