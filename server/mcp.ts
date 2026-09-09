import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Request, Response } from 'express'
import { fromNodeHeaders } from 'better-auth/node'
import { z } from 'zod'
import { store } from './store.ts'
import * as actions from './actions.ts'
import { canAccessCanvas } from './access.ts'
import { auth, getUserName, isBanned, PUBLIC_ORIGIN } from './auth.ts'
import { capture, captureThrottled } from './analytics.ts'
import { renderFrame } from './screenshot.ts'
import { DOOP_GUIDE, GUIDE_TOPICS } from './guide.ts'
import { describeInspiration, INSPIRATION_USAGE_NOTE, searchInspiration } from './inspiration.ts'
import { ESCAPED_HTML_NOTE, looksEscapedHtml } from './escapedHtml.ts'
import { describeSyncFlow, getSyncFlow } from './ingest.ts'
import * as assets from './assets.ts'
import * as imageSearch from './imageSearch.ts'
import * as backgrounds from './backgrounds.ts'
import { viewWebsite } from './website.ts'
import { createImportedWebpageFrame } from './webpageImport.ts'
import { normalizeImportUrl } from './importer.ts'
import { websiteAccessErrorMessage } from './websiteAccess.ts'

const INSTRUCTIONS = `Doop is a shared multiplayer design canvas: humans and AI agents design together in real time. Canvases contain frames — artboards that render complete HTML documents live for everyone viewing.

You MUST call get_guide({ topic: "doop-instructions" }) once before using other Doop tools. Call it again if a long conversation may have compressed or dropped the guide text.

- Context first: call get_canvas before adding or editing frames.
- Identity: pick an agent_name and reuse the SAME name on every call — your presence and edits are attributed live.
- Narrate: call set_status with a one-line summary when you start a task and whenever your focus shifts — people watching the canvas see it live next to your name.
- Creating: create_frame, then stream the design with append_frame_html one complete section at a time (~1–4 KB chunks; start=true on the first, done=true on the last). Each chunk renders the moment it arrives — viewers watch you work.
- Review: after every create or significant edit you MUST call get_frame_screenshot and fix what looks wrong before moving on.
- Small edits: edit_frame_html (exact find/replace — the change morphs into the rendered frame in place). Full redesigns: set_frame_html or a new stream. Rename/move/resize: update_frame.
- Images: real imagery makes designs. search_images finds stock photos (you SEE thumbnails and pick), search_icons finds 200k+ UI icons as hotlinkable SVGs, search_logos finds real company logos by brand name or domain — call it once per brand BEFORE writing any logo wall, integration row, press bar or testimonial, and never ship a placeholder tile, "LOGO" text or an invented wordmark in its place, search_backgrounds finds curated hero/section/bento backgrounds (glows, grainy meshes, aurora, painterly scenes) with thumbnails — call it BEFORE writing a hero or any full-bleed section instead of settling for a flat CSS gradient, upload_asset stores your own file (remote file → source_url; local file → local_file=true, returns a curl command) and returns a permanent URL. Never inline images as data: URIs.
- Websites: when a request names an existing site or URL — a redesign of it, or "like acme.com" — call import_webpage FIRST so an editable HTML snapshot lands on the canvas. Leave that source frame unchanged and design in a separate frame. view_website is only for read-only inspection when the page should not be added. If Doop cannot capture the site, do not retry with view_website because it uses the same capture path. Use your own browser or web tool and work only from content you actually observe; if that is unavailable, ask the user for screenshots or an HTML export rather than inventing content.
- Feedback: humans reply to your tasks; their notes arrive inside your tool results as HUMAN FEEDBACK blocks — address them before continuing.
- Comments: call get_comments to read element-pinned comments and replies on a canvas, optionally filtered by frame. This does not claim feedback or resolve comments.
- Guidelines: canvases can carry named style guides (brand rules, style recipes). get_canvas lists them with one-line summaries — read the relevant ones with get_guidelines BEFORE designing and follow them.
- Memory: canvases can also carry pinned style references — exemplar designs humans marked as "more like this". get_canvas lists them; read the relevant one with get_reference and match its look. When your human gives you design feedback in conversation and you address it, record it with save_decision so the canvas remembers their taste.`

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

import type { Actor } from '../shared/types.ts'

/** Reaches agents whose session predates set_status (or who skipped the guide). */
function withStatusNudge<T extends { content: { type: 'text' | 'image'; [k: string]: unknown }[] }>(
  result: T,
  canvasId: string,
  actor?: Actor,
): T {
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
  if (docs.length === 0 || actions.hasSeenGuidelines(canvasId, actor.name)) return result
  result.content.push({
    type: 'text' as const,
    text: `This canvas has style guides you have not read: ${docs.map((d) => d.name).join(', ')}. Call get_guidelines({ canvas_id, name }) for each relevant one NOW and make your design follow them.`,
  })
  return result
}

/** Append any undelivered human feedback for this agent to a tool result.
 *  MCP is pull-based, so this is the channel through which humans steer agents. */
function withFeedback<T extends { content: { type: 'text' | 'image'; [k: string]: unknown }[] }>(
  result: T,
  canvasId: string,
  actor?: Actor,
): T {
  if (!actor) return result
  const pending = actions.takeFeedbackFor(canvasId, actor.name)
  if (pending.length === 0) return result
  const tasks = actions.getTasks(canvasId)
  const lines = pending.map((f) => {
    const task = tasks.find((t) => t.id === f.taskId)
    const mine = task && task.agentName === actor.name
    const about = task ? ` (about ${mine ? 'your' : `${task.agentName}’s`} work: “${task.status}”)` : ''
    return `- ${f.from}${about}: ${f.text}`
  })
  result.content.push({
    type: 'text' as const,
    text: `HUMAN FEEDBACK — open request(s) on this canvas, now assigned to YOU:\n${lines.join('\n')}\nAddress this NOW, before continuing your plan: locate the frame in question (get_canvas / get_frame), make the change, and review with get_frame_screenshot. If it concerns another agent's frame, edit it anyway — a human request overrides the don't-touch-others'-frames etiquette. Update your set_status to say what you're picking up.`,
  })
  return result
}

/* upload rate limit per connecting user, mirroring the page-import route */
const uploadHits = new Map<string, number[]>()
const UPLOADS_PER_MIN = 15

/* photo search burns the shared Pexels quota (200 req/hour on the free tier) */
const searchHits = new Map<string, number[]>()
const SEARCHES_PER_MIN = 12

/* importing writes a potentially large HTML frame, so keep it at the same
   conservative per-user rate as the browser UI's import endpoint */
const importHits = new Map<string, number[]>()
const IMPORTS_PER_MIN = 5

const agentName = z
  .string()
  .describe(
    'Your display name, shown live to everyone on the canvas (e.g. "Claude", "Codex"). Reuse the SAME name on every call so your work is attributed consistently.',
  )

function frameSummary(f: {
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
}) {
  return {
    id: f.id,
    name: f.name,
    ...(f.demo ? { demo: true } : {}),
    x: f.x,
    y: f.y,
    width: f.width,
    height: f.height,
    updatedAt: new Date(f.updatedAt).toISOString(),
    updatedBy: f.updatedBy,
    htmlBytes: f.html.length,
    /* public render of the CURRENT design — downloadable/hotlinkable
       (append &download, or .jpg?quality=90 for JPEG) */
    image_url: `${PUBLIC_ORIGIN}/i/${f.id}.png?scale=2`,
  }
}

/** owner is the connecting user's display name (for attribution); ownerId is
 *  their user id — canvases the agent creates or lists are scoped to it, the
 *  same isolation the web UI gets. */
export function buildMcpServer(owner?: string, ownerId?: string): McpServer {
  const actorFrom = (agent_name?: string) => actions.resolveActor({ name: agent_name, kind: 'agent', owner })
  /* Canvas access for agents mirrors the web UI: the OAuth user's id runs
     through the same canAccessCanvas gate as browser sessions. Every tool
     that takes a canvas or frame id resolves it through these. */
  const canvasFor = (canvasId: string) => {
    const c = store.getCanvas(canvasId)
    return c && canAccessCanvas(ownerId, c) ? c : undefined
  }
  const frameFor = (frameId: string) => {
    const f = store.getFrame(frameId)
    if (!f) return undefined
    return canvasFor(f.canvasId) ? f : undefined
  }
  const noCanvas = (id: string) => err(`no canvas with id ${id} accessible to this account`)
  const noFrame = (id: string) => err(`no frame with id ${id} accessible to this account`)
  /* Reads count as arrival: presence (and with it every "your agent is
     connected" confirmation in the UI) must appear on an agent's FIRST
     canvas-scoped call, not only once it mutates something. */
  const arrive = (canvasId: string, agent_name?: string) => {
    if (agent_name) actions.heartbeatAgent(canvasId, actorFrom(agent_name))
  }
  const server = new McpServer({ name: 'doop-canvas', version: '0.1.0' }, { instructions: INSTRUCTIONS })

  server.registerTool(
    'get_guide',
    {
      description:
        'Read the Doop agent guide: mandatory review checkpoints, the streaming workflow, frame sizing, design-quality doctrine, and multiplayer etiquette. Call with topic "doop-instructions" ONCE before using other Doop tools; call again if a long conversation may have compressed earlier context.',
      inputSchema: {
        topic: z.enum(GUIDE_TOPICS).describe('Guide topic to load'),
      },
    },
    async () => text(DOOP_GUIDE),
  )

  server.registerTool(
    'search_inspiration',
    {
      title: 'Search design inspiration',
      description:
        'Search a curated gallery of real, well-designed live websites by category and SEE thumbnails of each, with pre-distilled style facts (one-line mood north star, named palette, fonts). Call it FIRST when writing a design brief — it is the required inspiration step, especially for landing pages: query the page archetype plus the register you want ("law firm landing page, editorial", "dark fintech dashboard"), not just the product noun. Study the thumbnails, pick the ONE exemplar that fits the brief best and follow it — do not blend several — and name it in the brief. Do not embed these screenshots in a frame.',
      inputSchema: {
        query: z
          .string()
          .describe('Page archetype + register, e.g. "grocery delivery landing page, warm", "dark fintech dashboard"'),
        count: z.number().min(1).max(6).optional().describe('Exemplars to return, default 4'),
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
        const results = await searchInspiration(query, count ?? 4)
        if (results.length === 0)
          return text({ ok: true, results: [], note: `No inspiration for "${query}" — try a broader category.` })
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
        return canvas_id ? withFeedback(result, canvas_id, actorFrom(agent_name)) : result
      } catch (e) {
        return err(e instanceof Error ? e.message : 'inspiration search failed')
      }
    },
  )

  server.registerTool(
    'list_canvases',
    {
      description: "List the connected user's design canvases with their ids, names and frame counts.",
      inputSchema: {},
    },
    /* '' matches no ownerId: a session without a user sees nothing */
    async () =>
      text(
        store.listCanvases(ownerId ?? '').map((m) => ({
          ...m,
          /* count what get_canvas will actually return — demo frames are hidden from agents */
          frameCount: store.getCanvas(m.id)?.frames.filter((f) => !f.demo).length ?? m.frameCount,
          guidelinesCount: store.getGuidelines(m.id).length,
        })),
      ),
  )

  server.registerTool(
    'create_canvas',
    {
      description: 'Create a new design canvas. Returns the canvas id, which is part of the shareable URL (/c/<id>).',
      inputSchema: { name: z.string().describe('Canvas name'), agent_name: agentName.optional() },
    },
    async ({ name }) => {
      /* owned by the connecting user — an ownerless canvas would be invisible
         on every dashboard (and was once visible on all of them) */
      const canvas = store.createCanvas(name, ownerId)
      return text({ id: canvas.id, name: canvas.name, url: `/c/${canvas.id}` })
    },
  )

  server.registerTool(
    'get_canvas',
    {
      description:
        'Get a canvas: its name and every frame with position, size and metadata (not the HTML — use get_frame for that). Use this to see the current layout before adding or editing frames. Pass your agent_name so any human feedback waiting for you is delivered with the result.',
      inputSchema: { canvas_id: z.string(), agent_name: agentName.optional() },
    },
    async ({ canvas_id, agent_name }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      arrive(canvas_id, agent_name)
      const docs = store.getGuidelines(canvas_id)
      const refs = store.getReferences(canvas_id)
      /* design-synced canvases carry a flow map: real user navigation between
         the synced screens — context a redesign must respect */
      const flow = describeSyncFlow(await getSyncFlow(c), c.frames)
      const notes = [
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
        ...(refs.length
          ? [
              'This canvas has pinned style references — exemplar designs humans marked as "more like this". Call get_reference on the relevant one and match its look (palette, type, spacing) in what you design.',
            ]
          : []),
      ]
      return withFeedback(
        text({
          id: c.id,
          name: c.name,
          /* demo frames (the Doop welcome show, seeded examples) are product
             content, not user work — hidden so agents never mistake them for
             the canvas's established style */
          frames: c.frames.filter((f) => !f.demo).map(frameSummary),
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
          ...(flow.length ? { flow } : {}),
          ...(notes.length ? { note: notes.join(' ') } : {}),
        }),
        canvas_id,
        agent_name ? actorFrom(agent_name) : undefined,
      )
    },
  )

  server.registerTool(
    'list_guidelines',
    {
      description:
        "List a canvas's style guides (named markdown guidelines — brand rules, style recipes) with one-line summaries. Fetch the full text of the relevant ones with get_guidelines before designing.",
      inputSchema: { canvas_id: z.string(), agent_name: agentName.optional() },
    },
    async ({ canvas_id, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      if (agent_name) actions.markGuidelinesSeen(canvas_id, actorFrom(agent_name).name)
      const docs = store.getGuidelines(canvas_id)
      if (docs.length === 0)
        return text({
          guidelines: [],
          note: 'No style guides on this canvas yet. Set one with set_guidelines when a human hands you brand or style rules.',
        })
      return withFeedback(
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
      description:
        "Read one of the canvas's style guides in full: the style rules (palettes, fonts, layout recipes, asset URLs) every frame must follow. If get_canvas listed style guides, read the relevant ones with this BEFORE creating or restyling frames.",
      inputSchema: {
        canvas_id: z.string(),
        name: z.string().describe('Doc name from get_canvas / list_guidelines, e.g. "feature-image"'),
        agent_name: agentName.optional(),
      },
    },
    async ({ canvas_id, name, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      const doc = store.getGuidelines(canvas_id).find((d) => d.name === name.trim().toLowerCase())
      if (!doc) {
        const names = store.getGuidelines(canvas_id).map((d) => d.name)
        return err(
          names.length
            ? `no style guide named “${name}” — this canvas has: ${names.join(', ')}`
            : `no style guides on this canvas yet`,
        )
      }
      if (agent_name) actions.markGuidelinesSeen(canvas_id, actorFrom(agent_name).name)
      return withFeedback(text(doc.markdown), canvas_id, agent_name ? actorFrom(agent_name) : undefined)
    },
  )

  server.registerTool(
    'set_guidelines',
    {
      description:
        "Create, replace or delete a named style guide on a canvas (markdown, max 24,000 chars; empty string deletes). Write rules other designers and agents can execute directly: palette hexes, font <link>s, ready-to-paste <style> blocks, logo asset URLs (upload files with upload_asset first and reference the returned URLs), layout recipes, do/don't lists.",
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
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      const actor = actorFrom(agent_name)
      try {
        const doc = actions.setGuideline(canvas_id, name, markdown, actor, undefined, title)
        actions.markGuidelinesSeen(canvas_id, actor.name)
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
    'get_reference',
    {
      description:
        'Read a pinned style reference in full: the HTML of a design a human marked as an exemplar ("more designs like this"). References are listed by get_canvas. Match its palette, typography and spacing when designing on this canvas — it is the ground truth for the canvas\'s style.',
      inputSchema: {
        canvas_id: z.string(),
        reference_id: z.string().describe('Reference id from get_canvas'),
        agent_name: agentName.optional(),
      },
    },
    async ({ canvas_id, reference_id, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      const ref = store.getReferences(canvas_id).find((r) => r.id === reference_id)
      if (!ref) {
        const ids = store.getReferences(canvas_id).map((r) => `${r.id} (“${r.title}”)`)
        return err(
          ids.length
            ? `no reference with id ${reference_id} — this canvas has: ${ids.join(', ')}`
            : 'no style references pinned on this canvas yet',
        )
      }
      return withFeedback(
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
      description:
        'Record a design decision your human made while talking to YOU — style feedback you carried out ("rounder corners", "less purple, more white and blue", "stop using italic serif"). Doop\'s UI feedback is captured automatically, but you are the only one who hears your own conversation, so report it with this tool AFTER you have addressed it. It lands in the canvas\'s Memory; recurring preferences become suggested style rules. Record design taste only — not one-off content edits like typo fixes or copy changes.',
      inputSchema: {
        canvas_id: z.string(),
        decision: z
          .string()
          .max(actions.MAX_DECISION_CHARS)
          .describe('The feedback in the human\'s own words, e.g. "make it less claude-esque, more white and blue"'),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, decision, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
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
      description:
        'Broadcast a one-line status of what you are working on right now — everyone viewing the canvas sees it live next to your name (e.g. "Sketching a mobile onboarding flow", "Fixing contrast on the pricing table"). Set it when you START a task, update it whenever your focus shifts to something new, and clear it with an empty string when you are done. Keep it under ~80 characters, present tense, specific.',
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
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      actions.setAgentStatus(canvas_id, actorFrom(agent_name), status)
      return withFeedback(text({ ok: true, status: status.trim() || null }), canvas_id, actorFrom(agent_name))
    },
  )

  server.registerTool(
    'get_comments',
    {
      description:
        'Read element-pinned comments and replies on a canvas, newest first, including author, text, frame, CSS selector, HTML snippet, parentId thread links, and claim/failure/resolution metadata. Includes resolved comments by default so complete conversations remain readable; set include_resolved to false for unresolved comments only. Returns the retained comment history (up to 100 entries per canvas), not an archive. Reading does not claim feedback or comments, or mark them resolved.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        canvas_id: z.string(),
        frame_id: z.string().optional().describe('Only comments on this frame; it must belong to the canvas.'),
        include_resolved: z.boolean().default(true).describe('Include resolved comments and replies. Default true.'),
        agent_name: agentName.optional(),
      },
    },
    async ({ canvas_id, frame_id, include_resolved, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      if (frame_id !== undefined) {
        const frame = frameFor(frame_id)
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
    'get_feedback',
    {
      description:
        'Fetch and claim any open human feedback requests on a canvas. Feedback normally arrives automatically inside your other tool results, so you rarely need this — use it when you are specifically checking for feedback, e.g. an agent whose job is to poll the canvas every few minutes and address whatever humans have requested. Claiming assigns the requests to you: address each one, then review with get_frame_screenshot.',
      inputSchema: { canvas_id: z.string(), agent_name: agentName },
    },
    async ({ canvas_id, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      const fbs = actions.takeFeedbackFor(canvas_id, actorFrom(agent_name).name)
      if (fbs.length === 0) return text({ feedback: [], note: 'No open feedback requests right now.' })
      const tasks = actions.getTasks(canvas_id)
      return text({
        feedback: fbs.map((f) => {
          const task = tasks.find((t) => t.id === f.taskId)
          return {
            from: f.from,
            text: f.text,
            about: task ? `${task.agentName}: “${task.status}”` : undefined,
            at: new Date(f.at).toISOString(),
          }
        }),
        note: "These requests are now assigned to you. Address each one (a human request overrides the don't-touch-others'-frames etiquette), review with get_frame_screenshot, and update your set_status.",
      })
    },
  )

  server.registerTool(
    'create_frame',
    {
      description:
        'Create a new frame on a canvas with an HTML design. A frame is a rectangular artboard that renders a full HTML document (inline <style> and <script> allowed, no external network access needed). If x/y are omitted the frame is auto-placed to the right of existing frames. Everyone viewing the canvas sees it appear live.',
      inputSchema: {
        canvas_id: z.string(),
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
    async ({ canvas_id, name, html, x, y, width, height, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      const frame = actions.createFrame(canvas_id, { name, html, x, y, width, height }, actorFrom(agent_name))
      if (!frame) return noCanvas(canvas_id)
      const result = withEscapeNote(
        frame.html.length > 0
          ? textWithNudge({ ok: true, frame: frameSummary(frame) }, REVIEW_NUDGE)
          : text({ ok: true, frame: frameSummary(frame) }),
        html,
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
      description: 'Get a frame including its full HTML content.',
      inputSchema: { frame_id: z.string(), agent_name: agentName.optional() },
    },
    async ({ frame_id, agent_name }) => {
      const f = frameFor(frame_id)
      if (!f) return noFrame(frame_id)
      arrive(f.canvasId, agent_name)
      return withFeedback(
        text({ ...frameSummary(f), html: f.html }),
        f.canvasId,
        agent_name ? actorFrom(agent_name) : undefined,
      )
    },
  )

  server.registerTool(
    'set_frame_html',
    {
      description:
        'Replace the HTML design of a frame in one shot. The change renders live for everyone viewing the canvas. For new or heavily reworked designs, prefer append_frame_html so viewers can watch the design stream in.',
      inputSchema: { frame_id: z.string(), html: z.string(), agent_name: agentName },
    },
    async ({ frame_id, html, agent_name }) => {
      if (!frameFor(frame_id)) return noFrame(frame_id)
      const frame = actions.updateFrame(frame_id, { html }, actorFrom(agent_name))
      if (!frame) return noFrame(frame_id)
      return withGuidelinesNudge(
        withStatusNudge(
          withFeedback(
            withEscapeNote(textWithNudge({ ok: true, frame: frameSummary(frame) }, REVIEW_NUDGE), html),
            frame.canvasId,
            actorFrom(agent_name),
          ),
          frame.canvasId,
          actorFrom(agent_name),
        ),
        frame.canvasId,
        actorFrom(agent_name),
      )
    },
  )

  server.registerTool(
    'export_frame',
    {
      title: 'Export frame as image',
      description:
        "Get public image URLs (PNG/JPG) rendering the frame's CURRENT design — for publishing it elsewhere: download the URL and upload to a CMS media library, social post, or use directly as og:image. The URL re-renders when the frame changes.",
      inputSchema: {
        frame_id: z.string(),
        format: z.enum(['png', 'jpg']).optional().describe('default png'),
        quality: z.number().min(1).max(100).optional().describe('jpg only, default 90'),
      },
    },
    async ({ frame_id, format, quality }) => {
      const f = frameFor(frame_id)
      if (!f) return noFrame(frame_id)
      const ext = format === 'jpg' ? 'jpg' : 'png'
      const q = ext === 'jpg' ? `&quality=${quality ?? 90}` : ''
      return text({
        image_url: `${PUBLIC_ORIGIN}/i/${frame_id}.${ext}?scale=2${q}`,
        download_url: `${PUBLIC_ORIGIN}/i/${frame_id}.${ext}?scale=2${q}&download`,
        width: f.width * 2,
        height: f.height * 2,
        note: 'Public URL, no auth needed. To publish: fetch the URL and upload the bytes to the target platform (e.g. WordPress POST /wp/v2/media), or hotlink it directly — it always shows the current design.',
      })
    },
  )

  server.registerTool(
    'upload_asset',
    {
      title: 'Upload an image asset',
      description:
        'Upload an image (png/jpg/webp/gif/svg, max 5 MB) and get back a permanent public URL to reference in frame HTML (<img src>, CSS background) — use this instead of inlining data: URIs. Pick ONE input by where the file lives: (1) remote — pass source_url and the server fetches it; (2) LOCAL FILE — pass local_file=true to receive a one-time upload URL and a ready-to-run curl command, run it in your shell, and the curl response JSON contains the permanent url. (3) data — base64, LAST RESORT for tiny files (under ~100 KB) when you cannot run shell commands; larger base64 payloads are slow and corrupt easily.',
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
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      const now = Date.now()
      const limitKey = ownerId ?? agent_name
      const hits = (uploadHits.get(limitKey) ?? []).filter((t) => now - t < 60_000)
      if (hits.length >= UPLOADS_PER_MIN) return err('upload rate limit — wait a minute')
      hits.push(now)
      uploadHits.set(limitKey, hits)
      if (local_file) {
        const { token, expiresAt } = assets.createUploadTicket({
          canvasId: canvas_id,
          ownerId,
          uploadedBy: agent_name,
        })
        const upload_url = `${PUBLIC_ORIGIN}/u/${token}`
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
        const buf = data
          ? Buffer.from(data.replace(/^data:[^,]*;base64,/, ''), 'base64')
          : await assets.fetchRemote(source_url!)
        const asset = await assets.createAsset(buf, { canvasId: canvas_id, ownerId, uploadedBy: agent_name })
        const url = `${PUBLIC_ORIGIN}/a/${asset.id}.${asset.ext}`
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

  server.registerTool(
    'search_images',
    {
      title: 'Search stock photos',
      description:
        'Search free stock photography (Pexels) and get back candidate photos WITH visual thumbnails — look at them and pick the one that fits the frame\'s mood, palette and crop. Use concrete, scene-level queries ("team collaborating loft office", not "business"). Embed the returned image_url directly in frame HTML (hotlinking is fine and license-safe), or pass it to upload_asset source_url for a permanent copy on this origin. Always write a real alt text.',
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
        return canvas_id ? withFeedback(result, canvas_id, actorFrom(agent_name)) : result
      } catch (e) {
        return err(e instanceof Error ? e.message : 'photo search failed')
      }
    },
  )

  server.registerTool(
    'search_backgrounds',
    {
      title: 'Search backgrounds',
      description:
        'Search a curated library of premium backgrounds for hero sections, section bands and bento tiles — soft glows, grainy meshes, aurora ribbons, neon, painterly landscapes — and get candidates WITH visual thumbnails plus a ready-to-paste CSS line that includes a legibility scrim. Call it BEFORE writing a hero or any full-bleed section: a flat CSS gradient is the fallback, not the default. Describe mood and palette ("warm sunset glow", "dark teal aurora", "calm pastel mesh"); filter by tone (light/dark, match your copy color), style and slot. Pick by palette hexes so it sits with the frame, then put copy in the text_zone.',
      inputSchema: {
        query: z.string().describe('Mood, palette and subject, e.g. "dark purple glow for a SaaS hero"'),
        tone: z
          .enum(backgrounds.BACKGROUND_TONES)
          .optional()
          .describe('light = dark copy on it, dark = light copy on it'),
        style: z.enum(backgrounds.BACKGROUND_STYLES).optional().describe('Restrict to one look'),
        slot: z
          .enum(backgrounds.BACKGROUND_SLOTS)
          .optional()
          .describe('Where it goes: hero, section band, or card/bento tile'),
        count: z.number().min(1).max(8).optional().describe('Candidates to return, default 5'),
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
        const results = backgrounds.searchBackgrounds(query, { tone, style, slot, count }, PUBLIC_ORIGIN)
        if (results.length === 0)
          return text({
            ok: true,
            backgrounds: [],
            note: `No backgrounds for "${query}" — drop a filter or describe the mood more broadly (e.g. "warm glow", "dark mesh").`,
          })
        const thumbs = await Promise.all(results.map((r) => backgrounds.fetchThumb(r.id)))
        type ResultBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
        const content: ResultBlock[] = [
          {
            type: 'text' as const,
            text: `${results.length} background(s) for "${query}" — thumbnails below, pick by number:`,
          },
        ]
        results.forEach((r, i) => {
          const thumb = thumbs[i]
          if (thumb) content.push({ type: 'image' as const, data: thumb.data, mimeType: thumb.mime })
          content.push({ type: 'text' as const, text: backgrounds.describeBackground(r, i) })
        })
        content.push({ type: 'text' as const, text: backgrounds.BACKGROUND_USAGE_NOTE })
        const result = { content }
        return canvas_id ? withFeedback(result, canvas_id, actorFrom(agent_name)) : result
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
        return canvas_id ? withFeedback(result, canvas_id, actorFrom(agent_name)) : result
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
        if (brands.length > 0) {
          const thumbs = await Promise.all(brands.map((b) => imageSearch.fetchThumb(b.thumb_url)))
          brands.forEach((b, i) => {
            const thumb = thumbs[i]
            if (thumb) content.push({ type: 'image' as const, data: thumb.data, mimeType: thumb.mime })
            content.push({
              type: 'text' as const,
              text: `#${i + 1} — ${b.name} (${b.domain})\nlogo_url: ${b.logo_url}`,
            })
          })
        }
        if (vector.length > 0) {
          content.push({
            type: 'text' as const,
            text: `Open-source vector marks:\n${vector.map((v) => `${v.id} → ${v.svg_url}`).join('\n')}`,
          })
        }
        content.push({ type: 'text' as const, text: imageSearch.LOGO_USAGE_NOTE })
        const result = { content }
        return canvas_id ? withFeedback(result, canvas_id, actorFrom(agent_name)) : result
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
      annotations: { readOnlyHint: true, openWorldHint: true },
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
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
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
        return withStatusNudge(withFeedback(result, canvas_id, actor), canvas_id, actor)
      } catch (e) {
        return err(
          websiteAccessErrorMessage(e, 'connected-agent') ?? (e instanceof Error ? e.message : 'webpage import failed'),
        )
      }
    },
  )

  server.registerTool(
    'get_frame_screenshot',
    {
      description:
        'Render a frame and return a PNG screenshot of it — this is how you SEE your design. Always review your work with this after creating or updating a frame, then fix what looks wrong (spacing, overflow, contrast, alignment) and check again. Iterate until it actually looks good, not just until the HTML seems right.',
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
      const f = frameFor(frame_id)
      if (!f) return noFrame(frame_id)
      arrive(f.canvasId, agent_name)
      try {
        const png = await renderFrame(f, scale ?? 1)
        return withFeedback(
          {
            content: [
              { type: 'image' as const, data: png.toString('base64'), mimeType: 'image/png' },
              {
                type: 'text' as const,
                text: `Screenshot of “${f.name}” (${f.width}×${f.height}@${scale ?? 1}x, html ${f.html.length} bytes)`,
              },
            ],
          },
          f.canvasId,
          agent_name ? actorFrom(agent_name) : undefined,
        )
      } catch (e) {
        return err(`screenshot failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  )

  server.registerTool(
    'append_frame_html',
    {
      description:
        'Stream a design into a frame section by section — every chunk renders for viewers the moment it arrives, so they watch the design build up live. Prefer this over set_frame_html when creating or reworking a whole design. Send the HTML in document order, ONE complete section per call (head+styles first, then the hero, then each following section), roughly 1–4 KB per chunk. Set start=true on the FIRST chunk (replaces any existing content and shows a live "designing…" badge) and done=true on the LAST chunk. End chunks at element boundaries — partial HTML is healed, but a complete section paints cleanly.',
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
      if (!frameFor(frame_id)) return noFrame(frame_id)
      const frame = actions.appendFrameHtml(frame_id, html_chunk, actorFrom(agent_name), { start, done })
      if (!frame) return noFrame(frame_id)
      const result = done
        ? textWithNudge(
            { ok: true, streaming: false, htmlBytes: frame.html.length },
            `Stream complete. ${REVIEW_NUDGE}`,
          )
        : text({ ok: true, streaming: true, htmlBytes: frame.html.length })
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
      description:
        'Make a targeted edit to a frame: exact find-and-replace in its HTML. Use this for small tweaks (copy, a color, spacing, one element) instead of resending the whole document — the change morphs into the rendered frame in place. old_str must appear EXACTLY ONCE in the current HTML (call get_frame first if unsure); include enough surrounding context to make it unique.',
      inputSchema: {
        frame_id: z.string(),
        old_str: z.string().describe('Exact text to find in the frame HTML — must occur exactly once'),
        new_str: z.string().describe('Replacement text'),
        agent_name: agentName,
      },
    },
    async ({ frame_id, old_str, new_str, agent_name }) => {
      const f = frameFor(frame_id)
      if (!f) return noFrame(frame_id)
      const count = f.html.split(old_str).length - 1
      if (count === 0) return err('old_str not found in the frame HTML. Call get_frame to see the current content.')
      if (count > 1)
        return err(`old_str occurs ${count} times — include more surrounding context so it matches exactly once.`)
      const frame = actions.updateFrame(frame_id, { html: f.html.replace(old_str, new_str) }, actorFrom(agent_name))!
      return withStatusNudge(
        withFeedback(
          textWithNudge({ ok: true, frame: frameSummary(frame) }, REVIEW_NUDGE),
          frame.canvasId,
          actorFrom(agent_name),
        ),
        frame.canvasId,
        actorFrom(agent_name),
      )
    },
  )

  server.registerTool(
    'update_frame',
    {
      description: 'Update frame metadata: rename it or move/resize it on the canvas.',
      inputSchema: {
        frame_id: z.string(),
        name: z.string().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        agent_name: agentName,
      },
    },
    async ({ frame_id, agent_name, ...patch }) => {
      const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
      if (!Object.keys(clean).length) return err('nothing to update')
      if (!frameFor(frame_id)) return noFrame(frame_id)
      const frame = actions.updateFrame(frame_id, clean, actorFrom(agent_name))
      if (!frame) return noFrame(frame_id)
      return withFeedback(text({ ok: true, frame: frameSummary(frame) }), frame.canvasId, actorFrom(agent_name))
    },
  )

  server.registerTool(
    'delete_frame',
    {
      description: 'Delete a frame from its canvas.',
      inputSchema: { frame_id: z.string(), agent_name: agentName },
    },
    async ({ frame_id, agent_name }) => {
      if (!frameFor(frame_id)) return noFrame(frame_id)
      const frame = actions.deleteFrame(frame_id, actorFrom(agent_name))
      if (!frame) return noFrame(frame_id)
      return text({ ok: true, deleted: frame.name })
    },
  )

  return server
}

/** Stateless streamable-HTTP MCP endpoint. */
export async function handleMcpRequest(req: Request, res: Response) {
  if (req.method !== 'POST') {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed. This MCP endpoint is stateless; use POST.' },
      id: null,
    })
    return
  }
  /* OAuth gate: the 401 + WWW-Authenticate header is what triggers the
     browser approval flow in MCP clients (RFC 9728 discovery). */
  const session = await auth.api.getMcpSession({ headers: fromNodeHeaders(req.headers) }).catch(() => null)
  if (!session) {
    const origin = `${req.protocol}://${req.get('host')}`
    res
      .status(401)
      .set(
        'WWW-Authenticate',
        `Bearer realm="doop", resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
      )
      .json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized: this MCP server requires OAuth' },
        id: null,
      })
    return
  }
  /* banning revokes browser sessions, but an already-issued MCP token keeps
     validating until it expires — refuse it here so a ban is total */
  if (session.userId && (await isBanned(session.userId))) {
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
  if (session.userId) {
    const msgs = Array.isArray(req.body) ? req.body : [req.body]
    for (const msg of msgs) {
      if (msg?.method === 'initialize') {
        capture(session.userId, 'custom_agent_connected', {
          agent_client: msg.params?.clientInfo?.name,
          agent_client_version: msg.params?.clientInfo?.version,
        })
      } else if (msg?.method === 'tools/call') {
        captureThrottled(session.userId, 'custom_agent_used', { first_tool: msg.params?.name })
      }
    }
  }
  const owner = session.userId ? await getUserName(session.userId) : undefined
  const server = buildMcpServer(owner, session.userId ?? undefined)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
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
