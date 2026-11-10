import { z } from 'zod'
import { PROP_TYPES, USE_TAG, type ComponentDef } from '../shared/components.ts'
import type { Actor, Canvas, Frame } from '../shared/types.ts'
import {
  catalogEntry,
  changeInstances,
  componentDetail,
  ComponentError,
  createComponentFromElement,
  createComponentFromHtml,
  deleteComponent,
  findComponent,
  findComponentCandidates,
  importComponent,
  insertInstance,
  instancesIn,
  lookalikesIn,
  restoreComponentVersion,
  syncComponent,
  updateComponent,
  usageExample,
  usageOf,
} from './componentActions.ts'
import * as actions from './actions.ts'

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
  /** canvases this account can read, for the library listing */
  readableCanvases: () => Canvas[]
}

export type ToolResult = { data: unknown; note?: string; frames?: Frame[] }

interface ComponentTool {
  name: string
  title: string
  description: string
  readOnly: boolean
  destructive?: boolean
  shape: z.ZodRawShape
  run(input: Record<string, unknown>, context: ToolContext): ToolResult
}

const COMPONENT_REF = z.string().describe('Component name or id')
const FRAME_ID = z.string().describe('Frame id from get_canvas')
const IMPACT_NOTE =
  'Check one affected frame with get_frame_screenshot. Sign-off on approved frames that changed is withdrawn, as with any edit.'

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

export const COMPONENT_TOOLS: ComponentTool[] = [
  {
    name: 'list_components',
    title: 'List components',
    description:
      'List the reusable components on a canvas: each name, its props and slots as a one-line signature, a ready-to-paste <doop-use> and how often it is used. Check this BEFORE writing markup: anything on this list must be used through <doop-use>, never redrawn. With libraries=true, also lists components on other canvases this account can read, ready for import_component.',
    readOnly: true,
    shape: {
      query: z.string().optional().describe('Only components whose name or description contains this'),
      libraries: z.boolean().optional().describe('Also list importable components from other canvases'),
    },
    run({ query, libraries }, { canvas, readableCanvases }) {
      const wanted = typeof query === 'string' ? query.toLowerCase() : ''
      const matches = (def: ComponentDef) =>
        !wanted || def.name.toLowerCase().includes(wanted) || def.description.toLowerCase().includes(wanted)
      const components = (canvas.components ?? []).filter(matches).map((def) => summary(canvas, def))
      return {
        data: {
          components,
          ...(libraries
            ? {
                libraries: readableCanvases()
                  .filter((other) => other.id !== canvas.id && other.components?.length)
                  .map((other) => ({
                    canvas_id: other.id,
                    canvas_name: other.name,
                    components: (other.components ?? []).filter(matches).map((def) => summary(other, def)),
                  })),
              }
            : {}),
          ...(components.length
            ? {}
            : {
                note: 'No components match. If a block repeats, find_component_candidates shows what is worth making one.',
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
      'Make a reusable component, one of two ways. From an element already in a frame (frame_id + element: a data-doop-id, or the element of a find_component_candidates result): that element stays where it is and becomes the main; pass replace_matching=true to turn every other element of the same shape on the canvas into a linked instance in one go, differing text and links becoming props. From new markup (html + css): the main lands on the canvas\'s Components page. Unless the markup already says otherwise, leaf text, image sources and link targets become props; mark your own with data-doop-prop="label" (text), data-doop-prop="href:link,--accent:accent" (attributes, custom properties), data-doop-if="tone=ghost" or "show-icon" (conditional elements), data-doop-slot="actions" (content each instance supplies, add data-doop-slot-suggest="Button"). An enum prop in props sets data-<name> on the root, so variants are plain CSS: .btn[data-tone="ghost"] { … }. Give it a description saying when to use it: it is how the next agent knows.',
    readOnly: false,
    shape: {
      name: z.string().describe('Short and unique, e.g. "Button", "Pricing Card"'),
      description: z.string().optional().describe('When to use this. Later agents choose by it'),
      frame_id: z.string().optional().describe('With element: make this existing element the main'),
      element: z.string().optional().describe('A data-doop-id, or the element from find_component_candidates'),
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
        const def = createComponentFromHtml(
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
          data: { ok: true, component: summary(canvas, def), main_frame_id: def.mainFrameId },
          note: `Use it with ${usageExample(def)}. Call get_frame_screenshot on main_frame_id, and resize that frame to fit with update_frame.`,
          frames: outcomeFrames({ canvas } as ToolContext, def),
        }
      }
      if (typeof input.frame_id !== 'string' || typeof input.element !== 'string')
        throw new ComponentError('pass html, or frame_id with element')
      const { component, converted } = createComponentFromElement(
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
        },
        note: `Use it with ${usageExample(component)}.`,
        frames: outcomeFrames(
          { canvas } as ToolContext,
          component,
          converted.map((entry) => entry.frameId),
        ),
      }
    },
  },
  {
    name: 'update_component',
    title: 'Update a component',
    description:
      "Change a component's main; every instance on the canvas follows at once, keeping its props and overrides, so this is how a sweeping design change is one call rather than one edit per screen. Small changes: find + replace on the template (from get_component). Rewrites: html, keeping data-doop-part attributes where you can so overrides stay attached. The result reports the impact: which frames changed, which approved frames lost sign-off, which overrides no longer have an element to apply to. Pass dry_run=true to read that report first, which you should for a component with many instances. A changed main is one undo-able revision: restore_component_version goes back.",
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
    run(input, { canvas, actor }) {
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
      return {
        data: { ok: true, ...result, component: summary(canvas, result.component), rev: result.component.rev },
        ...(result.dry_run
          ? {}
          : { note: IMPACT_NOTE, frames: outcomeFrames({ canvas } as ToolContext, result.component) }),
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
      return {
        data: { ok: true, instances: instancesIn(frame), ...(missing.length ? { not_found: missing } : {}) },
        frames: [frame],
      }
    },
  },
  {
    name: 'find_component_candidates',
    title: 'Find what should be a component',
    description:
      "Scan a canvas for repeated structures that are not components yet, biggest payoff first: how often each appears, in how many frames, and an example element. On a canvas that grew without components, this is step one. Then call create_component with the example's frame_id and element and replace_matching=true.",
    readOnly: true,
    shape: { limit: z.number().min(1).max(30).optional() },
    run({ limit }, { canvas }) {
      const candidates = findComponentCandidates(canvas, typeof limit === 'number' ? limit : 12)
      return { data: { candidates, ...(candidates.length ? {} : { note: 'Nothing repeats on this canvas.' }) } }
    },
  },
  {
    name: 'delete_component',
    title: 'Delete a component',
    description:
      'Delete a component. Nothing disappears from any design: instances stay exactly as they look, as plain markup no longer linked, and the main stays in its frame. Refused while another component is built from it.',
    readOnly: false,
    destructive: true,
    shape: { component: COMPONENT_REF },
    run({ component }, { canvas, actor }) {
      /* read before the delete: afterwards nothing marks these frames */
      const def = findComponent(canvas.id, String(component))
      const touched = def ? outcomeFrames({ canvas } as ToolContext, def).map((frame) => frame.id) : []
      const result = deleteComponent(canvas.id, String(component), actor)
      return { data: { ok: true, ...result }, frames: canvas.frames.filter((frame) => touched.includes(frame.id)) }
    },
  },
  {
    name: 'restore_component_version',
    title: 'Restore a component revision',
    description:
      'Put a component back to an earlier revision (listed by get_component) and carry that to every instance, keeping their props and overrides. It is a new revision, so this can be undone too.',
    readOnly: false,
    destructive: true,
    shape: { component: COMPONENT_REF, rev: z.number() },
    run({ component, rev }, { canvas, actor }) {
      const result = restoreComponentVersion(canvas.id, String(component), Number(rev), actor)
      return {
        data: { ok: true, ...result, component: summary(canvas, result.component), rev: result.component.rev },
        frames: outcomeFrames({ canvas } as ToolContext, result.component),
      }
    },
  },
  {
    name: 'import_component',
    title: 'Import a component from a library',
    description:
      'Copy a component, and whatever it is built from, from another canvas this account can read (see list_components with libraries=true). It stays linked to its origin: a later change there shows up as library_update_available and arrives only when sync_component pulls it, so a library never changes this canvas unasked.',
    readOnly: false,
    shape: {
      source_canvas_id: z.string().describe('The library canvas'),
      component: COMPONENT_REF,
    },
    run({ source_canvas_id, component }, { canvas, actor, canRead }) {
      const source = String(source_canvas_id)
      if (!canRead(source)) throw new ComponentError('this account cannot read that canvas')
      const def = importComponent(canvas.id, source, String(component), actor)
      return { data: { ok: true, component: summary(canvas, def) }, note: `Use it with ${usageExample(def)}.` }
    },
  },
  {
    name: 'sync_component',
    title: 'Pull a library update',
    description:
      "Bring an imported component up to its library's current revision, carrying it to every instance here. Local instance overrides are kept; edits made to the local main are replaced.",
    readOnly: false,
    destructive: true,
    shape: { component: COMPONENT_REF },
    run({ component }, { canvas, actor, canRead }) {
      const result = syncComponent(canvas.id, String(component), actor, canRead)
      return {
        data: { ok: true, updated: result.updated, component: summary(canvas, result.component) },
        frames: result.updated ? outcomeFrames({ canvas } as ToolContext, result.component) : [],
      }
    },
  },
]

export const COMPONENT_TOOL_NAMES = COMPONENT_TOOLS.map((tool) => tool.name)

/** Run a tool's handler, turning a ComponentError into a message the agent can act on. */
export function runComponentTool(
  name: string,
  input: Record<string, unknown>,
  context: ToolContext,
): { ok: true; result: ToolResult } | { ok: false; error: string } {
  const tool = COMPONENT_TOOLS.find((candidate) => candidate.name === name)
  if (!tool) return { ok: false, error: `unknown tool ${name}` }
  try {
    return { ok: true, result: tool.run(input, context) }
  } catch (error) {
    if (error instanceof ComponentError) return { ok: false, error: error.message }
    throw error
  }
}

/** What an agent should hear after writing a frame: what could not be done, and components it redrew by hand. */
export function componentWriteNotes(frame: Frame): string[] {
  const notes = actions.takeComponentIssues(frame.id).map((issue) => `COMPONENT: ${issue.message}`)
  for (const lookalike of lookalikesIn(frame)) {
    notes.push(
      `COMPONENT: ${lookalike.occurrences} element${lookalike.occurrences === 1 ? '' : 's'} in this frame match${lookalike.occurrences === 1 ? 'es' : ''} “${lookalike.component}” but ${lookalike.occurrences === 1 ? 'is' : 'are'} not linked to it, so ${lookalike.occurrences === 1 ? 'it' : 'they'} will not follow changes. Use ${lookalike.usage} instead.`,
    )
  }
  return notes
}
