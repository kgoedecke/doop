import { env } from './env.ts'
import { resolveAgentBrand } from '../shared/agentBrand.ts'
import { agentKeyOf, isAgentsTask } from '../shared/agentIdentity.ts'
import { MAX_DECISION_CHARS } from '../shared/designDecisions.ts'
import packageJson from '../package.json' with { type: 'json' }
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from './db/index.ts'
import * as authSchema from './db/auth-schema.ts'
import { canvasPages, framePageId, MAX_CANVAS_NAME, MAX_PAGE_NAME } from '../shared/pages.ts'
import { normalizePageBackground } from '../shared/pageBackground.ts'
import { prototypeReport, prototypeUrl, setPrototypeStart } from './prototypeTools.ts'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Request, Response } from 'express'
import { fromNodeHeaders } from 'better-auth/node'
import { z } from 'zod'
import { store } from './store.ts'
import { addPage, savePages, updateFrameMeta } from './pageTools.ts'
import { fontsForCanvas } from './fonts.ts'
import { customAgentsForCanvas } from './customAgents.ts'
import { describeLibrary, libraryBrief, MAX_FONT_BYTES } from '../shared/fonts.ts'
import { addCanvasFont, uploadedFontResult } from './canvasFontUpload.ts'
import { EMBEDDED_MIN_LENGTH, inlineDataRefusal } from './inlineData.ts'
import {
  MAX_TOKEN_DESCRIPTION,
  TOKEN_TYPES,
  describeTokens,
  tokensBrief,
  NO_TOKENS_BRIEF,
  tokensCss,
  tokensMarkdown,
  tokensTailwind,
} from '../shared/designTokens.ts'
import { webFontFamilies, webFontsBrief } from '../shared/webFonts.ts'
import * as actions from './actions.ts'
import { canvasRole } from './access.ts'
import { roleAllows, type CanvasRole } from '../shared/canvasRole.ts'
import { isAgentKeySecret, verifyAgentKey } from './agentKeys.ts'
import * as workspaces from './workspaces.ts'
import { auth, getUserName, isBanned } from './auth.ts'
import { capture, captureThrottled } from './analytics.ts'
import { captureFeature, captureTokenResults } from './featureEvents.ts'
import { inspectFrame, renderFrame } from './screenshot.ts'
import { imagesForFrames } from './assets.ts'
import type { FrameImage } from '../shared/imageDescriptions.ts'
import { renderedHeight } from './renderLimits.ts'
import {
  MAX_PDF_FRAMES,
  PDF_UNAVAILABLE_MESSAGE,
  pdfFileName,
  pdfRendererAvailable,
  renderFramesPdf,
  selectPdfFrames,
  takePdfExportSlot,
} from './pdfExport.ts'
import { primeImage } from './previews.ts'
import { MAX_LAYER_SELECTOR_CHARS } from '../shared/elementId.ts'
import { layerExport } from './layerExport.ts'
import {
  DEFAULT_EXPORT_SCALE,
  MAX_EXPORT_SCALE,
  MIN_EXPORT_SCALE,
  exportPixelSize,
  fitExportScale,
  fullFrameRenderScale,
  parseExportScale,
} from '../shared/exportScale.ts'
import { COMPOSE_CHECK, GUIDE_TOPIC_SUMMARIES, GUIDE_TOPICS, guideFor } from './guide.ts'
import {
  describeInspiration,
  INSPIRATION_NO_MATCH_NOTE,
  INSPIRATION_UNAVAILABLE_NOTE,
  INSPIRATION_USAGE_NOTE,
  inspirationSearchEnabled,
  searchInspiration,
} from './inspiration.ts'
import { ESCAPED_HTML_NOTE, looksEscapedHtml } from './escapedHtml.ts'
import { describeSyncFlow, getSyncFlow } from './ingest.ts'
import * as assets from './assets.ts'
import { uploadCap } from './entitlements.ts'
import * as imageSearch from './imageSearch.ts'
import * as imageGen from './imageGen.ts'
import * as backgrounds from './backgrounds.ts'
import { viewWebsite } from './website.ts'
import { createImportedWebpageFrame } from './webpageImport.ts'
import { normalizeImportUrl } from './importer.ts'
import { extensions, type McpToolHelpers } from './extensions.ts'
import { websiteAccessErrorMessage } from './websiteAccess.ts'
import { mentionedRole } from '../shared/agents.ts'
import { resolveCommentMentions, threadAuthorIds } from './canvasPeople.ts'
import * as allowance from './allowance.ts'
import { embedsPreview, previewOf, previewToolMeta, registerFramePreview, type CanvasPreview } from './chatgptApp.ts'
import * as persist from './db/persist.ts'
import type { FrameApproval } from '../shared/types.ts'
import { recordAgentFeedback } from './agentFeedback.ts'
import {
  AGENT_IDEA_CATEGORIES,
  AGENT_ISSUE_CATEGORIES,
  MAX_AGENT_FEEDBACK_CHARS,
  type AgentFeedbackCategory,
  type AgentFeedbackKind,
} from '../shared/agentFeedback.ts'
import {
  catalog,
  compactFrameHtml,
  deletedComponentsInUse,
  findComponent,
  instancesIn,
  libraryCatalog,
} from './componentActions.ts'
import { existingStyle, existingStyleBrief } from './existingStyle.ts'
import {
  COMPONENT_TOOLS,
  componentWriteNotes,
  libraryFeatureEvent,
  runComponentTool,
  streamChunkNotes,
} from './componentTools.ts'
import { componentSystemPlan } from './reuseNotes.ts'
import { previewCombinations, previewDescription, previewFrame, previewProps } from './componentPreview.ts'
import { activeComponents, componentSignature, INSTANCE_ATTR } from '../shared/components.ts'
import { usageByComponent } from './componentUsage.ts'

/* What every agent gets in the handshake. Claude Code cuts server instructions at 4,096
   characters (older versions at 2,048) and ChatGPT reads the first 512 most, so this is the
   rules that break the work when skipped, in order of how much; everything else is in
   get_guide (tests/mcpInstructions.test.ts holds the budget). */
export const INSTRUCTIONS = `Doop is a shared multiplayer design canvas: humans and AI agents design together in real time. Canvases hold frames, artboards that render complete HTML documents live for everyone viewing.

You MUST call get_guide({ topic: "doop-instructions" }) before using other Doop tools, and again if a long conversation may have dropped it. It lists further topics (images, components, prototypes, redesigns…) to load when a task needs one.

- Call get_canvas before adding or editing frames. Pick one agent_name and pass it on every call; set_status says what you are working on.
- HUMAN FEEDBACK blocks in tool results are requests from people on the canvas: handle them before your own plan.
- Tokens: colours, fonts and sizes are var(--name) from the canvas's design tokens. No tokens yet: create_tokens before the first frame. Never a palette on a frame's :root.
- Components: before the first screen, set up the canvas's component system with create_components (primitives like Button and Input, patterns like nav and card), then compose screens from it. Anything get_canvas lists goes in as <doop-use component="Name" …>, never redrawn.
- Style guides: read the canvas's with get_guidelines before designing, and follow them.
- Create with create_frame, then stream append_frame_html one section per call. Small changes: edit_frame_html. Rename, move, resize: update_frame.
- After every create or significant edit, call get_frame_screenshot and fix what looks wrong.
- Keep every data-doop-* attribute when you rewrite markup: comments, links and prototype wiring hang on them.
- A request naming a site or URL: call import_webpage FIRST and design from what is there; view_website is only for read-only inspection.
- Images come from search_images, search_icons, search_logos, upload_asset or generate_image. Never a base64 data: URI, a placeholder logo or an invented brand.
- Only ready_for_dev is human sign-off; never approve a frame unasked.
- When Doop gets in your way, call report_issue, then carry on.`

/** What this server's integrations add to the main guide. */
/** A frame's HTML in every form an agent may have read it in (stored and compact), for
 *  telling what a write adds from what it carries over (server/inlineData.ts). */
function heldForms(frame: Frame): string {
  return `${frame.html}\n${compactFrameHtml(frame)}`
}

function extensionGuideLines(): string[] {
  return extensions.flatMap((extension) => extension.mcpGuideLines ?? [])
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function text(data: unknown) {
  return { content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] }
}

/** Result payload plus a workflow nudge the agent reads at its decision point. */
function textWithNudge(data: unknown, nudge: string) {
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(data, null, 2) },
      { type: 'text' as const, text: nudge },
    ],
  }
}

const REVIEW_NUDGE =
  'You have not seen this design yet. Call get_frame_screenshot on it now, judge it against the review checkpoints (fit, spacing, hierarchy, contrast, alignment, realism), and fix any issues before moving on.'

import type { Actor, Frame } from '../shared/types.ts'
import { loadToolTargets } from './toolLoads.ts'

/** Reaches agents whose session predates set_status (or who skipped the guide). */
type ToolContent = { content: { type: 'text' | 'image'; [k: string]: unknown }[] }

function appendStatusNudge<T extends ToolContent>(result: T, canvasId: string, actor?: Actor): T {
  if (!actor) return result
  if (actions.hasAnnouncedTask(canvasId, actor)) return result
  result.content.push({
    type: 'text' as const,
    text: 'You have not announced what you are working on. Call set_status with a one-line, present-tense summary (e.g. "Designing a pricing page, dark editorial style") — it shows live next to your name and builds your task history in the panel. Update it when your focus shifts; clear it with "" when done.',
  })
  return result
}

/** Tells an agent its markup arrived escaped — actions.ts already decoded it. */
function withEscapeNote<T extends { content: { type: 'text' | 'image'; [k: string]: unknown }[] }>(
  result: T,
  sent: string,
): T {
  if (looksEscapedHtml(sent)) result.content.push({ type: 'text' as const, text: ESCAPED_HTML_NOTE })
  return result
}

/** What a frame write could not do with components, and components it redrew by hand. */
function withComponentNotes<T extends ToolContent>(result: T, frame: Frame, options?: { review?: boolean }): T {
  return withNotesFirst(result, componentWriteNotes(frame, options))
}

/** Notes right after the result's data, ahead of the generic nudges: they name the call to make. */
function withNotesFirst<T extends ToolContent>(result: T, notes: string[]): T {
  result.content.splice(1, 0, ...notes.map((note) => ({ type: 'text' as const, text: note })))
  return result
}

/** Find and replace in a frame, in the form get_frame shows it first: an agent copies from that. */
function editFrameSource(frame: Frame, find: string, replace: string): { html: string } | { error: string } {
  const compact = compactFrameHtml(frame)
  const sources = compact === frame.html ? [frame.html] : [compact, frame.html]
  for (const source of sources) {
    const count = source.split(find).length - 1
    if (count === 1) return { html: source.replace(find, () => replace) }
    if (count > 1)
      return { error: `old_str occurs ${count} times — include more surrounding context so it matches exactly once.` }
  }
  return { error: 'old_str not found in the frame HTML. Call get_frame to see the current content.' }
}

/** A PDF returned inline as base64; beyond this, export fewer frames. */
const MAX_MCP_PDF_BYTES = 15_000_000

/** Tells the agent a very tall frame's screenshot stops short of its bottom. */
function croppedNote(frame: Frame, scale: number): string {
  const height = renderedHeight(frame, scale)
  return height < Math.round(frame.height) ? ` — cropped to the top ${height}px (pixel budget)` : ''
}

function err(message: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true }
}

/** Reaches agents that start designing without having read the canvas's style guides. */
function withGuidelinesNudge<T extends { content: { type: 'text' | 'image'; [k: string]: unknown }[] }>(
  result: T,
  canvasId: string,
  actor?: Actor,
): T {
  if (!actor) return result
  const docs = store.getGuidelines(canvasId)
  if (docs.length === 0 || actions.hasSeenGuidelines(canvasId, agentKeyOf(actor))) return result
  result.content.push({
    type: 'text' as const,
    text: `This canvas has style guides you have not read: ${docs.map((d) => d.name).join(', ')}. Call get_guidelines({ canvas_id, name }) for each relevant one NOW and make your design follow them.`,
  })
  return result
}

/** Whose work a task is, as the agent reading about it should hear it: its
 *  own, another agent's, or another agent going by its own name (two
 *  people's agents may both be "Claude"). */
function whoseWork(task: { agentName: string; agentKey?: string }, actor: Actor): string {
  if (isAgentsTask(task, actor)) return 'your'
  if (task.agentName === actor.name) return `another ${task.agentName}’s`
  return `${task.agentName}’s`
}

/** Append any undelivered human feedback for this agent to a tool result.
 *  MCP is pull-based, so this is the channel through which humans steer agents. */
function appendFeedback<T extends ToolContent>(result: T, canvasId: string, actor?: Actor): T {
  if (!actor) return result
  const pending = actions.takeFeedbackFor(canvasId, actor)
  if (pending.length === 0) return result
  const tasks = actions.getTasks(canvasId)
  const lines = pending.map((f) => {
    const task = tasks.find((t) => t.id === f.taskId)
    const about = task ? ` (about ${whoseWork(task, actor)} work: “${task.status}”)` : ''
    return `- ${f.from}${about}: ${f.text}`
  })
  result.content.push({
    type: 'text' as const,
    text: `HUMAN FEEDBACK — open request(s) on this canvas, now assigned to YOU:\n${lines.join('\n')}\nAddress this NOW, before continuing your plan: locate the frame in question (get_canvas / get_frame), make the change, and review with get_frame_screenshot. If it concerns another agent's frame, edit it anyway — a human request overrides the don't-touch-others'-frames etiquette. Update your set_status to say what you're picking up.`,
  })
  return result
}

/** The read-only tools' share of the feedback channel: says open human
 *  feedback is waiting without claiming it, so a read never writes. Claiming
 *  stays with get_feedback and the tools that change the canvas. */
function appendFeedbackNotice<T extends ToolContent>(result: T, canvasId: string, actor?: Actor): T {
  if (!actor) return result
  const open = actions.openFeedbackFor(canvasId, actor).length
  if (open === 0) return result
  result.content.push({
    type: 'text' as const,
    text: `HUMAN FEEDBACK — ${open} open request${open === 1 ? '' : 's'} on this canvas. Call get_feedback({ canvas_id, agent_name }) NOW to claim and read ${open === 1 ? 'it' : 'them'}, and address ${open === 1 ? 'it' : 'them'} before continuing your plan.`,
  })
  return result
}

/** Attaches the data behind the ChatGPT preview card (server/chatgptApp.ts):
 *  the frames a tool touched, as `structuredContent`. Only for a client that
 *  embeds the card: the card's data is not the tool's answer, and a client
 *  that reads `structuredContent` in place of `content` (Claude Code,
 *  opencode, Codex) would see nothing else, no pages, positions, notes or
 *  HUMAN FEEDBACK (#526). */
function attachPreview<T extends { content: unknown[] }>(
  result: T,
  canvasId: string,
  frames: Frame[],
): T & { structuredContent: CanvasPreview } {
  const canvas = store.getCanvas(canvasId)
  return { ...result, structuredContent: previewOf({ id: canvasId, name: canvas?.name ?? '' }, frames) }
}

/* Per-connecting-user rate limits, each overridable by environment variable
   for self-hosted instances that want a looser cap (see .env.example). The
   defaults are the conservative values that suit the hosted service. */
const uploadHits = new Map<string, number[]>()
const UPLOADS_PER_MIN = env.MCP_UPLOADS_PER_MIN

/* photo search burns the shared Pexels quota (200 req/hour on the free tier) */
const searchHits = new Map<string, number[]>()
const SEARCHES_PER_MIN = env.MCP_SEARCHES_PER_MIN

/* generation spends the payer's subscription quota or money — keep a burst
   of retries from draining it */
const generateHits = new Map<string, number[]>()
const GENERATIONS_PER_MIN = env.MCP_GENERATIONS_PER_MIN

/* importing writes a potentially large HTML frame, so keep it at the same
   conservative per-user rate as the browser UI's import endpoint */
const importHits = new Map<string, number[]>()
const IMPORTS_PER_MIN = env.MCP_IMPORTS_PER_MIN

const agentName = z
  .string()
  .describe(
    'Your display name, shown live to everyone on the canvas (e.g. "Claude", "Codex"). Reuse the SAME name on every call so your work is attributed consistently.',
  )

/** Said once in get_canvas when any listed frame carries an image. */
const IMAGES_NOTE =
  'Frames with `images` reference pictures people uploaded or pasted; each carries a `description` of what it shows (null while it is being written). Read them, and call get_frame_screenshot on the relevant ones before designing. A frame that is nothing but one image is a reference pasted for you: leave it as it is and deliver in a separate frame. A design that uses images is an ordinary frame.'

function frameSummary(
  f: {
    pageId?: string
    id: string
    name: string
    x: number
    y: number
    width: number
    height: number
    updatedAt: number
    updatedBy: string
    html: string
    demo?: boolean
    hidden?: boolean
    locked?: boolean
    rotation?: number
    approval?: FrameApproval | null
  },
  images?: FrameImage[],
) {
  return {
    id: f.id,
    pageId: f.pageId,
    name: f.name,
    approvalStatus: f.approval?.status ?? 'draft',
    approval: f.approval ?? null,
    ...(f.demo ? { demo: true } : {}),
    ...(f.hidden ? { hidden: true } : {}),
    ...(f.locked ? { locked: true } : {}),
    x: f.x,
    y: f.y,
    width: f.width,
    height: f.height,
    ...(f.rotation ? { rotation: f.rotation } : {}),
    updatedAt: new Date(f.updatedAt).toISOString(),
    updatedBy: f.updatedBy,
    ...(images?.length ? { images } : {}),
    htmlBytes: f.html.length,
    /* public render of the CURRENT design — downloadable/hotlinkable
       (append &download, or .jpg?quality=90 for JPEG) */
    image_url: `${env.BETTER_AUTH_URL}/i/${f.id}.png?scale=2`,
  }
}

/** owner is the connecting user's display name (for attribution); ownerId is
 *  their user id — canvases the agent creates or lists are scoped to it, the
 *  same isolation the web UI gets. clientName names the connecting client
 *  (handleMcpRequest builds one server per stateless request, so it is the
 *  name remembered from initialize, else the OAuth application's): feedback
 *  records it and agent presence reads its brand from it. */
export function buildMcpServer(owner?: string, ownerId?: string, clientName?: string): McpServer {
  const actorFrom = (agent_name?: string) => {
    const actor = actions.resolveActor({
      name: agent_name,
      kind: 'agent',
      owner,
      brand: resolveAgentBrand(clientName, agent_name),
    })
    return { ...actor, agentKey: mcpAgentKey(ownerId, actor.name) }
  }
  /* Canvas access for agents mirrors the web UI: the OAuth user's id runs
     through the same canvasRole gate as browser sessions, so an agent
     connected by someone holding a view or comment link reads but cannot
     write. Every tool that takes a canvas or frame id resolves it through
     these, naming the role it needs: 'view' to read, 'comment' for comment
     threads, 'edit' for everything that changes the canvas. */
  const roleOn = (canvasId: string) => {
    const c = store.getCanvas(canvasId)
    return c ? canvasRole(ownerId, c) : null
  }
  const canvasFor = (canvasId: string, need: CanvasRole) =>
    roleAllows(roleOn(canvasId), need) ? store.getCanvas(canvasId) : undefined
  const frameFor = (frameId: string, need: CanvasRole) => {
    const f = store.getFrame(frameId)
    return f && canvasFor(f.canvasId, need) ? f : undefined
  }
  /* a canvas the account can read but not change says so, instead of
     claiming the canvas is not there */
  const readOnlyNote = (canvasId: string | undefined) => {
    const role = canvasId ? roleOn(canvasId) : null
    return role ? ` with the access this task needs — this account can only ${role} on that canvas` : ''
  }
  const noCanvas = (id: string) => err(`no canvas with id ${id} accessible to this account${readOnlyNote(id)}`)
  const noFrame = (id: string) =>
    err(`no frame with id ${id} accessible to this account${readOnlyNote(store.getFrame(id)?.canvasId)}`)
  /* Feedback is claimed, and set_status nudged, only for agents that may
     act on it: claiming assigns a human's request to this agent, which a
     read-only agent could never carry out. */
  const withFeedback = <T extends ToolContent>(result: T, canvasId: string, actor?: Actor): T =>
    roleAllows(roleOn(canvasId), 'edit') ? appendFeedback(result, canvasId, actor) : result
  const withFeedbackNotice = <T extends ToolContent>(result: T, canvasId: string, actor?: Actor): T =>
    roleAllows(roleOn(canvasId), 'edit') ? appendFeedbackNotice(result, canvasId, actor) : result
  const withStatusNudge = <T extends ToolContent>(result: T, canvasId: string, actor?: Actor): T =>
    roleAllows(roleOn(canvasId), 'edit') ? appendStatusNudge(result, canvasId, actor) : result
  const noComment = (id: string) => err(`no comment with id ${id} on this canvas`)
  /* export_frame's PDF: the file travels inside the tool result, not as a
     public URL, so it stays behind the same canvas gate as the frames */
  const exportPdf = async (first: Frame, more: string[]) => {
    const canvas = canvasFor(first.canvasId, 'view')
    if (!canvas) return noFrame(first.id)
    const selection = selectPdfFrames(canvas, { frameIds: [first.id, ...more] })
    if (!selection.ok) return err(selection.error)
    if (!pdfRendererAvailable()) return err(PDF_UNAVAILABLE_MESSAGE)
    if (!takePdfExportSlot(ownerId ?? `mcp:${owner ?? 'anonymous'}`))
      return err('PDF export rate limit — wait a minute before exporting again')
    try {
      const pdf = await renderFramesPdf(selection.frames)
      if (pdf.length > MAX_MCP_PDF_BYTES) return err('The PDF is too large to return — export fewer frames at once')
      const fileName = pdfFileName(canvas, selection.frames)
      return {
        content: [
          {
            type: 'resource' as const,
            resource: {
              uri: `doop://canvas/${canvas.id}/${encodeURIComponent(fileName)}`,
              mimeType: 'application/pdf',
              blob: pdf.toString('base64'),
            },
          },
          {
            type: 'text' as const,
            text: JSON.stringify({
              file_name: fileName,
              bytes: pdf.length,
              pages: selection.frames.length,
              note: 'The PDF is the embedded application/pdf resource (base64). Save it to disk as the file name above; each page is one frame at its own size, text stays selectable.',
            }),
          },
        ],
      }
    } catch (e) {
      return err(`PDF export failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  /* Reads count as arrival: presence (and with it every "your agent is
     connected" confirmation in the UI) must appear on an agent's FIRST
     canvas-scoped call, not only once it mutates something. */
  const arrive = (canvasId: string, agent_name?: string) => {
    if (agent_name) actions.heartbeatAgent(canvasId, actorFrom(agent_name))
  }
  const server = new McpServer({ name: 'doop-canvas', version: packageJson.version }, { instructions: INSTRUCTIONS })
  loadToolTargets(server)
  registerFramePreview(server)
  /* only for a client that shows the card inside the conversation (embedsPreview) */
  const embedsCard = embedsPreview(clientName)
  const previewMeta = (invoking: string, invoked: string) =>
    embedsCard ? previewToolMeta(invoking, invoked) : undefined
  const withPreview = <T extends { content: unknown[] }>(result: T, canvasId: string, frames: Frame[]) =>
    embedsCard ? attachPreview(result, canvasId, frames) : result

  server.registerTool(
    'get_guide',
    {
      title: 'Read the Doop agent guide',
      description: `Read the Doop agent guide. Call with topic "doop-instructions" ONCE before using other Doop tools (the main guide: review checkpoints, the brief, streaming, frames, tokens, components, design quality, etiquette), and again if a long conversation may have compressed it. Other topics, to load when a task needs one: ${GUIDE_TOPICS.filter(
        (topic) => topic !== 'doop-instructions',
      )
        .map((topic) => `"${topic}" (${GUIDE_TOPIC_SUMMARIES[topic]})`)
        .join('; ')}.`,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        topic: z.enum(GUIDE_TOPICS).describe('Guide topic to load'),
      },
    },
    async ({ topic }) => text(guideFor(topic, extensionGuideLines())),
  )

  server.registerTool(
    'search_inspiration',
    {
      title: 'Search design inspiration',
      description:
        'Search One Page Love\'s hand-curated gallery of real, well-designed live websites and SEE thumbnails of each, with their tags (style, colour, fonts, genre, sections). Call it FIRST when writing a design brief — it is the required inspiration step, especially for landing pages. Query the genre plus the look you want in the words the catalog is tagged with ("saas landing page, dark minimal", "finance, editorial", "portfolio, typographic", "pricing, illustrative"), not the product noun alone. The catalog is landing pages and one-page sites, not app screens: for a dashboard or app UI, query the product\'s register ("saas, minimal") and take the type, colour and density from it. Study the thumbnails, pick the ONE exemplar that fits the brief best and follow it — do not blend several — and name it in the brief. Do not embed these screenshots in a frame.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        query: z
          .string()
          .describe('Genre + look, e.g. "saas landing page, dark minimal", "restaurant, retro", "finance, editorial"'),
        count: z.number().min(1).max(6).optional().describe('Exemplars to return, default 4'),
        canvas_id: z.string().optional().describe('The canvas you are designing on (lets human feedback reach you)'),
        agent_name: agentName,
      },
    },
    async ({ query, count, canvas_id, agent_name }) => {
      if (!inspirationSearchEnabled()) return text({ ok: true, results: [], note: INSPIRATION_UNAVAILABLE_NOTE })
      const now = Date.now()
      const limitKey = ownerId ?? agent_name
      const hits = (searchHits.get(limitKey) ?? []).filter((t) => now - t < 60_000)
      if (hits.length >= SEARCHES_PER_MIN) return err('search rate limit — wait a minute')
      hits.push(now)
      searchHits.set(limitKey, hits)
      try {
        const results = await searchInspiration(query, count ?? 4)
        if (results.length === 0)
          return text({ ok: true, results: [], note: `No inspiration for "${query}" — ${INSPIRATION_NO_MATCH_NOTE}.` })
        const thumbs = await Promise.all(results.map((r) => imageSearch.fetchThumb(r.thumb_url)))
        type ResultBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
        const content: ResultBlock[] = [
          {
            type: 'text' as const,
            text: `${results.length} exemplar(s) for "${query}" — study each thumbnail with its style facts:`,
          },
        ]
        results.forEach((r, i) => {
          const thumb = thumbs[i]
          if (thumb) content.push({ type: 'image' as const, data: thumb.data, mimeType: thumb.mime })
          content.push({ type: 'text' as const, text: describeInspiration(r, i) })
        })
        content.push({ type: 'text' as const, text: INSPIRATION_USAGE_NOTE })
        const result = { content }
        return canvas_id ? withFeedbackNotice(result, canvas_id, actorFrom(agent_name)) : result
      } catch (e) {
        return err(e instanceof Error ? e.message : 'inspiration search failed')
      }
    },
  )

  server.registerTool(
    'list_canvases',
    {
      title: 'List canvases',
      description:
        "List the connected user's design canvases with their ids, names and frame counts — personal ones, ones shared with them, and every canvas in their workspaces (workspace_id / workspace_name set).",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {},
    },
    /* '' matches no ownerId: a session without a user sees nothing */
    async () =>
      text(
        workspaces.canvasesFor(ownerId ?? '').map((m) => ({
          ...m,
          ...(m.workspaceId
            ? { workspace_id: m.workspaceId, workspace_name: workspaces.getWorkspace(m.workspaceId)?.name }
            : {}),
          /* count what get_canvas will actually return — demo frames are hidden from agents */
          frameCount: store.getCanvas(m.id)?.frames.filter((f) => !f.demo).length ?? m.frameCount,
          guidelinesCount: store.getGuidelines(m.id).length,
        })),
      ),
  )

  /* ChatGPT shows this when several Doop accounts are connected — the
     `openai/profile` flag marks it as the one that tells them apart. */
  server.registerTool(
    'get_profile',
    {
      title: 'Get the connected account',
      description:
        'Return the Doop account this connection is signed in as (stable id and display name). Read-only; use it to confirm whose canvases you are working on.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { 'openai/profile': true },
      inputSchema: {},
      outputSchema: { id: z.string(), name: z.string() },
    },
    async () => {
      if (!ownerId) return err('this connection is not signed in to a Doop account')
      const profile = { id: ownerId, name: owner ?? '' }
      return { content: [{ type: 'text' as const, text: JSON.stringify(profile) }], structuredContent: profile }
    },
  )

  server.registerTool(
    'create_canvas',
    {
      title: 'Create a canvas',
      description:
        'Create a new design canvas. Returns the canvas id, which is part of the shareable URL (/c/<id>). Pass workspace_id (from list_canvases) to create it inside a shared workspace so every member can open it.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        name: z.string().trim().min(1).max(MAX_CANVAS_NAME).describe('Canvas name'),
        workspace_id: z.string().optional().describe('Create inside this shared workspace'),
        agent_name: agentName.optional(),
      },
    },
    async ({ name, workspace_id }) => {
      if (workspace_id) {
        const ws = workspaces.getWorkspace(workspace_id)
        if (!ws || !workspaces.isWorkspaceMember(ws.id, ownerId)) return err(`no workspace with id ${workspace_id}`)
        if (!workspaces.isActive(ws))
          return err(`workspace "${ws.name}" needs a Team plan before canvases can be added`)
      }
      /* owned by the connecting user — an ownerless canvas would be invisible
         on every dashboard (and was once visible on all of them) */
      const canvas = store.createCanvas(name, ownerId, workspace_id)
      return text({ id: canvas.id, name: canvas.name, url: `/c/${canvas.id}` })
    },
  )

  server.registerTool(
    'update_canvas',
    {
      title: 'Rename a canvas',
      description:
        'Rename a canvas: the name on its tab, in the dashboard and in get_canvas. Everyone viewing it sees the new name at once. Pages are renamed with set_canvas_pages, frames with update_frame.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        canvas_id: z.string(),
        name: z.string().trim().min(1).max(MAX_CANVAS_NAME).describe('The new canvas name'),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, name, agent_name }) => {
      if (!canvasFor(canvas_id, 'edit')) return noCanvas(canvas_id)
      const actor = actorFrom(agent_name)
      const canvas = actions.renameCanvas(canvas_id, name, actor)
      if (!canvas) return noCanvas(canvas_id)
      return withFeedback(text({ ok: true, id: canvas.id, name: canvas.name }), canvas_id, actor)
    },
  )

  server.registerTool(
    'get_canvas',
    {
      title: 'Get a canvas and its frames',
      _meta: previewMeta('Reading the canvas…', 'Canvas loaded'),
      description:
        "Get a canvas: its name, its pages (id, name, prototype start frame) and its frames with pageId, position, size, approvalStatus and human approval attribution (not the HTML — use get_frame for that). Pass page_id to see one page's frames only; filter approval_status to ready_for_dev to find screens approved for implementation. Use this to see the current layout before adding or editing frames. Pass your agent_name so the result can tell you when human feedback is waiting (claim it with get_feedback).",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        canvas_id: z.string(),
        agent_name: agentName.optional(),
        page_id: z.string().optional().describe("Only this page's frames (a page id from a previous get_canvas)"),
        approval_status: z.enum(['draft', 'ready_for_dev', 'needs_review']).optional(),
      },
    },
    async ({ canvas_id, agent_name, page_id, approval_status }) => {
      const c = canvasFor(canvas_id, 'view')
      if (!c) return noCanvas(canvas_id)
      if (page_id && !canvasPages(c).some((page) => page.id === page_id))
        return err(`No page ${page_id} on this canvas. Its pages are listed by get_canvas without page_id.`)
      arrive(canvas_id, agent_name)
      /* demo frames (the Doop welcome show, seeded examples) are product
         content, not user work — hidden so agents never mistake them for
         the canvas's established style */
      const shown = c.frames.filter(
        (f) =>
          !f.demo &&
          (!page_id || framePageId(c, f) === page_id) &&
          (!approval_status || (f.approval?.status ?? 'draft') === approval_status),
      )
      const docs = store.getGuidelines(canvas_id)
      const refs = store.getReferences(canvas_id)
      const library = fontsForCanvas(c)
      const customAgents = customAgentsForCanvas(c)
      const sharedLibraries = libraryCatalog(c)
      /* one pass over the canvas's frames answers for the catalog and for what was deleted */
      const componentUsage = usageByComponent(c)
      const deletedInUse = deletedComponentsInUse(c, componentUsage)
      const tokens = store.getTokens(canvas_id)
      const tokenThemes = store.getTokenThemes(canvas_id)
      /* a canvas that already has a look: what its frames share, so new work reuses it */
      const established = existingStyle(c)
      /* design-synced canvases carry a flow map: real user navigation between
         the synced screens — context a redesign must respect */
      const flow = describeSyncFlow(await getSyncFlow(c), c.frames)
      const images = await imagesForFrames(shown.map((f) => f.id))
      const notes = [
        ...(images.size ? [IMAGES_NOTE] : []),
        ...(flow.length
          ? [
              'This canvas is synced from a live app and `flow` shows how its screens connect — including how often real users take each path. Do not bury or weaken elements that carry heavy navigation.',
            ]
          : []),
        ...(docs.length
          ? [
              'This canvas has style guides. Call get_guidelines for each relevant one BEFORE designing — every frame must follow them.',
            ]
          : []),
        ...(library.length ? [libraryBrief(library)] : []),
        webFontsBrief(),
        ...(tokens.length ? [tokensBrief(tokens, tokenThemes)] : established ? [] : [NO_TOKENS_BRIEF]),
        ...(established ? [existingStyleBrief(established, { tokens: tokens.length > 0 })] : []),
        ...(refs.length
          ? [
              'This canvas has pinned style references — exemplar designs humans marked as "more like this". Call get_reference on the relevant one and match its look (palette, type, spacing) in what you design.',
            ]
          : []),
        ...(activeComponents(c.components).length
          ? [
              'This canvas has components. Anything they cover goes in through <doop-use> as shown in each entry’s usage, never redrawn by hand.',
            ]
          : []),
        ...(deletedInUse.length
          ? [
              'deletedComponents lists components that were deleted while instances of them remain: those instances keep their look, follow nothing and read back as full markup. Leave them as they are unless asked; restore_component brings one back.',
            ]
          : []),
      ]
      return withPreview(
        withFeedbackNotice(
          text({
            id: c.id,
            name: c.name,
            pages: canvasPages(c),
            frames: shown.map((f) => frameSummary(f, images.get(f.id))),
            guidelines: docs.map((d) => ({
              name: d.name,
              title: actions.guidelineTitle(d),
              summary: actions.guidelineSummary(d),
              bytes: d.markdown.length,
            })),
            references: refs.map((r) => ({
              id: r.id,
              title: r.title,
              size: `${Math.round(r.width)}x${Math.round(r.height)}`,
              htmlBytes: r.html.length,
              pinnedBy: r.pinnedBy,
            })),
            ...(activeComponents(c.components).length
              ? { components: catalog(c, activeComponents(c.components), componentUsage) }
              : {}),
            ...(deletedInUse.length ? { deletedComponents: deletedInUse } : {}),
            ...(sharedLibraries.length ? { workspaceLibraries: sharedLibraries } : {}),
            ...(library.length ? { fonts: describeLibrary(library) } : {}),
            ...(customAgents.length
              ? {
                  customAgents: customAgents.map((a) => ({
                    name: a.name,
                    mention: `@${a.id}`,
                    blurb: a.blurb,
                    ...(a.reviewer ? { reviewer: true } : {}),
                  })),
                }
              : {}),
            webFonts: webFontFamilies(),
            ...(tokens.length ? { tokens: describeTokens(tokens) } : {}),
            ...(tokenThemes.length ? { tokenThemes } : {}),
            ...(established ? { existingStyle: established } : {}),
            ...(flow.length ? { flow } : {}),
            ...(notes.length ? { note: notes.join(' ') } : {}),
          }),
          canvas_id,
          agent_name ? actorFrom(agent_name) : undefined,
        ),
        canvas_id,
        shown,
      )
    },
  )

  server.registerTool(
    'list_guidelines',
    {
      title: 'List style guides',
      description:
        "List a canvas's style guides (named markdown guidelines — brand rules, style recipes) with one-line summaries. Fetch the full text of the relevant ones with get_guidelines before designing.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: { canvas_id: z.string(), agent_name: agentName.optional() },
    },
    async ({ canvas_id, agent_name }) => {
      if (!canvasFor(canvas_id, 'view')) return noCanvas(canvas_id)
      if (agent_name) actions.markGuidelinesSeen(canvas_id, agentKeyOf(actorFrom(agent_name)))
      const docs = store.getGuidelines(canvas_id)
      if (docs.length === 0)
        return text({
          guidelines: [],
          note: 'No style guides on this canvas yet. Set one with set_guidelines when a human hands you brand or style rules.',
        })
      return withFeedbackNotice(
        text({
          guidelines: docs.map((d) => ({
            name: d.name,
            title: actions.guidelineTitle(d),
            summary: actions.guidelineSummary(d),
            bytes: d.markdown.length,
            updatedAt: new Date(d.updatedAt).toISOString(),
            updatedBy: d.updatedBy,
          })),
        }),
        canvas_id,
        agent_name ? actorFrom(agent_name) : undefined,
      )
    },
  )

  server.registerTool(
    'get_guidelines',
    {
      title: 'Read a style guide',
      description:
        "Read one of the canvas's style guides in full: the style rules (palettes, fonts, layout recipes, asset URLs) every frame must follow. If get_canvas listed style guides, read the relevant ones with this BEFORE creating or restyling frames.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        canvas_id: z.string(),
        name: z.string().describe('Doc name from get_canvas / list_guidelines, e.g. "feature-image"'),
        agent_name: agentName.optional(),
      },
    },
    async ({ canvas_id, name, agent_name }) => {
      if (!canvasFor(canvas_id, 'view')) return noCanvas(canvas_id)
      const doc = store.getGuidelines(canvas_id).find((d) => d.name === name.trim().toLowerCase())
      if (!doc) {
        const names = store.getGuidelines(canvas_id).map((d) => d.name)
        return err(
          names.length
            ? `no style guide named “${name}” — this canvas has: ${names.join(', ')}`
            : `no style guides on this canvas yet`,
        )
      }
      if (agent_name) actions.markGuidelinesSeen(canvas_id, agentKeyOf(actorFrom(agent_name)))
      return withFeedbackNotice(text(doc.markdown), canvas_id, agent_name ? actorFrom(agent_name) : undefined)
    },
  )

  server.registerTool(
    'set_guidelines',
    {
      title: 'Create or replace a style guide',
      description:
        "Create, replace or delete a named style guide on a canvas (markdown, max 24,000 chars; empty string deletes). Write rules other designers and agents can execute directly: palette hexes, font <link>s, ready-to-paste <style> blocks, logo asset URLs (upload files with upload_asset first and reference the returned URLs), layout recipes, do/don't lists.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        canvas_id: z.string(),
        name: z.string().describe('Doc slug, e.g. "feature-image" (a-z, 0-9, hyphens)'),
        markdown: z
          .string()
          .max(actions.MAX_GUIDELINE_CHARS)
          .describe('Full replacement markdown for this doc; empty string deletes it'),
        title: z
          .string()
          .max(actions.MAX_GUIDELINE_TITLE_CHARS)
          .optional()
          .describe('Pretty display name shown to humans, e.g. "Featured Images"; omit to keep the current one'),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, name, markdown, title, agent_name }) => {
      if (!canvasFor(canvas_id, 'edit')) return noCanvas(canvas_id)
      const actor = actorFrom(agent_name)
      try {
        const doc = actions.setGuideline(canvas_id, name, markdown, actor, undefined, title)
        actions.markGuidelinesSeen(canvas_id, agentKeyOf(actor))
        return withFeedback(
          text(
            doc
              ? { ok: true, name: doc.name, title: actions.guidelineTitle(doc), bytes: doc.markdown.length }
              : { ok: true, deleted: true },
          ),
          canvas_id,
          actor,
        )
      } catch (e) {
        return err(e instanceof Error ? e.message : 'invalid guideline doc')
      }
    },
  )

  server.registerTool(
    'get_tokens',
    {
      title: 'List design tokens',
      description:
        "A canvas's design tokens: its named design values (colour, opacity, radius, spacing, container, breakpoint, font family/weight/size, line height, letter spacing), each a CSS custom property frames use as var(--name), with its value per theme (light, dark, …) where one differs. Filter by type or a name glob; export as JSON (default), a :root CSS block with one block per theme, a Tailwind v4 @theme block, or markdown tables for a styleguide.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        canvas_id: z.string(),
        types: z.array(z.enum(TOKEN_TYPES)).optional().describe('Only these token types; omit for all'),
        name_pattern: z
          .string()
          .optional()
          .describe('Glob on the full name, case-insensitive, * wildcard: "--color-*", "*-500", "*brand*"'),
        format: z.enum(['json', 'css', 'tailwind', 'markdown']).optional(),
        agent_name: agentName.optional(),
      },
    },
    async ({ canvas_id, types, name_pattern, format }) => {
      if (!canvasFor(canvas_id, 'view')) return noCanvas(canvas_id)
      let tokens = store.getTokens(canvas_id)
      const themes = store.getTokenThemes(canvas_id)
      if (types?.length) tokens = tokens.filter((t) => types.includes(t.type))
      if (name_pattern) {
        const re = new RegExp(`^${name_pattern.split('*').map(escapeRegExp).join('.*')}$`, 'i')
        tokens = tokens.filter((t) => re.test(t.name))
      }
      if (!tokens.length)
        return text({
          tokens: [],
          note: 'No design tokens match. Add some with create_tokens when a brief names a palette, spacing scale or type ramp, and use them as var(--name).',
        })
      switch (format) {
        case 'css':
          return text(tokensCss(tokens, themes))
        case 'tailwind':
          return text(tokensTailwind(tokens, themes))
        case 'markdown':
          return text(tokensMarkdown(tokens, themes))
        default:
          return text({ tokens: describeTokens(tokens), ...(themes.length ? { themes } : {}) })
      }
    },
  )

  server.registerTool(
    'create_tokens',
    {
      title: 'Create design tokens',
      description:
        'Add design tokens to a canvas: each needs a CSS custom property name (--color-primary), a type and a value (a CSS value — "#0177d3", "oklch(…)", "8px", 600 — or var(--other) to alias another token, which must exist already or come earlier in the batch). Order matters: semantic colours before palette colours, neutrals before primary, secondary and accent; other types smallest value first. Names follow Tailwind v4 namespaces (--color-*, --spacing-*, --radius-*, --font-*, --text-* for sizes, --leading-*, --tracking-*, --container-*, --breakpoint-*). Reuse existing tokens before creating new ones; a name already in use is an error. Returns one result per entry.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        canvas_id: z.string(),
        tokens: z
          .array(
            z.object({
              name: z.string().describe('CSS custom property name, e.g. "--color-primary"'),
              type: z.enum(TOKEN_TYPES),
              value: z.union([z.string(), z.number()]),
              themes: z
                .record(z.string(), z.union([z.string(), z.number()]))
                .optional()
                .describe(
                  'The value under a theme where it differs, e.g. { "dark": "#fff" }; a new theme name declares it',
                ),
              description: z
                .string()
                .max(MAX_TOKEN_DESCRIPTION)
                .optional()
                .describe('What it is for and when to use it'),
            }),
          )
          .min(1)
          .max(200),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, tokens, agent_name }) => {
      if (!canvasFor(canvas_id, 'edit')) return noCanvas(canvas_id)
      const actor = actorFrom(agent_name)
      const results = actions.createTokens(canvas_id, tokens, actor)
      if (!results) return noCanvas(canvas_id)
      captureTokenResults(ownerId, canvas_id, 'mcp', results)
      return withFeedback(text({ results }), canvas_id, actor)
    },
  )

  server.registerTool(
    'set_tokens',
    {
      title: 'Change, rename or delete design tokens',
      description:
        'Update existing design tokens by name, applied in order: set `value` (or `type`, `description`, `themes`) to change one, `new_name` to rename it (every frame and alias follows), `delete: true` to remove it (refused while another token aliases it). Every frame that names a changed token is restyled at once. Returns one result per entry; errors are reported in-band.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        canvas_id: z.string(),
        tokens: z
          .array(
            z.object({
              name: z.string().describe('The token to change, by its full name'),
              new_name: z.string().optional(),
              type: z.enum(TOKEN_TYPES).optional(),
              value: z.union([z.string(), z.number()]).optional(),
              themes: z
                .record(z.string(), z.union([z.string(), z.number(), z.null()]))
                .optional()
                .describe("Theme values to set, merged in; null removes that theme's value"),
              description: z.string().max(MAX_TOKEN_DESCRIPTION).optional(),
              delete: z.boolean().optional(),
            }),
          )
          .min(1)
          .max(200),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, tokens, agent_name }) => {
      if (!canvasFor(canvas_id, 'edit')) return noCanvas(canvas_id)
      const actor = actorFrom(agent_name)
      const results = actions.setTokens(
        canvas_id,
        tokens.map(({ new_name, ...rest }) => ({ ...rest, ...(new_name !== undefined ? { newName: new_name } : {}) })),
        actor,
      )
      if (!results) return noCanvas(canvas_id)
      captureTokenResults(ownerId, canvas_id, 'mcp', results)
      return withFeedback(text({ results }), canvas_id, actor)
    },
  )

  server.registerTool(
    'set_token_themes',
    {
      title: 'Set the design token themes',
      description:
        'Replace the canvas\'s token themes (light, dark, compact, …) and their order. A token carries a value per theme where it differs from its default (set them with create_tokens / set_tokens `themes`); a frame switches theme with data-doop-theme="<theme>" on its <html>, or on one subtree. A theme that leaves the list takes its values with it.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        canvas_id: z.string(),
        themes: z
          .array(z.string())
          .max(8)
          .describe('Theme names in display order, e.g. ["light", "dark"]; "default" is always there and never listed'),
        renames: z
          .array(z.object({ from: z.string(), to: z.string() }))
          .optional()
          .describe('Themes to rename first; their values follow. List the new name in `themes`.'),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, themes, renames, agent_name }) => {
      if (!canvasFor(canvas_id, 'edit')) return noCanvas(canvas_id)
      const actor = actorFrom(agent_name)
      try {
        const set = actions.setTokenThemes(canvas_id, themes, actor, renames ?? [])
        if (!set) return noCanvas(canvas_id)
        captureFeature(ownerId, 'token_themes_set', 'mcp', { canvas_id, theme_count: set.length })
        return withFeedback(text({ ok: true, themes: set }), canvas_id, actor)
      } catch (e) {
        return err(e instanceof Error ? e.message : 'invalid themes')
      }
    },
  )

  server.registerTool(
    'get_reference',
    {
      title: 'Read a pinned style reference',
      description:
        'Read a pinned style reference in full: the HTML of a design a human marked as an exemplar ("more designs like this"). References are listed by get_canvas. Match its palette, typography and spacing when designing on this canvas — it is the ground truth for the canvas\'s style.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        canvas_id: z.string(),
        reference_id: z.string().describe('Reference id from get_canvas'),
        agent_name: agentName.optional(),
      },
    },
    async ({ canvas_id, reference_id, agent_name }) => {
      if (!canvasFor(canvas_id, 'view')) return noCanvas(canvas_id)
      const ref = store.getReferences(canvas_id).find((r) => r.id === reference_id)
      if (!ref) {
        const ids = store.getReferences(canvas_id).map((r) => `${r.id} (“${r.title}”)`)
        return err(
          ids.length
            ? `no reference with id ${reference_id} — this canvas has: ${ids.join(', ')}`
            : 'no style references pinned on this canvas yet',
        )
      }
      return withFeedbackNotice(
        text({
          id: ref.id,
          title: ref.title,
          width: ref.width,
          height: ref.height,
          pinnedBy: ref.pinnedBy,
          html: ref.html,
        }),
        canvas_id,
        agent_name ? actorFrom(agent_name) : undefined,
      )
    },
  )

  server.registerTool(
    'save_decision',
    {
      title: 'Save a design decision',
      description: `Record a design decision and why it was made, so humans and later agents know what the canvas committed to and the reason: a change your human asked for while talking to YOU ("rounder corners", "less purple, more white and blue", "stop using italic serif"), or a direction you chose (the exemplar you followed, the mood, the accent) with the reason it won. Doop's UI feedback is captured automatically, but you are the only one who hears your own conversation, so record a requested change AFTER you have made it. It lands in the canvas's Memory; recurring preferences become suggested style rules. A decision is the why, not a store for values: the palette, fonts and scale live in tokens (create_tokens, set_tokens). Save one decision and its rationale per call, at most ${MAX_DECISION_CHARS} characters, split by topic. Design taste only — not one-off content edits like typo fixes or copy changes.`,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        canvas_id: z.string(),
        decision: z
          .string()
          .max(
            MAX_DECISION_CHARS,
            `Save one decision and its rationale per call, at most ${MAX_DECISION_CHARS} characters; split longer feedback into separate calls by topic.`,
          )
          .describe(
            `One decision and its rationale in the human's own words, at most ${MAX_DECISION_CHARS} characters. Split longer feedback into separate calls by topic.`,
          ),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, decision, agent_name }) => {
      if (!canvasFor(canvas_id, 'edit')) return noCanvas(canvas_id)
      const actor = actorFrom(agent_name)
      try {
        const saved = actions.recordChatDecision(canvas_id, decision, actor)
        if (saved === undefined) return err(`no canvas with id ${canvas_id}`)
        return withFeedback(
          text(
            saved
              ? { ok: true, note: 'Saved to the canvas Memory. Recurring preferences become suggested style rules.' }
              : { ok: true, note: 'Already in Memory — this exact decision was recorded before.' },
          ),
          canvas_id,
          actor,
        )
      } catch (e) {
        return err(e instanceof Error ? e.message : 'invalid decision')
      }
    },
  )

  server.registerTool(
    'set_status',
    {
      title: 'Set your live status',
      description:
        'Broadcast a one-line status of what you are working on right now — everyone viewing the canvas sees it live next to your name (e.g. "Sketching a mobile onboarding flow", "Fixing contrast on the pricing table"). Set it when you START a task, update it whenever your focus shifts to something new, and clear it with an empty string when you are done. Keep it under ~80 characters, present tense, specific.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        canvas_id: z.string(),
        status: z
          .string()
          .max(140)
          .describe('What you are working on, one line, present tense. Empty string clears your status.'),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, status, agent_name }) => {
      if (!canvasFor(canvas_id, 'edit')) return noCanvas(canvas_id)
      actions.setAgentStatus(canvas_id, actorFrom(agent_name), status)
      return withFeedback(text({ ok: true, status: status.trim() || null }), canvas_id, actorFrom(agent_name))
    },
  )

  server.registerTool(
    'get_comments',
    {
      title: 'Read comments',
      description:
        'Read comments and replies on a canvas, newest first, including author, text, parentId thread links, and claim/failure/resolution metadata. An element comment carries its frameId, its elementId (the data-doop-id attribute of the element in the frame HTML) and an HTML snippet from when it was left; a comment on a frame as a whole has no elementId and x, y (design px from the frame top-left) where it was left; a canvas comment is pinned to a point on the canvas instead and carries pageId, x and y (world coordinates) with no frame. Includes resolved comments by default so complete conversations remain readable; set include_resolved to false for unresolved comments only. Returns the retained comment history (up to 100 entries per canvas), not an archive. Reading does not claim feedback or comments, or mark them resolved.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        canvas_id: z.string(),
        frame_id: z
          .string()
          .optional()
          .describe(
            'Only element comments on this frame (canvas comments are left out); it must belong to the canvas.',
          ),
        include_resolved: z.boolean().default(true).describe('Include resolved comments and replies. Default true.'),
        agent_name: agentName.optional(),
      },
    },
    async ({ canvas_id, frame_id, include_resolved, agent_name }) => {
      if (!canvasFor(canvas_id, 'view')) return noCanvas(canvas_id)
      if (frame_id !== undefined) {
        const frame = frameFor(frame_id, 'view')
        if (!frame || frame.canvasId !== canvas_id) return noFrame(frame_id)
      }
      arrive(canvas_id, agent_name)
      const comments = actions
        .getComments(canvas_id)
        .filter((comment) => frame_id === undefined || comment.frameId === frame_id)
        .filter((comment) => include_resolved || comment.resolvedAt === undefined)
      // Deliberately omit withFeedback: inspecting comments must not claim work.
      return text(comments)
    },
  )

  server.registerTool(
    'reply_to_comment',
    {
      title: 'Reply to a comment',
      description:
        'Reply inside an element-comment thread on a canvas. The reply inherits the root comment’s element anchor, so an @mention in it gives the resident agent the same anchor the conversation is about. Writing does not resolve the thread — read the request with get_comments, make the change, then close it with resolve_comment. If the text @mentions a resident role (e.g. "@Doop"), it counts as a new resident task against the account’s meter, exactly like a comment left in the browser. To tag a person, write @ and their name exactly as a comment\'s `from` spells it (e.g. "@Ana Souza"): someone the canvas is shared with, or already in the thread, is emailed at once.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        canvas_id: z.string(),
        comment_id: z.string().describe('The root comment or any reply in the thread (from get_comments)'),
        text: z.string().describe('The reply text. Trimmed; empty replies are rejected.'),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, comment_id, text: body, agent_name }) => {
      if (!canvasFor(canvas_id, 'comment')) return noCanvas(canvas_id)
      const found = actions.findComment(comment_id)
      if (!found || found.canvasId !== canvas_id) return noComment(comment_id)
      const canvas = store.getCanvas(canvas_id)
      if (!body.trim() || !canvas || !actions.openThread(comment_id)) return err('thread resolved or empty text')
      /* people it tags are emailed; a person's name is never an agent's */
      const mentions = await resolveCommentMentions(canvas, body.trim(), { authorIds: threadAuthorIds(found) })
      /* an @mention commands the resident agent to change frames — the REST
         reply route holds comment-only visitors to the same rule */
      const mentioned = mentionedRole(mentions.roleText, actions.canvasRoster(canvas_id))
      if (mentioned && !canvasFor(canvas_id, 'edit'))
        return err('asking an agent to change the canvas needs edit access')
      const actor = actorFrom(agent_name)
      arrive(canvas_id, agent_name)
      /* A reply that @mentions a resident agent is a new command to the team,
         metered like a card; plain replies stay free. Mirrors the REST reply
         route so the meter is spent exactly once either way. */
      let gate: Awaited<ReturnType<typeof allowance.consumeResidentTask>> | undefined
      if (mentioned && ownerId) {
        gate = await allowance.consumeResidentTask(ownerId)
        if (!gate.ok)
          return err(
            `resident task limit reached (${gate.used}/${gate.limit}) — connect a model account or retry later`,
          )
      }
      /* attributed to the agent, billed to the connecting user: the resident
         picks whose model account pays from the requester id, and without one
         it falls back to the canvas owner's — wrong on a shared canvas */
      const reply = actions.replyToComment(comment_id, body, actor.name, ownerId, 'agent', mentions)
      if (!reply) {
        /* the thread closed while the meter was being written: give the task back */
        if (gate && ownerId) {
          await allowance
            .refundResidentTask(gate, ownerId)
            .catch((e) => console.error(`[mcp] could not refund a resident task for ${ownerId}:`, e))
        }
        return err('thread resolved meanwhile')
      }
      return withFeedback(text(reply), canvas_id, actor)
    },
  )

  server.registerTool(
    'resolve_comment',
    {
      title: 'Resolve a comment',
      description:
        'Resolve an element-comment thread on a canvas, marking the request addressed. Resolving a root comment closes its whole thread; resolving a reply closes only that reply. When the thread was an @mention of a resident agent, resolving it also records the exchange as a design decision in the canvas Memory (plain human-to-human notes are not). Like every mutating tool, the result also carries any pending task feedback addressed to you; get_feedback is for polling it on its own.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        canvas_id: z.string(),
        comment_id: z.string().describe('The root comment or a reply (from get_comments)'),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, comment_id, agent_name }) => {
      if (!canvasFor(canvas_id, 'comment')) return noCanvas(canvas_id)
      const found = actions.findComment(comment_id)
      if (!found || found.canvasId !== canvas_id) return noComment(comment_id)
      const actor = actorFrom(agent_name)
      arrive(canvas_id, agent_name)
      const alreadyResolved = found.resolvedAt !== undefined
      const resolved = actions.resolveComment(comment_id, actor.name)
      if (!resolved) return noComment(comment_id)
      return withFeedback(
        text({
          ok: true,
          id: resolved.id,
          alreadyResolved,
          resolvedBy: resolved.resolvedBy,
          resolvedAt: resolved.resolvedAt ? new Date(resolved.resolvedAt).toISOString() : undefined,
        }),
        canvas_id,
        actor,
      )
    },
  )

  server.registerTool(
    'get_feedback',
    {
      title: 'Claim open human feedback',
      description:
        'Fetch and claim any open human feedback requests on a canvas. Tools that change the canvas deliver feedback automatically and read-only tools announce waiting requests, so call this when a result says feedback is waiting, or when you are specifically checking for feedback, e.g. an agent whose job is to poll the canvas every few minutes and address whatever humans have requested. Claiming assigns the requests to you: address each one, then review with get_frame_screenshot.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: { canvas_id: z.string(), agent_name: agentName },
    },
    async ({ canvas_id, agent_name }) => {
      if (!canvasFor(canvas_id, 'edit')) return noCanvas(canvas_id)
      const actor = actorFrom(agent_name)
      const fbs = actions.takeFeedbackFor(canvas_id, actor)
      if (fbs.length === 0) return text({ feedback: [], note: 'No open feedback requests right now.' })
      const tasks = actions.getTasks(canvas_id)
      return text({
        feedback: fbs.map((f) => {
          const task = tasks.find((t) => t.id === f.taskId)
          return {
            from: f.from,
            text: f.text,
            about: task ? `${whoseWork(task, actor)} work: “${task.status}”` : undefined,
            at: new Date(f.at).toISOString(),
          }
        }),
        note: "These requests are now assigned to you. Address each one (a human request overrides the don't-touch-others'-frames etiquette), review with get_frame_screenshot, and update your set_status.",
      })
    },
  )

  /* report_issue and share_feedback: both go to the Doop team, never to the canvas */
  const tellDoopTeam = async (
    kind: AgentFeedbackKind,
    input: { category: AgentFeedbackCategory; message: string; tool?: string; canvas_id?: string; agent_name?: string },
  ) => {
    if (input.canvas_id && !canvasFor(input.canvas_id, 'view')) return noCanvas(input.canvas_id)
    const saved = await recordAgentFeedback({
      kind,
      source: 'mcp',
      category: input.category,
      message: input.message,
      tool: input.tool,
      agentName: input.agent_name,
      client: server.server.getClientVersion()?.name ?? clientName,
      canvasId: input.canvas_id,
      userId: ownerId,
    })
    if (!saved.ok) return err(saved.error)
    return text({ ok: true, id: saved.id, note: 'Thanks — the Doop team reads these. Carry on with your task.' })
  }
  const teamMessageFields = {
    tool: z.string().max(80).optional().describe('The Doop tool involved, if any (e.g. "edit_frame_html").'),
    canvas_id: z.string().optional().describe('The canvas you were working on, if any.'),
    agent_name: agentName.optional(),
  }

  server.registerTool(
    'report_issue',
    {
      title: 'Report a problem with Doop',
      description:
        "Tell the Doop team where Doop itself got in your way, so it can be fixed: a tool that errored or did something other than its description says, a guide or tool description that left you guessing, a capability you needed and did not have, or a workaround you had to invent. Call it whenever you struggle with Doop — after a retry fails, when you fall back to a workaround, or when you give up on part of a task — then carry on with the task. Ideas and suggestions that did not block you go to share_feedback instead. It does not reach the humans on the canvas and does not change any canvas; for the human's design feedback use save_decision. Be specific: what you tried (tool and arguments in brief), what happened, what you expected. Never include secrets.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        category: z
          .enum(AGENT_ISSUE_CATEGORIES)
          .describe(
            'bug: a tool misbehaved · tool_error: a tool returned an error you could not get past · confusing: the guide or a description was unclear · missing_capability: you needed something Doop cannot do · other',
          ),
        message: z
          .string()
          .min(1)
          .max(MAX_AGENT_FEEDBACK_CHARS)
          .describe('What you tried, what happened, and what you expected or needed instead.'),
        ...teamMessageFields,
      },
    },
    (input) => tellDoopTeam('issue', input),
  )

  server.registerTool(
    'share_feedback',
    {
      title: 'Share an idea or feedback about Doop',
      description:
        "Tell the Doop team how Doop could work better for agents like you: a tool you wish existed, a parameter or result field that would have saved you calls, a workflow that felt clumsy, or something that worked especially well and should stay. Use it when you notice something worth saying, then carry on with the task. Something that broke or blocked you goes to report_issue instead. It does not reach the humans on the canvas and does not change any canvas; for the human's design feedback use save_decision. Be concrete: what you were doing and what would have helped. Never include secrets.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        category: z
          .enum(AGENT_IDEA_CATEGORIES)
          .describe(
            'idea: something new Doop could offer · improvement: a change to something that exists · praise: something that worked well · other',
          ),
        message: z
          .string()
          .min(1)
          .max(MAX_AGENT_FEEDBACK_CHARS)
          .describe('What you were doing and what would have helped (or what worked well).'),
        ...teamMessageFields,
      },
    },
    (input) => tellDoopTeam('feedback', input),
  )

  server.registerTool(
    'set_canvas_pages',
    {
      title: 'Set canvas pages',
      description:
        'Rename, reorder or delete canvas pages by sending the complete ordered page list back (read get_canvas first; keep the ids it returned). To add a page, call create_canvas_page instead. A page containing frames cannot be deleted: move its frames with update_frame first.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        canvas_id: z.string(),
        expectedPages: z
          .array(z.object({ id: z.string(), name: z.string() }))
          .describe('Exact ordered pages returned by get_canvas; protects collaborators from overwritten changes'),
        pages: z
          .array(z.object({ id: z.string().trim().min(1).max(100), name: z.string().trim().min(1).max(100) }))
          .min(1)
          .max(100),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, pages, expectedPages, agent_name }) => {
      const canvas = canvasFor(canvas_id, 'edit')
      if (!canvas) return noCanvas(canvas_id)
      const actor = actorFrom(agent_name)
      const saved = savePages(canvas, expectedPages, pages, actor)
      if (!saved.ok) return err(saved.error)
      return withFeedback(text({ ok: true, pages: saved.value }), canvas_id, actor)
    },
  )

  server.registerTool(
    'create_canvas_page',
    {
      title: 'Create a canvas page',
      description:
        'Add a new, empty page at the end of a canvas and get its id back. Use a page when a body of work deserves its own board — a second product surface, a platform (web vs. mobile), a round of explorations — and a frame when it is one screen. Then pass the returned page id as pageId to create_frame; get_canvas with page_id shows what is on it.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        canvas_id: z.string(),
        name: z.string().trim().min(1).max(MAX_PAGE_NAME).describe('The page name shown in the Pages panel'),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, name, agent_name }) => {
      const canvas = canvasFor(canvas_id, 'edit')
      if (!canvas) return noCanvas(canvas_id)
      const created = addPage(canvas_id, name, actorFrom(agent_name))
      if (!created.ok) return err(created.error)
      return withFeedback(
        text({ ok: true, page: created.value.page, pages: created.value.pages }),
        canvas_id,
        actorFrom(agent_name),
      )
    },
  )

  server.registerTool(
    'set_page_background',
    {
      title: 'Set a page background colour',
      description:
        "Paint one page's canvas a colour of its own, as Figma's page background does: everyone viewing that page sees frames on that colour instead of the theme paper. Pass color null to go back to the theme paper. Pages report it as `background` in get_canvas.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        canvas_id: z.string(),
        page_id: z.string().optional().describe('Page ID from get_canvas; defaults to the first page'),
        color: z.string().nullable().describe('A hex colour such as #1e1e1e, or null to clear'),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, page_id, color, agent_name }) => {
      const canvas = canvasFor(canvas_id, 'edit')
      if (!canvas) return noCanvas(canvas_id)
      const pages = canvasPages(canvas)
      const pageId = page_id ?? pages[0]!.id
      if (!pages.some((p) => p.id === pageId)) return err(`no page ${pageId} on canvas ${canvas_id}`)
      const background = color === null ? null : normalizePageBackground(color)
      if (color !== null && !background) return err('color must be a hex colour such as #f5f5f5, or null')
      const saved = actions.setPageBackground(canvas_id, pageId, background, actorFrom(agent_name))
      if (!saved) return noCanvas(canvas_id)
      captureFeature(ownerId, 'page_background_changed', 'mcp', { canvas_id, cleared: !background })
      return withFeedback(text({ ok: true, pages: saved }), canvas_id, actorFrom(agent_name))
    },
  )

  server.registerTool(
    'get_prototype',
    {
      title: 'Read a canvas prototype',
      description:
        'List the clickable-prototype wiring of a canvas: each page with its flow start frame, and every interaction with its trigger, action and target. Interactions are attributes on the triggering element in frame HTML, written with edit_frame_html: data-doop-on (click | hover | press | delay:<ms> | key:<Key>) and data-doop-action (navigate:<frameId> | back | overlay:<frameId> | close-overlay | scroll-to:<selector> | url:<https url>), optionally data-doop-transition and data-doop-duration; the guide\'s "Prototypes" section has the full syntax. Interactions whose target frame does not exist are flagged with a problem; fix them with edit_frame_html.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: { canvas_id: z.string(), agent_name: agentName },
    },
    async ({ canvas_id, agent_name }) => {
      const canvas = canvasFor(canvas_id, 'view')
      if (!canvas) return noCanvas(canvas_id)
      arrive(canvas_id, agent_name)
      return text(prototypeReport(canvas))
    },
  )

  server.registerTool(
    'set_prototype_start',
    {
      title: 'Set a prototype flow start',
      description:
        "Choose the frame a page's clickable prototype starts on (the player at /c/<canvas_id>/proto opens there). Pass frame_id null to clear it — the flow then starts on the page's top-left frame.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        canvas_id: z.string(),
        pageId: z.string().optional().describe("Page ID from get_canvas; defaults to the start frame's page"),
        frame_id: z.string().nullable().describe("The start frame, or null to clear the page's start"),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, pageId, frame_id, agent_name }) => {
      const canvas = canvasFor(canvas_id, 'edit')
      if (!canvas) return noCanvas(canvas_id)
      const result = setPrototypeStart(canvas, pageId, frame_id, actorFrom(agent_name))
      if (!result.ok) return err(result.error)
      captureFeature(ownerId, 'prototype_start_set', 'mcp', { canvas_id: canvas.id, cleared: frame_id === null })
      return withFeedback(
        text({ ok: true, pages: result.pages, prototype_url: prototypeUrl(canvas.id) }),
        canvas_id,
        actorFrom(agent_name),
      )
    },
  )

  server.registerTool(
    'create_frame',
    {
      title: 'Create a frame',
      /* no preview card: in the streaming flow the frame is empty here, and
         a card that shows a blank artboard never updates (append_frame_html
         has no card either). The review screenshot after the stream is the
         first card the person sees. */
      description:
        'Create a new frame on a canvas with an HTML design. A frame is a rectangular artboard that renders a full HTML document (no external network access needed). Put the styles of an element in its style attribute; a <style> block is for what an attribute cannot say (keyframes, states, pseudo-elements, media queries, the reset), and <script> is allowed. If x/y are omitted the frame is auto-placed to the right of existing frames. Everyone viewing the canvas sees it appear live. Use <doop-use> for anything get_canvas lists under components. ' +
        COMPOSE_CHECK,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        canvas_id: z.string(),
        pageId: z.string().optional().describe('Target page ID from get_canvas; defaults to the first page'),
        name: z.string().describe('Frame title, e.g. "Landing hero" or "Pricing card"'),
        html: z
          .string()
          .describe(
            'Complete HTML for the frame body (a full document or a fragment; it is rendered in a sandboxed iframe).',
          ),
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().optional().describe('Default 640'),
        height: z.number().optional().describe('Default 480'),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, pageId, name, html, x, y, width, height, agent_name }) => {
      if (!canvasFor(canvas_id, 'edit')) return noCanvas(canvas_id)
      const inline = inlineDataRefusal(html)
      if (inline) return err(inline)
      const frame = actions.createFrame(canvas_id, { name, pageId, html, x, y, width, height }, actorFrom(agent_name))
      if (!frame) return noCanvas(canvas_id)
      const canvas = store.getCanvas(canvas_id)
      const result = withComponentNotes(
        withEscapeNote(
          frame.html.length > 0
            ? textWithNudge({ ok: true, frame: frameSummary(frame) }, REVIEW_NUDGE)
            : canvas
              ? textWithNudge({ ok: true, frame: frameSummary(frame) }, componentSystemPlan(canvas))
              : text({ ok: true, frame: frameSummary(frame) }),
          html,
        ),
        frame,
        { review: frame.html.length > 0 },
      )
      return withGuidelinesNudge(
        withStatusNudge(withFeedback(result, canvas_id, actorFrom(agent_name)), canvas_id, actorFrom(agent_name)),
        canvas_id,
        actorFrom(agent_name),
      )
    },
  )

  server.registerTool(
    'get_frame',
    {
      title: 'Get a frame and its HTML',
      description:
        'Get a frame including its HTML. Component instances come back as <doop-use> (see the Components section of the guide), and `instances` lists each with its id, props and overridden parts. Write them back the same way.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        frame_id: z.string(),
        expand_components: z
          .boolean()
          .optional()
          .describe('true = every instance written out in full, for when you must read what is rendered'),
        agent_name: agentName.optional(),
      },
    },
    async ({ frame_id, expand_components, agent_name }) => {
      const f = frameFor(frame_id, 'view')
      if (!f) return noFrame(frame_id)
      arrive(f.canvasId, agent_name)
      const images = (await imagesForFrames([f.id])).get(f.id)
      const instances = f.html.includes(INSTANCE_ATTR) ? instancesIn(f) : []
      return withFeedbackNotice(
        text({
          ...frameSummary(f, images),
          html: expand_components ? f.html : compactFrameHtml(f),
          ...(instances.length ? { instances } : {}),
        }),
        f.canvasId,
        agent_name ? actorFrom(agent_name) : undefined,
      )
    },
  )

  server.registerTool(
    'set_frame_html',
    {
      title: 'Replace a frame’s HTML',
      _meta: previewMeta('Redesigning the frame…', 'Frame redesigned'),
      description:
        'Replace the HTML design of a frame in one shot. The change renders live for everyone viewing the canvas. For new or heavily reworked designs, prefer append_frame_html so viewers can watch the design stream in. Keep data-doop-* attributes on elements you carry over: comments and links point at data-doop-id, prototype wiring and locks ride on the others. ' +
        COMPOSE_CHECK,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: { frame_id: z.string(), html: z.string(), agent_name: agentName },
    },
    async ({ frame_id, html, agent_name }) => {
      const current = frameFor(frame_id, 'edit')
      if (!current) return noFrame(frame_id)
      /* every form the agent may have read the frame in counts as what it already held: a
         rewrite of the full form carries over what the canvas supplies to it */
      const inline = inlineDataRefusal(html, heldForms(current))
      if (inline) return err(inline)
      const frame = actions.updateFrame(frame_id, { html }, actorFrom(agent_name), { replace: true })
      if (!frame) return noFrame(frame_id)
      return withPreview(
        withGuidelinesNudge(
          withStatusNudge(
            withFeedback(
              withComponentNotes(
                withEscapeNote(textWithNudge({ ok: true, frame: frameSummary(frame) }, REVIEW_NUDGE), html),
                frame,
                { review: true },
              ),
              frame.canvasId,
              actorFrom(agent_name),
            ),
            frame.canvasId,
            actorFrom(agent_name),
          ),
          frame.canvasId,
          actorFrom(agent_name),
        ),
        frame.canvasId,
        [frame],
      )
    },
  )

  server.registerTool(
    'export_frame',
    {
      title: 'Export frame as image or PDF',
      description:
        "Export the frame's CURRENT design. PNG/JPG return public URLs for publishing it elsewhere (CMS media library, social post, og:image; the URL re-renders when the frame changes) at `scale` (default 2x; 1, 3 or 4 for other sizes). PDF returns the file itself (an embedded application/pdf resource): vector, text selectable, one page per frame sized to the frame; pass frame_ids to put several frames of the same canvas into one multi-page PDF (pages in the order given: frame_id first, then frame_ids as listed).",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        frame_id: z.string(),
        format: z.enum(['png', 'jpg', 'pdf']).optional().describe('default png'),
        quality: z.number().min(1).max(100).optional().describe('jpg only, default 90'),
        scale: z
          .number()
          .min(MIN_EXPORT_SCALE)
          .max(MAX_EXPORT_SCALE)
          .optional()
          .describe(
            `png/jpg only: pixel density, default ${DEFAULT_EXPORT_SCALE} (a 1080x1350 frame at 2 is 2160x2700). Above 2 a very large frame comes down to fit the render limit; the returned width and height are what you get.`,
          ),
        frame_ids: z
          .array(z.string())
          .max(MAX_PDF_FRAMES)
          .optional()
          .describe(
            `pdf only: more frames from the same canvas to include as extra pages, in this order after frame_id (up to ${MAX_PDF_FRAMES} in all)`,
          ),
      },
    },
    async ({ frame_id, format, quality, scale, frame_ids }) => {
      const f = frameFor(frame_id, 'view')
      if (!f) return noFrame(frame_id)
      if (format === 'pdf') return exportPdf(f, frame_ids ?? [])
      const ext = format === 'jpg' ? 'jpg' : 'png'
      const q = ext === 'jpg' ? `&quality=${quality ?? 90}` : ''
      const requested = fitExportScale(f, parseExportScale(scale ?? DEFAULT_EXPORT_SCALE) ?? DEFAULT_EXPORT_SCALE)
      const density = fullFrameRenderScale(f, requested)
      const pixels = exportPixelSize({ width: Math.round(f.width), height: Math.round(f.height) }, density)
      return text({
        image_url: `${env.BETTER_AUTH_URL}/i/${frame_id}.${ext}?scale=${requested}${q}`,
        download_url: `${env.BETTER_AUTH_URL}/i/${frame_id}.${ext}?scale=${requested}${q}&download`,
        scale: density,
        width: pixels.width,
        height: pixels.height,
        note: 'Public URL, no auth needed. To publish: fetch the URL and upload the bytes to the target platform (e.g. WordPress POST /wp/v2/media), or hotlink it directly — it always shows the current design.',
      })
    },
  )

  server.registerTool(
    'export_layer',
    {
      title: 'Export one layer of a frame as an image',
      description:
        "Export ONE element (layer) of a frame as a PNG or JPG: the frame's CURRENT design rendered whole, then cut to that element's box, so inherited styles and whatever paints behind it are in the picture (as Figma exports a layer). Returns public URLs that re-render when the frame changes. Name the element by element_id (its data-doop-id attribute, as get_frame shows it) or, when it has none, by selector (any CSS selector; the first match is used). For the whole frame use export_frame.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        frame_id: z.string(),
        element_id: z.string().optional().describe("the element's data-doop-id; preferred, it survives edits"),
        selector: z
          .string()
          .max(MAX_LAYER_SELECTOR_CHARS)
          .optional()
          .describe('a CSS selector for an element without a data-doop-id, e.g. "#pricing .card:nth-of-type(2)"'),
        format: z.enum(['png', 'jpg']).optional().describe('default png'),
        quality: z.number().min(1).max(100).optional().describe('jpg only, default 90'),
        scale: z
          .number()
          .min(MIN_EXPORT_SCALE)
          .max(MAX_EXPORT_SCALE)
          .optional()
          .describe(`pixel density, default ${DEFAULT_EXPORT_SCALE}`),
      },
    },
    async ({ frame_id, element_id, selector, format, quality, scale }) => {
      const f = frameFor(frame_id, 'view')
      if (!f) return noFrame(frame_id)
      if (!element_id === !selector) return err('pass exactly one of element_id or selector')
      const result = layerExport(f, element_id ? { elementId: element_id } : { selector: selector! }, {
        format,
        quality,
        scale,
      })
      if (!result.ok) return err(result.error)
      const { ok: _ok, ...urls } = result
      return text(urls)
    },
  )

  server.registerTool(
    'upload_asset',
    {
      title: 'Upload an image asset',
      description: `Upload an image (png/jpg/webp/gif/svg, max 5 MB on the Free plan, 100 MB on Pro) and get back a permanent public URL to reference in frame HTML (<img src>, CSS background) — use this instead of inlining data: URIs. Pick ONE input by where the file lives: (1) remote — pass source_url and the server fetches it; (2) LOCAL FILE — pass local_file=true to receive a one-time upload URL and a ready-to-run curl command, run it in your shell, and the curl response JSON contains the permanent url. (3) data — base64, LAST RESORT for tiny files (under ~100 KB) when you cannot run shell commands; larger base64 payloads are slow and corrupt easily. At most ${UPLOADS_PER_MIN} uploads a minute per account, so upload one after another rather than in a parallel burst. Icons from search_icons and photos from search_images are already hosted and need no upload.`,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      inputSchema: {
        source_url: z.string().optional().describe('Public http(s) URL to fetch the file from (remote files)'),
        local_file: z
          .boolean()
          .optional()
          .describe('true = the file is on YOUR machine: returns a one-time upload URL + curl command to run'),
        data: z
          .string()
          .optional()
          .describe('The file as base64 (raw base64 or a data: URL). Last resort, tiny files only.'),
        canvas_id: z.string().describe('The canvas this asset belongs to'),
        agent_name: agentName,
      },
    },
    async ({ data, source_url, local_file, canvas_id, agent_name }) => {
      const provided = [data, source_url, local_file].filter(Boolean).length
      if (provided !== 1)
        return err(
          'provide exactly one of: source_url (remote file), local_file=true (local file — returns a curl command), or data (small base64)',
        )
      if (!canvasFor(canvas_id, 'edit')) return noCanvas(canvas_id)
      const limited = takeUploadSlot(ownerId ?? agent_name)
      if (limited) return err(limited)
      if (local_file) {
        const { token, expiresAt } = assets.createUploadTicket({
          canvasId: canvas_id,
          ownerId,
          uploadedBy: agent_name,
        })
        const upload_url = `${env.BETTER_AUTH_URL}/u/${token}`
        return withFeedback(
          text({
            ok: true,
            upload_url,
            command: `curl -sS -T "<path-to-your-file>" ${upload_url}`,
            expires_at: new Date(expiresAt).toISOString(),
            note: 'One-time upload URL (single use, 15 min). Run the curl command in your shell with your real file path — its JSON response contains the permanent public url to use in frame HTML. Request a fresh ticket for each file.',
          }),
          canvas_id,
          actorFrom(agent_name),
        )
      }
      try {
        const cap = uploadCap({ canvasId: canvas_id, userId: ownerId })
        const buf = data
          ? Buffer.from(data.replace(/^data:[^,]*;base64,/, ''), 'base64')
          : await assets.fetchRemote(source_url!, cap.bytes)
        const asset = await assets.createAsset(buf, { canvasId: canvas_id, ownerId, uploadedBy: agent_name }, cap)
        const url = `${env.BETTER_AUTH_URL}/a/${asset.id}.${asset.ext}`
        const result = text({
          ok: true,
          url,
          mime: asset.mime,
          size_bytes: asset.size,
          usage: `<img src="${url}" alt="">`,
          note: 'Permanent public URL — safe to reference in any frame on any canvas.',
        })
        return withFeedback(result, canvas_id, actorFrom(agent_name))
      } catch (e) {
        return err(e instanceof Error ? e.message : 'upload failed')
      }
    },
  )

  /* one rate window with upload_asset: both write files to storage */
  function takeUploadSlot(limitKey: string): string | null {
    const now = Date.now()
    const hits = (uploadHits.get(limitKey) ?? []).filter((t) => now - t < 60_000)
    if (hits.length >= UPLOADS_PER_MIN) {
      const retryIn = Math.max(1, Math.ceil((hits[0]! + 60_000 - now) / 1000))
      return `upload rate limit: at most ${UPLOADS_PER_MIN} uploads a minute per account. Retry in ${retryIn}s, one upload at a time.`
    }
    hits.push(now)
    uploadHits.set(limitKey, hits)
    return null
  }

  server.registerTool(
    'upload_font',
    {
      title: 'Add a font to the canvas’s library',
      description: `Add a font file (ttf/otf/woff/woff2, one face per file, max 10 MB) to the font library this canvas designs with: its workspace's, or its owner's own on a personal canvas. Then name the family in CSS (font-family: "Family", sans-serif) and Doop writes the @font-face into every frame that uses it. This is how a font that is not in get_canvas's fonts or webFonts gets into a design: never inline the file as a base64 data: URI. Upload each weight and style you use as its own file; a file for a face the library already has replaces it. Pick ONE input: (1) source_url, a public URL of the font file itself (not a CSS file); (2) local_file=true for a file on your machine, which returns a one-time upload URL and a curl command to run; (3) data, base64, last resort for a small file when you cannot run shell commands. Shares upload_asset's limit of ${UPLOADS_PER_MIN} uploads a minute.`,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        canvas_id: z.string().describe('The canvas whose font library gets the font'),
        source_url: z.string().optional().describe('Public http(s) URL of the font file'),
        local_file: z
          .boolean()
          .optional()
          .describe('true = the file is on YOUR machine: returns a one-time upload URL + curl command to run'),
        data: z.string().optional().describe('The file as base64 (raw or a data: URL). Last resort, small files only.'),
        file_name: z.string().optional().describe('The file name the library shows, e.g. "Oxanium-Light.ttf"'),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, source_url, local_file, data, file_name, agent_name }) => {
      if ([data, source_url, local_file].filter(Boolean).length !== 1)
        return err(
          'provide exactly one of: source_url (a public font file), local_file=true (a file on your machine — returns a curl command), or data (small base64)',
        )
      if (!canvasFor(canvas_id, 'edit')) return noCanvas(canvas_id)
      if (!ownerId) return err('fonts are added by a signed-in account; connect with your Doop account')
      const limited = takeUploadSlot(ownerId)
      if (limited) return err(limited)
      if (local_file) {
        const { token, expiresAt } = assets.createUploadTicket({
          canvasId: canvas_id,
          ownerId,
          uploadedBy: owner ?? agent_name,
          kind: 'font',
        })
        /* the trailing slash makes curl append the local file name, which the library keeps */
        const upload_url = `${env.BETTER_AUTH_URL}/u/${token}/`
        return text({
          ok: true,
          upload_url,
          command: `curl -sS -T "<path-to-your-font-file>" ${upload_url}`,
          expires_at: new Date(expiresAt).toISOString(),
          note: 'One-time upload URL (single use, 15 min). Run the curl command with your real file path; its JSON response names the family to use in CSS. Request a fresh ticket for each file.',
        })
      }
      try {
        const buf = data
          ? Buffer.from(data.replace(/^data:[^,]*;base64,/, ''), 'base64')
          : await assets.fetchRemote(source_url!, MAX_FONT_BYTES)
        const name =
          file_name ?? (source_url ? decodeURIComponent(new URL(source_url).pathname.split('/').pop() ?? '') : '')
        const font = await addCanvasFont(canvas_id, { id: ownerId, name: owner ?? agent_name }, buf, name || 'font')
        return withFeedback(text(uploadedFontResult(font)), canvas_id, actorFrom(agent_name))
      } catch (e) {
        return err(e instanceof Error ? e.message : 'upload failed')
      }
    },
  )

  server.registerTool(
    'generate_image',
    {
      title: 'Generate an image with AI',
      description: `Generate an image from a text prompt and store it as a permanent asset on this origin — returns the URL to embed plus a preview you can look at. ${imageGen.IMAGE_PROVIDER_NOTE} Use it for visuals stock search cannot supply: brand-specific illustration, a product render, a mascot, abstract hero art in the frame's exact palette. Prefer search_images for ordinary photography. It costs the connecting human quota or money, so write ONE considered prompt: subject, style, composition, palette hexes, lighting, what to leave out. Generation takes 20–60 seconds. ONLY generate when the design genuinely needs it or the human asked.`,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      inputSchema: {
        prompt: z.string().describe('What to draw: subject, style, composition, palette, lighting, mood'),
        aspect: z
          .enum(imageGen.IMAGE_ASPECTS)
          .optional()
          .describe('square 1024×1024 (default), landscape 1536×1024, portrait 1024×1536 — match the slot'),
        quality: z.enum(imageGen.IMAGE_QUALITIES).optional().describe('low is fast and cheap; default medium'),
        canvas_id: z.string().describe('The canvas this image belongs to'),
        agent_name: agentName,
      },
    },
    async ({ prompt, aspect, quality, canvas_id, agent_name }) => {
      if (!canvasFor(canvas_id, 'edit')) return noCanvas(canvas_id)
      const now = Date.now()
      const limitKey = ownerId ?? agent_name
      const hits = (generateHits.get(limitKey) ?? []).filter((t) => now - t < 60_000)
      if (hits.length >= GENERATIONS_PER_MIN) return err('image generation rate limit — wait a minute')
      hits.push(now)
      generateHits.set(limitKey, hits)
      try {
        const image = await imageGen.generateImage(ownerId, { prompt, aspect, quality })
        const asset = await assets.createAsset(image.buf, { canvasId: canvas_id, ownerId, uploadedBy: agent_name })
        const url = `${env.BETTER_AUTH_URL}/a/${asset.id}.${asset.ext}`
        capture(ownerId ?? agent_name, 'image_generated', {
          canvas_id,
          aspect,
          quality,
          billed_to: image.billedTo,
        })
        const result = {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  ok: true,
                  url,
                  width: image.width,
                  height: image.height,
                  mime: asset.mime,
                  size_bytes: asset.size,
                  billed_to: image.billedTo,
                  usage: `<img src="${url}" alt="" style="object-fit: cover">`,
                },
                null,
                2,
              ),
            },
            { type: 'image' as const, data: image.preview.data, mimeType: image.preview.mime },
            {
              type: 'text' as const,
              text: 'Preview above — judge it before embedding. If it misses, refine the prompt (say what was wrong) rather than regenerating blind. The URL is permanent and safe to reference in any frame.',
            },
          ],
        }
        return withFeedback(result, canvas_id, actorFrom(agent_name))
      } catch (e) {
        return err(e instanceof Error ? e.message : 'image generation failed')
      }
    },
  )

  server.registerTool(
    'search_images',
    {
      title: 'Search stock photos',
      description:
        'Search free stock photography (Pexels) and get back candidate photos WITH visual thumbnails — look at them and pick the one that fits the frame\'s mood, palette and crop. Use concrete, scene-level queries ("team collaborating loft office", not "business"). Embed the returned image_url directly in frame HTML: it is already a permanent copy on this origin, so it needs no upload_asset. Always write a real alt text.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        query: z.string().describe('Scene-level description of the photo you want'),
        orientation: z
          .enum(['landscape', 'portrait', 'square'])
          .optional()
          .describe('Match the slot the photo will fill'),
        count: z.number().min(1).max(8).optional().describe('Candidates to return, default 5'),
        canvas_id: z.string().optional().describe('The canvas you are designing on (lets human feedback reach you)'),
        agent_name: agentName,
      },
    },
    async ({ query, orientation, count, canvas_id, agent_name }) => {
      if (!imageSearch.photoSearchEnabled())
        return err(
          'photo search is not configured on this server (PEXELS_API_KEY is not set) — draw the visual as inline SVG/CSS instead, or ask your human for an image to upload',
        )
      const now = Date.now()
      const limitKey = ownerId ?? agent_name
      const hits = (searchHits.get(limitKey) ?? []).filter((t) => now - t < 60_000)
      if (hits.length >= SEARCHES_PER_MIN) return err('search rate limit — wait a minute')
      hits.push(now)
      searchHits.set(limitKey, hits)
      try {
        const photos = await imageSearch.searchPhotos(query, { orientation, count })
        if (photos.length === 0)
          return text({ ok: true, photos: [], note: `No results for "${query}" — try a broader or more visual query.` })
        const thumbs = await Promise.all(photos.map((p) => imageSearch.fetchThumb(p.thumb_url)))
        type ResultBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
        const content: ResultBlock[] = [
          {
            type: 'text' as const,
            text: `${photos.length} photo(s) for "${query}" — thumbnails below, pick by number:`,
          },
        ]
        photos.forEach((p, i) => {
          const thumb = thumbs[i]
          if (thumb) content.push({ type: 'image' as const, data: thumb.data, mimeType: thumb.mime })
          content.push({
            type: 'text' as const,
            text: `#${i + 1}${p.alt ? ` — ${p.alt}` : ''} (${p.width}×${p.height}, avg ${p.avg_color}, by ${p.photographer})\nimage_url: ${p.image_url}`,
          })
        })
        content.push({
          type: 'text' as const,
          text: 'Embed the chosen image_url directly (<img src> or CSS background, object-fit: cover), or upload_asset with source_url for a permanent copy. Pexels license: free to use and modify, no attribution required.',
        })
        const result = { content }
        return canvas_id ? withFeedbackNotice(result, canvas_id, actorFrom(agent_name)) : result
      } catch (e) {
        return err(e instanceof Error ? e.message : 'photo search failed')
      }
    },
  )

  server.registerTool(
    'list_backgrounds',
    {
      title: 'List backgrounds',
      description:
        'Browse a curated library of premium backgrounds for hero sections, section bands and bento tiles — soft glows, grainy meshes, aurora ribbons, neon, painterly landscapes — as a page of thumbnails you look at, each with palette hexes and a ready-to-paste CSS line that includes a legibility scrim. Reach for it when a hero or full-bleed section wants atmosphere, depth or a focal glow; a quiet typographic design can stay flat, but a default two-stop gradient is rarely right. Filter by tone (light/dark — match your copy color), slot and style; an optional query ("warm sunset", "dark teal") only reorders. Then decide like a designer: does one of these genuinely fit the frame\'s style and palette? If yes, use it and put the copy in its text_zone. If not, call again with a different filter, or draw the background yourself.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('Mood / palette words to put first, e.g. "warm sunset glow" — reorders, never filters'),
        tone: z
          .enum(backgrounds.BACKGROUND_TONES)
          .optional()
          .describe('light = dark copy on it, dark = light copy on it'),
        style: z.enum(backgrounds.BACKGROUND_STYLES).optional().describe('Restrict to one look'),
        slot: z
          .enum(backgrounds.BACKGROUND_SLOTS)
          .optional()
          .describe('Where it goes: hero, section band, or card/bento tile'),
        count: z.number().min(1).max(24).optional().describe('Thumbnails to return, default 12'),
        canvas_id: z.string().optional().describe('The canvas you are designing on (lets human feedback reach you)'),
        agent_name: agentName,
      },
    },
    async ({ query, tone, style, slot, count, canvas_id, agent_name }) => {
      if (!backgrounds.backgroundsEnabled())
        return err(
          'the background library is empty on this server — draw the background as CSS (layered radial-gradients with a grain overlay) instead',
        )
      try {
        const listing = backgrounds.browseBackgrounds({ query, tone, style, slot, count }, env.BETTER_AUTH_URL)
        const { results } = listing
        if (results.length === 0)
          return text({
            ok: true,
            backgrounds: [],
            note: 'No backgrounds match the tone/style/slot filters you set — drop one and call again.',
          })
        const thumbs = await Promise.all(results.map((r) => backgrounds.fetchThumb(r.id)))
        type ResultBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
        const content: ResultBlock[] = [{ type: 'text' as const, text: backgrounds.listHeadline(listing, query) }]
        results.forEach((r, i) => {
          const thumb = thumbs[i]
          if (thumb) content.push({ type: 'image' as const, data: thumb.data, mimeType: thumb.mime })
          content.push({ type: 'text' as const, text: backgrounds.describeBackground(r, i) })
        })
        content.push({ type: 'text' as const, text: backgrounds.BACKGROUND_USAGE_NOTE })
        const result = { content }
        return canvas_id ? withFeedbackNotice(result, canvas_id, actorFrom(agent_name)) : result
      } catch (e) {
        return err(e instanceof Error ? e.message : 'background search failed')
      }
    },
  )

  server.registerTool(
    'search_icons',
    {
      title: 'Search icons',
      description:
        'Search 200,000+ open-source UI icons (Iconify: Material, Lucide, Tabler, Phosphor, …) and get hotlinkable SVG URLs for frame HTML. Search one concept per call ("shopping cart", "arrow right") — multi-concept queries return nothing; call once per icon. Results are semantically named ids — pick by name. For company/brand logos use search_logos instead.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        query: z.string().describe('A single icon concept, e.g. "light bulb"'),
        limit: z.number().min(1).max(48).optional().describe('Max results, default 24'),
        canvas_id: z.string().optional().describe('The canvas you are designing on (lets human feedback reach you)'),
        agent_name: agentName,
      },
    },
    async ({ query, limit, canvas_id, agent_name }) => {
      try {
        const icons = await imageSearch.searchIcons(query, { limit })
        const result = text({
          ok: true,
          icons,
          ...(icons.length === 0 ? { note: `No results for "${query}" — try a synonym or broader concept.` } : {}),
          usage: imageSearch.ICON_USAGE_NOTE,
        })
        return canvas_id ? withFeedbackNotice(result, canvas_id, actorFrom(agent_name)) : result
      } catch (e) {
        return err(e instanceof Error ? e.message : 'icon search failed')
      }
    },
  )

  server.registerTool(
    'search_logos',
    {
      title: 'Search company logos',
      description:
        'Find a company\'s logo by brand name or domain — returns the company\'s real mark as a hotlinkable URL (a thumbnail is included when possible so you can confirm the brand), plus open-source vector marks (SVG) for well-known brands. One company per call — for a logo wall, call once per brand. The exact domain ("acme.io") resolves far more reliably than a name ("Acme"). Use for customer-logo walls, "works with" integration rows, testimonial cards, press bars. Mind each result\'s size guidance: favicon-sourced logos are small rasters — never scale them up.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        query: z.string().describe('A single company name or domain, e.g. "vercel.com"'),
        count: z.number().min(1).max(8).optional().describe('Candidates to return, default 5'),
        canvas_id: z.string().optional().describe('The canvas you are designing on (lets human feedback reach you)'),
        agent_name: agentName,
      },
    },
    async ({ query, count, canvas_id, agent_name }) => {
      const now = Date.now()
      const limitKey = ownerId ?? agent_name
      const hits = (searchHits.get(limitKey) ?? []).filter((t) => now - t < 60_000)
      if (hits.length >= SEARCHES_PER_MIN) return err('search rate limit — wait a minute')
      hits.push(now)
      searchHits.set(limitKey, hits)
      try {
        const { brands, vector } = await imageSearch.lookupLogos(query, count)
        if (brands.length === 0 && vector.length === 0)
          return text({
            ok: true,
            logos: [],
            note: `No logo found for "${query}" — retry with the company's exact domain (e.g. "acme.io"). If that also fails, search a different real brand instead of drawing a placeholder, or ask your human for a logo file to upload_asset.`,
          })
        type ResultBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
        const content: ResultBlock[] = [{ type: 'text' as const, text: `Logo results for "${query}":` }]
        const brandBlocks: ResultBlock[] = []
        if (brands.length > 0) {
          const thumbs = await Promise.all(brands.map((b) => b.thumb ?? imageSearch.fetchThumb(b.thumb_url)))
          brands.forEach((b, i) => {
            const thumb = thumbs[i]
            if (thumb) brandBlocks.push({ type: 'image' as const, data: thumb.data, mimeType: thumb.mime })
            brandBlocks.push({
              type: 'text' as const,
              text: `#${i + 1} — ${b.name} (${b.domain})${b.source === 'favicon' ? ' · favicon' : ''}\nlogo_url: ${b.logo_url}`,
            })
          })
        }
        const vectorBlocks: ResultBlock[] =
          vector.length > 0
            ? [
                {
                  type: 'text' as const,
                  text: `Open-source vector marks:\n${vector.map((v) => `${v.id} → ${v.svg_url}`).join('\n')}`,
                },
              ]
            : []
        if (imageSearch.vectorFirst(brands, vector)) content.push(...vectorBlocks, ...brandBlocks)
        else content.push(...brandBlocks, ...vectorBlocks)
        content.push({ type: 'text' as const, text: imageSearch.LOGO_USAGE_NOTE })
        const result = { content }
        return canvas_id ? withFeedbackNotice(result, canvas_id, actorFrom(agent_name)) : result
      } catch (e) {
        return err(e instanceof Error ? e.message : 'logo search failed')
      }
    },
  )

  server.registerTool(
    'view_website',
    {
      title: 'View a website',
      description:
        'Read-only inspection of a public web page: acquires its current HTML and returns a locally rendered desktop screenshot plus visible text without changing the canvas. Use it to study real copy, structure and branding. When the page should appear on the canvas as an editable source frame, use import_webpage instead.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        url: z.string().describe('The page URL — a bare domain like "acme.io" is loaded over https'),
        agent_name: agentName,
      },
    },
    async ({ url, agent_name }) => {
      const now = Date.now()
      const limitKey = ownerId ?? agent_name
      const hits = (searchHits.get(limitKey) ?? []).filter((t) => now - t < 60_000)
      if (hits.length >= SEARCHES_PER_MIN) return err('rate limit — wait a minute')
      hits.push(now)
      searchHits.set(limitKey, hits)
      try {
        const site = await viewWebsite(url)
        const result = {
          content: [
            { type: 'image' as const, data: site.screenshot.toString('base64'), mimeType: 'image/jpeg' },
            {
              type: 'text' as const,
              text:
                `${site.title || site.finalUrl} — ${site.finalUrl}` +
                (site.description ? `\nMeta description: ${site.description}` : '') +
                (site.shotCropped
                  ? `\nNote: the page is ${site.pageHeight}px tall — the screenshot shows only the top portion.`
                  : '') +
                `\n\nVisible page text${site.textTruncated ? ' (truncated)' : ''}:\n${site.text}`,
            },
          ],
        }
        return result
      } catch (e) {
        return err(
          websiteAccessErrorMessage(e, 'connected-agent') ?? (e instanceof Error ? e.message : 'website view failed'),
        )
      }
    },
  )

  server.registerTool(
    'import_webpage',
    {
      title: 'Import an editable webpage',
      _meta: previewMeta('Importing the webpage…', 'Webpage imported'),
      description:
        'Import ONE public webpage into a canvas as an editable HTML snapshot. The rendered DOM is captured, scripts/iframes are removed, stylesheets are inlined, and the resulting source frame appears on the canvas for comparison or editing. Use this when a referenced or redesign-target page should be visible to everyone; leave the imported source frame unchanged and make the new design in a separate frame. For inspection without changing the canvas, use view_website.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      inputSchema: {
        url: z.string().describe('The page URL — a bare domain like "acme.io" is loaded over https'),
        canvas_id: z.string().describe('Canvas that should receive the imported source frame'),
        agent_name: agentName,
      },
    },
    async ({ url, canvas_id, agent_name }) => {
      if (!canvasFor(canvas_id, 'edit')) return noCanvas(canvas_id)
      let normalizedUrl: string
      try {
        normalizedUrl = normalizeImportUrl(url).href
      } catch (e) {
        return err(e instanceof Error ? e.message : 'invalid webpage URL')
      }
      const now = Date.now()
      const limitKey = ownerId ?? agent_name
      const hits = (importHits.get(limitKey) ?? []).filter((t) => now - t < 60_000)
      if (hits.length >= IMPORTS_PER_MIN) return err('webpage import rate limit — wait a minute')
      hits.push(now)
      importHits.set(limitKey, hits)
      try {
        const actor = actorFrom(agent_name)
        const { imported, frame } = await createImportedWebpageFrame({
          canvasId: canvas_id,
          url: normalizedUrl,
          actor,
          includePreview: true,
        })
        if (!frame) return noCanvas(canvas_id)

        const preview = imported.preview
        const content: Array<{ type: 'image'; data: string; mimeType: string } | { type: 'text'; text: string }> = []
        if (preview) {
          content.push({ type: 'image', data: preview.screenshot.toString('base64'), mimeType: 'image/jpeg' })
        }
        content.push({
          type: 'text',
          text:
            JSON.stringify(
              {
                ok: true,
                frame: frameSummary(frame),
                source_url: preview?.finalUrl ?? normalizedUrl,
                snapshot: 'editable HTML; scripts, iframes and noscript content removed; linked stylesheets inlined',
              },
              null,
              2,
            ) +
            (preview?.description ? `\nMeta description: ${preview.description}` : '') +
            (preview?.shotCropped
              ? `\nThe source page is ${preview.pageHeight}px tall; the preview shows its top 4000px.`
              : '') +
            (preview ? `\n\nVisible source text${preview.textTruncated ? ' (truncated)' : ''}:\n${preview.text}` : '') +
            '\n\nThe editable snapshot is now on the canvas. If it is source material for a separate design, leave it unchanged; if the import itself is the requested deliverable, it is ready to use or edit.',
        })
        const result = { content }
        return withPreview(withStatusNudge(withFeedback(result, canvas_id, actor), canvas_id, actor), canvas_id, [
          frame,
        ])
      } catch (e) {
        return err(
          websiteAccessErrorMessage(e, 'connected-agent') ?? (e instanceof Error ? e.message : 'webpage import failed'),
        )
      }
    },
  )

  /* extension tools get the same
     per-session helpers the built-in tools close over */
  const extensionHelpers: McpToolHelpers = {
    ownerId,
    agentName,
    actorFrom,
    canvasFor,
    noCanvas,
    err,
    text,
    textWithNudge,
    withFeedback,
    withStatusNudge,
    frameSummary,
    takeImportSlot: (key) => {
      const now = Date.now()
      const hits = (importHits.get(key) ?? []).filter((t) => now - t < 60_000)
      if (hits.length >= IMPORTS_PER_MIN) return false
      hits.push(now)
      importHits.set(key, hits)
      return true
    },
  }
  for (const extension of extensions) extension.registerMcpTools?.(server, extensionHelpers)

  for (const tool of COMPONENT_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        annotations: {
          readOnlyHint: tool.readOnly,
          destructiveHint: tool.destructive ?? false,
          idempotentHint: tool.readOnly,
          openWorldHint: false,
        },
        inputSchema: { canvas_id: z.string(), ...tool.shape, agent_name: agentName.optional() } as never,
      },
      (async (raw: Record<string, unknown>) => {
        const canvasId = String(raw.canvas_id)
        const agent = raw.agent_name as string | undefined
        const canvas = canvasFor(canvasId, tool.readOnly ? 'view' : 'edit')
        if (!canvas) return noCanvas(canvasId)
        arrive(canvasId, agent)
        const actor = actorFrom(agent)
        const outcome = await runComponentTool(tool.name, raw, {
          canvas,
          actor,
          canRead: (id) => !!canvasFor(id, 'view'),
          canEdit: (id) => !!canvasFor(id, 'edit'),
          readableCanvases: () =>
            workspaces.canvasesFor(ownerId ?? '').flatMap((meta) => store.getCanvas(meta.id) ?? []),
          userId: ownerId,
        })
        if (!outcome.ok) return err(outcome.error)
        const { data, note, frames } = outcome.result
        const libraryEvent = libraryFeatureEvent(tool.name, raw, data)
        if (libraryEvent) captureFeature(ownerId, libraryEvent, 'mcp', { canvas_id: canvasId })
        const result = note ? textWithNudge(data, note) : text(data)
        for (const frame of frames ?? []) withComponentNotes(result, frame)
        return tool.readOnly
          ? withFeedbackNotice(result, canvasId, agent ? actor : undefined)
          : withFeedback(result, canvasId, actor)
      }) as never,
    )
  }

  server.registerTool(
    'get_component_preview',
    {
      title: 'See a component',
      description: previewDescription,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        canvas_id: z.string(),
        component: z.string(),
        props: previewProps,
        agent_name: agentName.optional(),
      },
    },
    async ({ canvas_id, component, props, agent_name }) => {
      if (!canvasFor(canvas_id, 'view')) return noCanvas(canvas_id)
      arrive(canvas_id, agent_name)
      const def = findComponent(canvas_id, component)
      if (!def) return err(`no component “${component}” on this canvas`)
      try {
        const sheet = previewFrame(canvas_id, def, previewCombinations(def, props))
        const png = await renderFrame(sheet, 1)
        return {
          content: [
            { type: 'image' as const, data: png.toString('base64'), mimeType: 'image/png' },
            { type: 'text' as const, text: `${componentSignature(def)} at revision ${def.rev}` },
          ],
        }
      } catch (e) {
        return err(e instanceof Error ? e.message : 'render failed')
      }
    },
  )

  server.registerTool(
    'inspect_frame',
    {
      title: 'Inspect a rendered frame',
      description:
        "Render a frame and read it as data rather than pixels: the design in use (colours, backgrounds, fonts, sizes, radii, shadows, CSS variables), an outline of its key elements with text, box (design px) and computed style, and `problems`: content past the frame's edge, text cut off by its box, and text or controls overlapping. Problems are candidates to check against the screenshot: a deliberate overlap (stacked avatars, a label on a photo) or a clipped preview is fine as it is. Pass selectors to report on those elements instead of the automatic outline (a data-doop-id, a class, any CSS selector). Use it with get_frame_screenshot to pin down what looks wrong, and before editing a large frame.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        frame_id: z.string(),
        selectors: z
          .array(z.string())
          .max(20)
          .optional()
          .describe('CSS selectors to report on (up to 20 matches each) instead of the automatic outline'),
        agent_name: agentName.optional(),
      },
    },
    async ({ frame_id, selectors, agent_name }) => {
      const f = frameFor(frame_id, 'view')
      if (!f) return noFrame(frame_id)
      arrive(f.canvasId, agent_name)
      try {
        const inspection = await inspectFrame({ ...f }, { selectors })
        return withFeedbackNotice(
          text({ ...inspection, approvalStatus: f.approval?.status ?? 'draft' }),
          f.canvasId,
          agent_name ? actorFrom(agent_name) : undefined,
        )
      } catch (e) {
        return err(e instanceof Error ? e.message : 'inspection failed')
      }
    },
  )

  server.registerTool(
    'get_frame_screenshot',
    {
      title: 'Screenshot a frame',
      _meta: previewMeta('Rendering the frame…', 'Frame rendered'),
      description:
        'Render a frame and return a PNG screenshot of it — this is how you SEE your design. Always review your work with this after creating or updating a frame, then fix what looks wrong (spacing, overflow, contrast, alignment) and check again. Iterate until it actually looks good, not just until the HTML seems right.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        frame_id: z.string(),
        scale: z
          .union([z.literal(1), z.literal(2)])
          .optional()
          .describe('Device scale factor: 1 (default) or 2 for a retina-resolution image'),
        agent_name: agentName.optional(),
      },
    },
    async ({ frame_id, scale, agent_name }) => {
      const live = frameFor(frame_id, 'view')
      if (!live) return noFrame(frame_id)
      arrive(live.canvasId, agent_name)
      /* a snapshot: an edit landing while Chromium renders must not stamp
         this older image with its newer updatedAt, or the cache would serve
         it as current for the next five minutes */
      const f = { ...live }
      try {
        const png = await renderFrame(f, scale ?? 1)
        /* the ChatGPT card loads this exact image next — serve it from cache */
        primeImage(f, scale ?? 1, png)
        return withPreview(
          withFeedbackNotice(
            {
              content: [
                { type: 'image' as const, data: png.toString('base64'), mimeType: 'image/png' },
                {
                  type: 'text' as const,
                  text: `Screenshot of “${f.name}” (${f.width}×${f.height}@${scale ?? 1}x, html ${f.html.length} bytes)${croppedNote(f, scale ?? 1)}`,
                },
              ],
            },
            f.canvasId,
            agent_name ? actorFrom(agent_name) : undefined,
          ),
          f.canvasId,
          [f],
        )
      } catch (e) {
        return err(`screenshot failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  )

  server.registerTool(
    'append_frame_html',
    {
      title: 'Stream HTML into a frame',
      description:
        'Stream a design into a frame section by section — every chunk renders for viewers the moment it arrives, so they watch the design build up live. Prefer this over set_frame_html when creating or reworking a whole design. Send the HTML in document order, ONE complete section per call (head+styles first, then the hero, then each following section), roughly 1–4 KB per chunk. Set start=true on the FIRST chunk (replaces any existing content and shows a live "designing…" badge) and done=true on the LAST chunk. End chunks at element boundaries — partial HTML is healed, but a complete section paints cleanly. When reworking, keep data-doop-* attributes on elements you carry over (comments and links point at data-doop-id). ' +
        COMPOSE_CHECK,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        frame_id: z.string(),
        html_chunk: z
          .string()
          .describe('The next piece of HTML, appended to what has been sent so far. Raw markup — never escaped.'),
        start: z.boolean().optional().describe('true on the first chunk — clears the frame and starts the live stream'),
        done: z.boolean().optional().describe('true on the final chunk — ends the live stream'),
        agent_name: agentName,
      },
    },
    async ({ frame_id, html_chunk, start, done, agent_name }) => {
      const current = frameFor(frame_id, 'edit')
      if (!current) return noFrame(frame_id)
      /* the agent's own text: the end of its stream so far joined to this chunk, so a data:
         URI's prefix split across chunks is caught, and so is a block of base64 text sent in
         pieces each too short to be one. Never the stored HTML of a stream in progress, where a
         component's image expanded mid-stream would read as an upload; but a chunk appended
         after its stream ended is joined to the frame as stored, so the end of that is what
         it is read with (a stream that ends is healed, its open tags closed, so a block
         cannot in fact go on from one: this is for the case it ever could). Compared with the design the stream replaced: a rework may carry
         over what the frame had. */
      const base = actions.streamBase(frame_id) ?? current.html
      const before = start ? '' : (actions.streamTail(frame_id) ?? current.html.slice(-EMBEDDED_MIN_LENGTH))
      const refusal = inlineDataRefusal(before + html_chunk, base)
      /* refused only for what it completes: the earlier pieces are in the frame already */
      const completes = refusal && before && !inlineDataRefusal(html_chunk, base)
      const inline = completes
        ? `${refusal.replace('Refused, nothing was written:', 'Refused, this chunk was not written:')}\nThe size above counts what your earlier chunks sent too: the start of that block is already in the frame. Begin the frame again (start=true) and stream it without the block.`
        : refusal
      if (inline) return err(inline)
      const frame = actions.appendFrameHtml(frame_id, html_chunk, actorFrom(agent_name), { start, done })
      if (!frame) return noFrame(frame_id)
      const result = withNotesFirst(
        done
          ? textWithNudge(
              { ok: true, streaming: false, htmlBytes: frame.html.length },
              `Stream complete. ${REVIEW_NUDGE}`,
            )
          : text({ ok: true, streaming: true, htmlBytes: frame.html.length }),
        streamChunkNotes(frame, { start, done }),
      )
      /* nudge only on the first chunk — mid-stream results should stay lean.
         The escape check rides along: the opening chunk decides the stream. */
      const nudged = start
        ? withGuidelinesNudge(withEscapeNote(result, html_chunk), frame.canvasId, actorFrom(agent_name))
        : result
      return withStatusNudge(
        withFeedback(nudged, frame.canvasId, actorFrom(agent_name)),
        frame.canvasId,
        actorFrom(agent_name),
      )
    },
  )

  server.registerTool(
    'edit_frame_html',
    {
      title: 'Edit a frame’s HTML in place',
      _meta: previewMeta('Editing the frame…', 'Frame edited'),
      description:
        'Make a targeted edit to a frame: exact find-and-replace in its HTML, as get_frame returned it (a <doop-use> can be edited like any tag). Use this for small tweaks (copy, a color, spacing, one element) instead of resending the whole document — the change morphs into the rendered frame in place. old_str must appear EXACTLY ONCE in the current HTML (call get_frame first if unsure); include enough surrounding context to make it unique. Keep data-doop-* attributes on the element you edit: comments and links point at its data-doop-id.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        frame_id: z.string(),
        old_str: z.string().describe('Exact text to find in the frame HTML — must occur exactly once'),
        new_str: z.string().describe('Replacement text'),
        agent_name: agentName,
      },
    },
    async ({ frame_id, old_str, new_str, agent_name }) => {
      const f = frameFor(frame_id, 'edit')
      if (!f) return noFrame(frame_id)
      const edited = editFrameSource(f, old_str, new_str)
      if ('error' in edited) return err(edited.error)
      /* the edited document, so a URI completed across the replacement's edges is caught too */
      const inline = inlineDataRefusal(edited.html, heldForms(f))
      if (inline) return err(inline)
      const frame = actions.updateFrame(frame_id, { html: edited.html }, actorFrom(agent_name))!
      return withPreview(
        withStatusNudge(
          withFeedback(
            withComponentNotes(textWithNudge({ ok: true, frame: frameSummary(frame) }, REVIEW_NUDGE), frame),
            frame.canvasId,
            actorFrom(agent_name),
          ),
          frame.canvasId,
          actorFrom(agent_name),
        ),
        frame.canvasId,
        [frame],
      )
    },
  )

  server.registerTool(
    'update_frame',
    {
      title: 'Rename, move or resize a frame',
      _meta: previewMeta('Updating the frame…', 'Frame updated'),
      description:
        "Update frame metadata in one call: rename it (name), move it on its page (x, y), resize it (width, height), turn it (rotation: degrees clockwise about its centre; 0 straightens it), or move it to another page (pageId from get_canvas; it keeps its x/y unless you pass new ones and lands in front of that page's frames). Set locked to true to lock the frame on the canvas (humans cannot select, move, resize or delete it from the stage until it is unlocked) or false to unlock it.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        frame_id: z.string(),
        pageId: z.string().optional(),
        name: z.string().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        locked: z.boolean().optional(),
        rotation: z.number().optional(),
        agent_name: agentName,
      },
    },
    async ({ frame_id, agent_name, ...patch }) => {
      const found = frameFor(frame_id, 'edit')
      const canvas = found && store.getCanvas(found.canvasId)
      if (!canvas) return noFrame(frame_id)
      const updated = updateFrameMeta(canvas, frame_id, patch, actorFrom(agent_name))
      if (!updated.ok) return err(updated.error)
      const frame = updated.value
      return withPreview(
        withFeedback(text({ ok: true, frame: frameSummary(frame) }), frame.canvasId, actorFrom(agent_name)),
        frame.canvasId,
        [frame],
      )
    },
  )

  server.registerTool(
    'set_frame_approval',
    {
      title: 'Mark a frame ready for dev, or move it back to draft',
      description:
        'Set a frame\'s sign-off for the person you work for: status "ready_for_dev" marks the current design approved for implementation, "draft" withdraws an approval. Only when a human asks you to: never approve your own designs on your own initiative, and never to get past a review. The approval is recorded as theirs, made through you (approval.approvedBy is the person, approval.approvedVia your agent_name), and it starts any approval automations on the canvas just as a human sign-off does. Editing the HTML or size afterwards moves it to needs_review, as for every approval.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        frame_id: z.string(),
        status: z.enum(['ready_for_dev', 'draft']),
        agent_name: agentName,
      },
    },
    async ({ frame_id, status, agent_name }) => {
      if (!ownerId || !owner) return err('this connection is not signed in to a Doop account')
      const found = frameFor(frame_id, 'edit')
      if (!found) return noFrame(frame_id)
      const actor = actorFrom(agent_name)
      arrive(found.canvasId, agent_name)
      const result = actions.agentSetFrameApproval(frame_id, status, { id: ownerId, name: owner }, actor)
      if (!result.ok) return err(result.error)
      return withFeedback(text({ ok: true, frame: frameSummary(result.frame) }), result.frame.canvasId, actor)
    },
  )

  server.registerTool(
    'list_frame_versions',
    {
      title: 'List a frame’s version history',
      description:
        'List the earlier states of a frame, newest first: every design a replace, stream or restore overwrote, with who authored it and when. HTML is not included — restore_frame_version brings a state back, get_frame shows the current one.',
      inputSchema: { frame_id: z.string(), agent_name: agentName.optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ frame_id, agent_name }) => {
      const f = frameFor(frame_id, 'view')
      if (!f) return noFrame(frame_id)
      arrive(f.canvasId, agent_name)
      const versions = await persist.listFrameVersions(frame_id)
      return text({
        frame: frameSummary(f),
        versions: versions.map((v) => ({
          id: v.id,
          savedBy: v.savedBy,
          savedByKind: v.savedByKind,
          savedAt: new Date(v.savedAt).toISOString(),
          width: v.width,
          height: v.height,
          htmlBytes: v.htmlBytes,
        })),
      })
    },
  )

  server.registerTool(
    'restore_frame_version',
    {
      title: 'Restore an earlier version of a frame',
      description:
        'Put a frame back to one of its earlier states (from list_frame_versions): its HTML and size are restored, name and position stay. The design being replaced is filed as a version first, so a restore can itself be undone. Use it when a human asks for the previous version, or when your own rework turned out worse than what was there.',
      inputSchema: { frame_id: z.string(), version_id: z.string(), agent_name: agentName },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ frame_id, version_id, agent_name }) => {
      if (!frameFor(frame_id, 'edit')) return noFrame(frame_id)
      const restored = await actions.restoreFrameVersion(frame_id, version_id, actorFrom(agent_name))
      if (restored === null) return err(`no version ${version_id} on frame ${frame_id} — call list_frame_versions`)
      if (!restored) return noFrame(frame_id)
      captureFeature(ownerId, 'frame_version_restored', 'mcp', { canvas_id: restored.frame.canvasId })
      return withFeedback(
        textWithNudge({ ok: true, frame: frameSummary(restored.frame) }, REVIEW_NUDGE),
        restored.frame.canvasId,
        actorFrom(agent_name),
      )
    },
  )

  server.registerTool(
    'delete_frame',
    {
      title: 'Delete a frame',
      description: 'Delete a frame from its canvas.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: { frame_id: z.string(), agent_name: agentName },
    },
    async ({ frame_id, agent_name }) => {
      if (!frameFor(frame_id, 'edit')) return noFrame(frame_id)
      const frame = actions.deleteFrame(frame_id, actorFrom(agent_name))
      if (!frame) return noFrame(frame_id)
      return text({ ok: true, deleted: frame.name })
    },
  )

  return server
}

/** Stateless streamable-HTTP MCP endpoint. */
/* what the protected-resource document advertises; ChatGPT requests exactly these */
const MCP_SCOPES = ['openid', 'profile', 'email', 'offline_access']

const ANONYMOUS_METHODS = new Set(['ping', 'resources/list', 'resources/read'])

/** True for a single JSON-RPC message that only reads static server metadata. */
export function isAnonymousDiscovery(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  const method = (body as { method?: unknown }).method
  return typeof method === 'string' && ANONYMOUS_METHODS.has(method)
}

/* Every HTTP request gets a fresh server, so the name a client sent in
   initialize is gone by the time it calls a tool. Remember it per credential
   (a hash of the bearer, never the bearer itself); for OAuth clients the
   registered application name also survives a restart. */
const MAX_REMEMBERED_CLIENTS = 10_000
const clientNamesByCredential = new Map<string, string>()
const oauthClientNames = new Map<string, string | undefined>()

const credentialKey = (bearer: string) => createHash('sha256').update(bearer).digest('hex')

/** An outside agent's identity (shared/agentIdentity.ts): its account and
 *  the name it goes by, hashed so it can be shown and stored. Two people's
 *  agents sharing a name are two agents.
 *
 *  Not the MCP session: clients start sessions far more often than an agent
 *  starts work (Codex and other OpenAI clients one per tool call, Claude Code
 *  in bursts), so a session-scoped key would split one agent into many. One
 *  person's two agents of one name are therefore one agent. */
export function mcpAgentKey(ownerId: string | undefined, name: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([ownerId ?? '', name]))
    .digest('base64url')
  return `mcp:${digest.slice(0, 22)}`
}

function rememberClientName(bearer: string, name: unknown) {
  if (typeof name !== 'string' || !name.trim()) return
  const key = credentialKey(bearer)
  clientNamesByCredential.delete(key)
  clientNamesByCredential.set(key, name.trim().slice(0, 80))
  if (clientNamesByCredential.size > MAX_REMEMBERED_CLIENTS) {
    const oldest = clientNamesByCredential.keys().next().value
    if (oldest) clientNamesByCredential.delete(oldest)
  }
}

async function oauthClientName(clientId: string): Promise<string | undefined> {
  if (oauthClientNames.has(clientId)) return oauthClientNames.get(clientId)
  const [app] = await db
    .select({ name: authSchema.oauthApplication.name })
    .from(authSchema.oauthApplication)
    .where(eq(authSchema.oauthApplication.clientId, clientId))
  if (oauthClientNames.size >= MAX_REMEMBERED_CLIENTS) oauthClientNames.clear()
  oauthClientNames.set(clientId, app?.name)
  return app?.name
}

export async function handleMcpRequest(req: Request, res: Response) {
  if (req.method !== 'POST') {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed. This MCP endpoint is stateless; use POST.' },
      id: null,
    })
    return
  }
  /* Two ways in, one identity. An agent key (`Authorization: Bearer dpk_…`,
     minted in Settings) is the headless path — Mastra, n8n, CI — where the
     OAuth browser dance has nobody to dance it. It resolves to its owner on
     every request, so revocation and bans bite immediately; a recognised but
     invalid key gets a 401 WITHOUT the WWW-Authenticate pointer, because
     sending a headless client into OAuth discovery helps nobody. Everything
     else falls through to the OAuth gate below. */
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]
  let session: { userId?: string | null; clientId?: string | null } | null
  if (bearer && isAgentKeySecret(bearer)) {
    session = await verifyAgentKey(bearer)
    if (!session) {
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized: unknown or revoked agent key' },
        id: null,
      })
      return
    }
  } else {
    /* OAuth gate: the 401 + WWW-Authenticate header is what triggers the
       browser approval flow in MCP clients (RFC 9728 discovery). */
    session = await auth.api.getMcpSession({ headers: fromNodeHeaders(req.headers) }).catch(() => null)
  }
  /* ChatGPT re-fetches a rendered card's component template (resources/read)
     without a usable token — after a token rotation, or when an old chat is
     reopened — so gating discovery would strand every card ever rendered.
     The template is static and the resource list carries no user data, so
     those two (and ping) answer anonymously; tools stay behind the gate. */
  const anonymous = !session && isAnonymousDiscovery(req.body)
  if (!session && !anonymous) {
    const origin = `${req.protocol}://${req.get('host')}`
    /* RFC 6750 §3.1: no error attribute when no token was presented; with a
       token that did not validate, invalid_token tells ChatGPT to re-link
       rather than retry. Both the header and `_meta` carry the challenge —
       ChatGPT offers Connect only when it finds it in both. */
    const challenge = [
      'Bearer realm="doop"',
      `resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
      `scope="${MCP_SCOPES.join(' ')}"`,
      ...(bearer ? ['error="invalid_token"', 'error_description="The access token is expired or not valid"'] : []),
    ].join(', ')
    res
      .status(401)
      .set('WWW-Authenticate', challenge)
      .json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized: this MCP server requires OAuth' },
        id: null,
        _meta: { 'mcp/www_authenticate': [challenge] },
      })
    return
  }
  /* banning revokes browser sessions, but an already-issued MCP token keeps
     validating until it expires — refuse it here so a ban is total */
  if (session?.userId && (await isBanned(session.userId))) {
    res.status(403).json({
      jsonrpc: '2.0',
      error: { code: -32003, message: 'This account has been disabled on this server.' },
      id: null,
    })
    return
  }
  /* A custom (bring-your-own) agent talking to us is the behavior we want to
     grow — instrument it. `initialize` marks a fresh client session (and is
     the only message carrying the client's name); tool calls mark actual use,
     throttled because one design task is dozens of calls. */
  if (session?.userId) {
    const msgs = Array.isArray(req.body) ? req.body : [req.body]
    for (const msg of msgs) {
      if (msg?.method === 'initialize') {
        if (bearer) rememberClientName(bearer, msg.params?.clientInfo?.name)
        capture(session.userId, 'custom_agent_connected', {
          agent_client: msg.params?.clientInfo?.name,
          agent_client_version: msg.params?.clientInfo?.version,
        })
      } else if (msg?.method === 'tools/call') {
        captureThrottled(session.userId, 'custom_agent_used', { first_tool: msg.params?.name })
      }
    }
  }
  const owner = session?.userId ? await getUserName(session.userId) : undefined
  const oauthClientId = session?.clientId
  const clientName =
    (bearer ? clientNamesByCredential.get(credentialKey(bearer)) : undefined) ??
    (oauthClientId ? await oauthClientName(oauthClientId) : undefined)
  const server = buildMcpServer(owner, session?.userId ?? undefined, clientName)
  /* Stateless, and plain JSON rather than an SSE stream per response: no
     tool here sends notifications mid-call, so a stream carries nothing a
     JSON body does not, and JSON is what every client — including ChatGPT's
     narrower template-fetch path, whose Accept the SDK would otherwise
     refuse with 406 — can read. The header is normalised to match. */
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  req.headers.accept = 'application/json, text/event-stream'
  res.on('close', () => {
    /* the client is gone; there is nobody left to report a close failure to */
    void transport.close()
    void server.close()
  })
  try {
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  } catch (e) {
    console.error('mcp error', e)
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null })
    }
  }
}
