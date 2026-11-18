import { z } from 'zod'
import { activeComponents, PROP_TYPES, USE_TAG, type ComponentDef } from '../shared/components.ts'
import type { Actor, Canvas, Frame } from '../shared/types.ts'
import {
  catalog,
  catalogEntry,
  changeInstances,
  componentDetail,
  ComponentError,
  createComponentFromElement,
  createComponentFromHtml,
  deleteComponent,
  detachAllInstances,
  findComponent,
  findDeletedComponent,
  importableEntry,
  importComponent,
  insertInstance,
  instancesIn,
  libraryCatalog,
  libraryConsumers,
  lookalikesIn,
  publishToLibrary,
  restoreComponent,
  restoreComponentVersion,
  syncComponent,
  unpublishFromLibrary,
  updateComponent,
  updateLibraryConsumers,
  usageExample,
  usageOf,
  waitingLibraryUpdates,
} from './componentActions.ts'
import { isLibrary, librariesForCanvas } from './componentLibrary.ts'
import * as actions from './actions.ts'
import { componentReuseNotes, componentSystemNotes, frameReuseNotes } from './reuseNotes.ts'
import { store } from './store.ts'
import { inlineDataRefusal, type Surface } from './inlineData.ts'
import { optional, WorkBudgetError } from './workBudget.ts'
import { transaction } from './journal.ts'

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

export type ToolResult = { data: unknown; note?: string; frames?: Frame[] }

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

/** The components a new main names in a <doop-use> that resolved to nothing, by the name it gave. */
function missingNested(def: ComponentDef): string[] {
  if (!def.mainFrameId) return []
  const refs = actions
    .peekComponentIssues(def.mainFrameId)
    .filter((issue) => issue.code === 'unknown_component')
    .map((issue) => /“([^”]*)”/.exec(issue.message)?.[1] ?? '')
  return [...new Set(refs)]
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
      `Instances are updating in the background: queued for ${count} (impact.frames). get_frame and get_frame_screenshot wait a moment for it; on a large canvas the last frames can take longer.`,
    ]
  if (status === 'deferred')
    return [
      `This server has component propagation switched off for now: the ${count} in impact.frames keep the previous revision until each is next written.`,
    ]
  return []
}

function summary(canvas: Canvas, def: ComponentDef) {
  return catalogEntry(canvas, def)
}

/** The frames a component write touched: every instance's frame and the main's,
 *  so a resident run counts the work and re-checks what it had verified. */
function outcomeFrames(context: ToolContext, def: ComponentDef, extra: string[] = []): Frame[] {
  const ids = new Set([...usageOf(context.canvas, def.id).frames.map((f) => f.id), ...extra])
  if (def.mainFrameId) ids.add(def.mainFrameId)
  return context.canvas.frames.filter((frame) => ids.has(frame.id))
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
      'Make a reusable component from new markup (html + css) or from an element already in a frame (frame_id + element). From markup, the main lands on the canvas\'s Components page and no instance is placed anywhere: to use it, write <doop-use component="…"> in a frame\'s HTML or call insert_instance. From an element (its data-doop-id from get_frame), that element stays where it is and becomes the main; pass replace_matching=true to turn every other element of the same shape on the canvas into a linked instance in one go, differing text and links becoming props. Unless the markup already says otherwise, leaf text, image sources and link targets become props, named after what each element is (title, label, image, link, text) or its class; the result lists them. Name your own with data-doop-prop="label" (text), data-doop-prop="src:photo" (an image; on an <img> a bare name binds its src too), data-doop-prop="href:link,--accent:accent" (attributes, custom properties), data-doop-if="tone=ghost" or "show-icon" (conditional elements), data-doop-slot="actions" (content each instance supplies, add data-doop-slot-suggest="Button"). An enum prop in props sets data-<name> on the root, so variants are plain CSS: .btn[data-tone="ghost"] { … }. Give it a description saying when to use it: it is how the next agent knows.',
    readOnly: false,
    shape: {
      name: z.string().describe('Short and unique, e.g. "Button", "Pricing Card"'),
      description: z.string().optional().describe('When to use this. Later agents choose by it'),
      frame_id: z.string().optional().describe('With element: make this existing element the main'),
      element: z.string().optional().describe("The element's data-doop-id from get_frame"),
      replace_matching: z
        .boolean()
        .optional()
        .describe('With frame_id: turn same-shaped elements across the canvas into instances'),
      html: z.string().optional().describe('New markup, one root element'),
      css: z.string().optional().describe('With html: the rules it needs, unscoped; they get scoped for you'),
      width: z.number().optional().describe('With html: the main frame width, default 480'),
      height: z.number().optional().describe('With html: the main frame height, default 240'),
      props: z.array(propSchema).optional().describe('Enum props, and metadata for bound ones'),
      auto_props: z.boolean().optional().describe('false = do not infer props'),
      code: codeSchema.optional(),
    },
    run(input, { canvas, actor }) {
      const shared = {
        name: String(input.name ?? ''),
        description: input.description as string | undefined,
        props: input.props as never,
        code: input.code as never,
        autoProps: input.auto_props as boolean | undefined,
      }
      if (typeof input.html === 'string') {
        const { component: def, inferred } = createComponentFromHtml(
          canvas.id,
          {
            ...shared,
            html: input.html,
            css: input.css as string | undefined,
            width: input.width as number | undefined,
            height: input.height as number | undefined,
          },
          actor,
        )
        return {
          data: {
            ok: true,
            component: summary(canvas, def),
            main_frame_id: def.mainFrameId,
            ...inferredProps(inferred),
          },
          note: [
            `The main is frame main_frame_id on the Components page. No instance was placed: to use it, write ${usageExample(def)} in a frame's HTML, or call insert_instance. Call get_frame_screenshot on main_frame_id, and resize that frame to fit with update_frame.${inferredNote(inferred)}`,
            ...(optional(() => componentReuseNotes(canvas, def, shared.autoProps)) ?? []),
          ].join('\n'),
          frames: outcomeFrames({ canvas } as ToolContext, def),
        }
      }
      if (typeof input.frame_id !== 'string' || typeof input.element !== 'string')
        throw new ComponentError('pass html, or frame_id with element')
      const { component, converted, inferred, matching_stopped } = createComponentFromElement(
        canvas.id,
        {
          ...shared,
          frameId: input.frame_id,
          element: input.element,
          replaceMatching: input.replace_matching as boolean | undefined,
        },
        actor,
      )
      return {
        data: {
          ok: true,
          component: summary(canvas, component),
          main_frame_id: component.mainFrameId,
          converted,
          ...(matching_stopped ? { matching_stopped } : {}),
          ...inferredProps(inferred),
        },
        note: [
          `Use it with ${usageExample(component)}.${inferredNote(inferred)}`,
          ...(matching_stopped
            ? [
                'replace_matching stopped part of the way (the work budget for one call): the frames in `converted` are linked, later frames were not looked at and their copies stay plain markup.',
              ]
            : []),
          ...(optional(() => componentReuseNotes(canvas, component, shared.autoProps)) ?? []),
        ].join('\n'),
        frames: outcomeFrames(
          { canvas } as ToolContext,
          component,
          converted.map((entry) => entry.frameId),
        ),
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
    run(input, { canvas, actor }) {
      const entries = (Array.isArray(input.components) ? input.components : []) as Record<string, unknown>[]
      if (!entries.length) throw new ComponentError('pass at least one component')
      if (entries.length > MAX_BATCH_COMPONENTS)
        throw new ComponentError(`at most ${MAX_BATCH_COMPONENTS} components per call; send the rest in another call`)
      const made: ComponentDef[] = []
      const refused: string[] = []
      const notes: string[] = []
      const results = entries.map((entry, index) => {
        const name = String(entry.name ?? '')
        try {
          /* each entry is its own unit: a refused one leaves nothing behind and the rest go on */
          const { component: def, inferred } = transaction(() => {
            const created = createComponentFromHtml(
              canvas.id,
              {
                name,
                description: entry.description as string | undefined,
                props: entry.props as never,
                code: entry.code as never,
                autoProps: entry.auto_props as boolean | undefined,
                html: String(entry.html ?? ''),
                css: entry.css as string | undefined,
                width: entry.width as number | undefined,
                height: entry.height as number | undefined,
              },
              actor,
            )
            /* a <doop-use> naming nothing renders as nothing: saved, the entry would lose that part for
               good, so it is refused (undone with this unit) and can be sent again once that one exists */
            const missing = missingNested(created.component)
            if (missing.length)
              throw new ComponentError(
                `it nests ${missing.map((ref) => (ref ? `“${ref}”` : 'a <doop-use> that could not be read')).join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not a component on this canvas${refused.length ? ' (an entry this call refused, or one never made)' : ''}; nothing was made for it`,
              )
            return created
          })
          made.push(def)
          notes.push(
            ...(optional(() => componentReuseNotes(canvas, def, entry.auto_props as boolean | undefined)) ?? []),
          )
          return {
            index,
            ok: true as const,
            component: summary(canvas, def),
            main_frame_id: def.mainFrameId,
            ...inferredProps(inferred),
          }
        } catch (error) {
          /* a refusal is this entry's; a spent work budget refuses the whole call (runComponentTool) */
          if (!(error instanceof ComponentError)) throw error
          refused.push(name)
          return { index, ok: false as const, name, error: error.message }
        }
      })
      const failed = results.filter((result) => !result.ok)
      const usage = made.map((def) => usageExample(def)).join('\n')
      return {
        data: { ok: failed.length === 0, created: made.length, failed: failed.length, results },
        note: [
          made.length
            ? `Made ${made.length} component${made.length === 1 ? '' : 's'} on the Components page. No instance was placed: compose screens from them with\n${usage}\nCall get_frame_screenshot on a main_frame_id or two, and resize a main to fit with update_frame. Props each one inferred are in its inferred_props.`
            : 'Nothing was made.',
          ...(failed.length
            ? [
                `${failed.length} entr${failed.length === 1 ? 'y was' : 'ies were'} refused (see results): fix ${failed.length === 1 ? 'it' : 'them'} and send ${failed.length === 1 ? 'it' : 'them'} again. An entry that nests a refused one is refused too.`,
              ]
            : []),
          ...notes,
        ].join('\n'),
        frames: made.flatMap((def) => outcomeFrames({ canvas } as ToolContext, def)),
      }
    },
  },
  {
    name: 'update_component',
    title: 'Update a component',
    description:
      "Change a component's main; every instance on the canvas follows in the background within moments, keeping its props and overrides, so this is how a sweeping design change is one call rather than one edit per screen. Small changes to the markup: find + replace on the template (from get_component). CSS is not searched: to change a style, pass the whole stylesheet as css. Rewrites: html, keeping data-doop-part attributes where you can so overrides stay attached. The result reports the impact: which frames hold instances and are queued to follow (propagation), how many of them are approved (they keep their sign-off), which overrides no longer have an element to apply to. Pass dry_run=true to read that report first, which you should for a component with many instances. A changed main is one undo-able revision: restore_component_version goes back.",
    readOnly: false,
    destructive: true,
    shape: {
      component: COMPONENT_REF,
      find: z.string().optional().describe('Exact text in the template; must occur once'),
      replace: z.string().optional(),
      html: z.string().optional().describe('New template markup, one root element'),
      css: z
        .string()
        .optional()
        .describe('The rules the template needs, unscoped; replaces what this tool wrote before'),
      name: z.string().optional(),
      description: z.string().optional(),
      props: z.array(propSchema).optional().describe('Full replacement of the prop metadata'),
      code: codeSchema.optional(),
      expected_rev: z.number().optional().describe('Refuse if the component has moved past this revision'),
      dry_run: z.boolean().optional().describe('Report the impact and change nothing'),
    },
    run(input, { canvas, actor, canRead }) {
      const result = updateComponent(
        canvas.id,
        String(input.component),
        {
          ...(input.find !== undefined ? { find: String(input.find), replace: String(input.replace ?? '') } : {}),
          ...(input.html !== undefined ? { html: String(input.html) } : {}),
          ...(input.css !== undefined ? { css: String(input.css) } : {}),
          ...(input.name !== undefined ? { name: String(input.name) } : {}),
          ...(input.description !== undefined ? { description: String(input.description) } : {}),
          ...(input.props !== undefined ? { props: input.props as never } : {}),
          ...(input.code !== undefined ? { code: input.code as never } : {}),
          ...(input.expected_rev !== undefined ? { expectedRev: Number(input.expected_rev) } : {}),
          dryRun: input.dry_run === true,
        },
        actor,
      )
      /* on a library canvas the impact above counts this canvas alone: say who else follows it */
      const shared = isLibrary(canvas.id)
        ? libraryConsumers(canvas).filter((consumer) => canRead(consumer.canvas_id))
        : []
      return {
        data: {
          ok: true,
          ...result,
          component: summary(canvas, result.component),
          rev: result.component.rev,
          ...(shared.length ? { library_used_by: shared } : {}),
        },
        ...(result.dry_run
          ? shared.length
            ? {
                note: 'The impact counts this canvas only. It is a workspace library: the canvases in library_used_by get this change once it is published (publish_library) and each pulls it (sync_component).',
              }
            : {}
          : {
              note: [
                ...propagationNote(result),
                isLibrary(canvas.id) ? `${IMPACT_NOTE} ${LIBRARY_NOTE}` : IMPACT_NOTE,
                ...(optional(() => componentReuseNotes(canvas, result.component)) ?? []),
              ].join('\n'),
              frames: outcomeFrames({ canvas } as ToolContext, result.component),
            }),
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
    run({ component, detach_instances }, { canvas, actor }) {
      const ref = String(component)
      const pending = findDeletedComponent(canvas.id, ref)
      /* detaching what an earlier delete left behind is the same call again */
      const result =
        pending && detach_instances === true
          ? { deleted: pending.name, component_id: pending.id, already_deleted: true }
          : deleteComponent(canvas.id, ref, actor)
      const detach = detach_instances === true ? detachAllInstances(canvas.id, result.component_id, actor) : undefined
      const touched = detach?.queued ? usageOf(canvas, result.component_id).frames.map((frame) => frame.id) : []
      return {
        data: { ok: true, ...result, ...(detach ? { detach } : {}) },
        note: detach
          ? detach.queued
            ? `Detaching ${detach.instances} instance${detach.instances === 1 ? '' : 's'} in ${detach.frames} frame${detach.frames === 1 ? '' : 's'} in the background, a frame at a time: they become plain markup that keeps its look. This is not undone by restore_component.`
            : 'Nothing on the canvas uses it, so there was nothing to detach.'
          : 'No frame was changed: its instances look the same and no longer follow it. restore_component brings it back; delete_component with detach_instances=true turns what is left into plain markup.',
        frames: canvas.frames.filter((frame) => touched.includes(frame.id)),
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
    run({ component }, { canvas, actor }) {
      const { component: def, main } = restoreComponent(canvas.id, String(component), actor)
      return {
        data: { ok: true, component: summary(canvas, def), main, main_frame_id: def.mainFrameId },
        note:
          main === 'written'
            ? 'Its old main was gone, so a new one was written on the Components page (main_frame_id).'
            : 'Its instances follow it again.',
        frames: outcomeFrames({ canvas } as ToolContext, def),
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
    run({ component, rev }, { canvas, actor }) {
      const result = restoreComponentVersion(canvas.id, String(component), Number(rev), actor)
      const note = propagationNote(result).join('\n')
      return {
        data: { ok: true, ...result, component: summary(canvas, result.component), rev: result.component.rev },
        ...(note ? { note } : {}),
        frames: outcomeFrames({ canvas } as ToolContext, result.component),
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
    run({ source_canvas_id, component }, { canvas, actor, canRead }) {
      const source = String(source_canvas_id)
      /* a workspace library goes by the canvas, like its fonts: whoever may edit here may use it */
      const shared = librariesForCanvas(canvas).some((library) => library.canvasId === source)
      if (!shared && !canRead(source)) throw new ComponentError('this account cannot read that canvas')
      const def = importComponent(canvas.id, source, String(component), actor)
      return { data: { ok: true, component: summary(canvas, def) }, note: `Use it with ${usageExample(def)}.` }
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
    run({ component }, { canvas, actor, canRead }) {
      if (component === undefined || component === '') {
        const waiting = waitingLibraryUpdates(canvas)
        const frames = new Map<string, Frame>()
        const updated: string[] = []
        for (const def of waiting) {
          const result = syncComponent(canvas.id, def.id, actor, canRead)
          if (!result.updated) continue
          updated.push(result.component.name)
          for (const frame of outcomeFrames({ canvas } as ToolContext, result.component)) frames.set(frame.id, frame)
        }
        return {
          data: { ok: true, updated: updated.length > 0, components: updated },
          ...(waiting.length ? {} : { note: 'No workspace-library update is waiting on this canvas.' }),
          frames: [...frames.values()],
        }
      }
      const result = syncComponent(canvas.id, String(component), actor, canRead)
      return {
        data: { ok: true, updated: result.updated, component: summary(canvas, result.component) },
        frames: result.updated ? outcomeFrames({ canvas } as ToolContext, result.component) : [],
      }
    },
  },
  {
    name: 'publish_library',
    title: 'Publish components to the workspace library',
    description:
      "Share this canvas's components with every canvas in its workspace. Publishing snapshots them: other canvases use the published state, never work in progress, and a canvas already using one sees library_update_available and pulls it when it chooses, so publishing changes no other canvas by itself. The result's used_by lists the canvases using this library and which components each still has to pull (sync_component there, or update_library_everywhere when the human asks for the change on every canvas). Without components, everything this canvas owns is published; with them, only those (each with what it is built from). dry_run=true lists what would be published or removed. unpublish=true stops sharing instead (the named components, or all); canvases using them keep their definition and every instance. Publish when the human asks for it in any words (make this available to the team, share it with our other canvases), not on your own initiative: it is how a team's design system reaches their other canvases. Needs a canvas in a workspace on the Team plan, and a workspace can keep publishing to its owner and admins; when it is refused for either reason, tell the human rather than working around it.",
    readOnly: false,
    shape: {
      components: z.array(z.string()).optional().describe('Component names or ids; omit for all'),
      dry_run: z.boolean().optional().describe('Report what would change and publish nothing'),
      unpublish: z.boolean().optional().describe('Stop sharing instead of publishing'),
    },
    run({ components, dry_run, unpublish }, { canvas, actor, canRead, userId }) {
      const refs = Array.isArray(components) && components.length ? components.map(String) : undefined
      /* other canvases by name: only the ones this account can open */
      const usedBy = () => libraryConsumers(canvas).filter((consumer) => canRead(consumer.canvas_id))
      if (unpublish === true) {
        const result = unpublishFromLibrary(canvas.id, refs, actor, userId)
        return { data: { ok: true, unpublished: result.unpublished, is_library: result.library.library } }
      }
      const result = publishToLibrary(canvas.id, refs, actor, userId, dry_run === true)
      const unpublished = result.library.changes.filter((entry) => entry.change !== 'unchanged')
      return {
        data: {
          ok: true,
          dry_run: result.dry_run,
          published: result.published,
          removed: result.removed,
          /* whether this canvas shares anything with its workspace right now */
          is_library: result.library.library,
          ...(result.dry_run ? {} : { still_unpublished: unpublished.map((entry) => entry.name) }),
          used_by: usedBy(),
        },
        note: result.dry_run
          ? 'Dry run: nothing was published. `published` and `removed` are what a real call would do.'
          : 'Published. Canvases in used_by with update_waiting keep the previous version until sync_component is called on each. Only when the human asks for the change everywhere: update_library_everywhere.',
      }
    },
  },
  {
    name: 'update_library_everywhere',
    title: 'Update every canvas using this library',
    description:
      "Pull this library canvas's latest publication into every canvas of the workspace that uses it, in one call: what sync_component does on one canvas, done on all of them. Use it ONLY when the human asks for the change everywhere / across all canvases, never as a follow-up to publish_library on your own initiative: it changes other people's canvases (approved frames keep their sign-off). Run it with dry_run=true first and tell the human what it would touch. It applies what is published, so publish_library comes first (its used_by shows which canvases are waiting). The result reports per canvas which components were updated, how many frames changed (approvals_withdrawn is always 0: approved frames keep their sign-off); skipped lists canvases this account may not edit, or where the pull was refused, and each of those still needs sync_component by someone who can. Relay the report to the human.",
    readOnly: false,
    destructive: true,
    shape: {
      dry_run: z.boolean().optional().describe('Report what would change on each canvas and change nothing'),
    },
    async run({ dry_run }, { canvas, actor, canEdit, canRead, userId }) {
      const report = await updateLibraryConsumers(canvas.id, actor, {
        dryRun: dry_run === true,
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
            : report.dry_run
              ? 'Dry run: nothing was changed. frames_changed counts the frames holding an instance of what would update; approved frames keep their sign-off. Tell the human before running it for real.'
              : `Updated ${count} canvas${count === 1 ? '' : 'es'}. Tell the human which canvases changed${report.skipped.length ? ', and which were skipped and why' : ''}.`,
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
    if (error instanceof ComponentError || error instanceof WorkBudgetError) return { ok: false, error: error.message }
    throw error
  }
}

/** The usage event a library tool call counts as, if it did something: MCP and
 *  the resident agent report it on the person the agent works for. */
export function libraryFeatureEvent(name: string, input: Record<string, unknown>, data: unknown): string | undefined {
  const result = (data ?? {}) as { updated?: boolean; component?: { library?: unknown }; components?: string[] }
  if (name === 'publish_library')
    return input.dry_run === true || input.unpublish === true ? undefined : 'library_published'
  if (name === 'sync_component')
    return result.updated && result.component?.library ? 'library_update_pulled' : undefined
  if (name === 'import_component') return result.component?.library ? 'library_component_used' : undefined
  if (name === 'update_library_everywhere') return input.dry_run === true ? undefined : 'library_updated_everywhere'
  return undefined
}

/** What an agent should hear after writing a frame: what could not be done, and components it redrew by hand.
 *  `review` is a whole-frame write (create, replace, a finished stream), which also hears what it should
 *  have reused: blocks repeated by hand and colours the canvas has as tokens. */
export function componentWriteNotes(frame: Frame, { review = false }: { review?: boolean } = {}): string[] {
  const notes = actions.takeComponentIssues(frame.id).map((issue) => `COMPONENT: ${issue.message}`)
  const canvas = review ? store.getCanvas(frame.canvasId) : undefined
  if (canvas) notes.push(...(optional(() => frameReuseNotes(canvas, frame)) ?? []))
  /* said after a write that has landed: when the budget is spent, the note is simply not made */
  for (const lookalike of optional(() => lookalikesIn(frame)) ?? []) {
    notes.push(
      `COMPONENT: ${lookalike.occurrences} element${lookalike.occurrences === 1 ? '' : 's'} in this frame match${lookalike.occurrences === 1 ? 'es' : ''} “${lookalike.component}” but ${lookalike.occurrences === 1 ? 'is' : 'are'} not linked to it, so ${lookalike.occurrences === 1 ? 'it' : 'they'} will not follow changes. Use ${lookalike.usage} instead.`,
    )
  }
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
