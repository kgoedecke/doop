import { z } from 'zod'
import { AGENT_IDEA_CATEGORIES, AGENT_ISSUE_CATEGORIES, MAX_AGENT_FEEDBACK_CHARS } from '../shared/agentFeedback.ts'
import { MAX_DECISION_CHARS } from '../shared/designDecisions.ts'
import { MAX_TOKEN_DESCRIPTION, TOKEN_TYPES } from '../shared/designTokens.ts'
import { MAX_LAYER_SELECTOR_CHARS } from '../shared/elementId.ts'
import { DEFAULT_EXPORT_SCALE, MAX_EXPORT_SCALE, MIN_EXPORT_SCALE } from '../shared/exportScale.ts'
import { MAX_CANVAS_NAME, MAX_PAGE_NAME } from '../shared/pages.ts'
import { MAX_GUIDELINE_CHARS, MAX_GUIDELINE_TITLE_CHARS } from './actions.ts'
import { BACKGROUND_SLOTS, BACKGROUND_STYLES, BACKGROUND_TONES } from './backgrounds.ts'
import { FIT_AXES, FIT_ON } from './frameFit.ts'
import { IMAGE_ASPECTS, IMAGE_QUALITIES } from './imageGen.ts'

/**
 * The parameters of every tool that MCP agents (server/mcp.ts) and the Doop Agent (server/resident.ts) both call,
 * defined once so the two cannot drift. MCP registers a shape with its call context around it (canvas_id,
 * agent_name); the Doop Agent sends the same shape as JSON Schema (`residentInputSchema` in resident.ts), with its
 * own wording only where a run gives a parameter another meaning (a page from its page list, not get_canvas).
 * Tool descriptions stay with each surface. The component tools keep their shapes beside their handlers
 * (componentTools.ts); tests/agentToolParity.test.ts holds both surfaces to these.
 */

const pageId = (description: string) => z.string().optional().describe(description)

const exportScale = (description: string) =>
  z.number().min(MIN_EXPORT_SCALE).max(MAX_EXPORT_SCALE).optional().describe(description)

const messageToTheTeam = (description: string) => z.string().min(1).max(MAX_AGENT_FEEDBACK_CHARS).describe(description)

const toolInvolved = z.string().max(80).optional().describe('The Doop tool involved, if any (e.g. "edit_frame_html").')

export const TOOL_SHAPES = {
  search_inspiration: {
    query: z
      .string()
      .describe('Genre + look, e.g. "saas landing page, dark minimal", "restaurant, retro", "finance, editorial"'),
    count: z.number().min(1).max(6).optional().describe('Exemplars to return, default 4'),
  },
  update_canvas: {
    name: z.string().trim().min(1).max(MAX_CANVAS_NAME).describe('The new canvas name'),
  },
  set_guidelines: {
    name: z.string().describe('Doc slug, e.g. "feature-image" (a-z, 0-9, hyphens)'),
    markdown: z
      .string()
      .max(MAX_GUIDELINE_CHARS)
      .describe('Full replacement markdown for this doc; empty string deletes it'),
    title: z
      .string()
      .max(MAX_GUIDELINE_TITLE_CHARS)
      .optional()
      .describe('Pretty display name shown to humans, e.g. "Featured Images"; omit to keep the current one'),
  },
  get_tokens: {
    types: z.array(z.enum(TOKEN_TYPES)).optional().describe('Only these token types; omit for all'),
    name_pattern: z
      .string()
      .optional()
      .describe('Glob on the full name, case-insensitive, * wildcard: "--color-*", "*-500", "*brand*"'),
    format: z.enum(['json', 'css', 'tailwind', 'markdown']).optional(),
  },
  create_tokens: {
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
          description: z.string().max(MAX_TOKEN_DESCRIPTION).optional().describe('What it is for and when to use it'),
        }),
      )
      .min(1)
      .max(200),
  },
  set_tokens: {
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
  },
  set_token_themes: {
    themes: z
      .array(z.string())
      .max(8)
      .describe('Theme names in display order, e.g. ["light", "dark"]; "default" is always there and never listed'),
    renames: z
      .array(z.object({ from: z.string(), to: z.string() }))
      .optional()
      .describe('Themes to rename first; their values follow. List the new name in `themes`.'),
  },
  get_reference: {
    reference_id: z.string().describe('Reference id from get_canvas'),
  },
  save_decision: {
    decision: z
      .string()
      .max(
        MAX_DECISION_CHARS,
        `Save one decision and its rationale per call, at most ${MAX_DECISION_CHARS} characters; split longer feedback into separate calls by topic.`,
      )
      .describe(
        `One decision and its rationale in the human's own words, at most ${MAX_DECISION_CHARS} characters. Split longer feedback into separate calls by topic.`,
      ),
  },
  set_status: {
    status: z
      .string()
      .max(140)
      .describe('What you are working on, one line, present tense. Empty string clears your status.'),
  },
  reply_to_comment: {
    comment_id: z.string().describe('The root comment or any reply in the thread (from get_comments)'),
    text: z.string().describe('The reply text. Trimmed; empty replies are rejected.'),
  },
  resolve_comment: {
    comment_id: z.string().describe('The root comment or a reply (from get_comments)'),
  },
  report_issue: {
    category: z
      .enum(AGENT_ISSUE_CATEGORIES)
      .describe(
        'bug: a tool misbehaved · tool_error: a tool returned an error you could not get past · confusing: the guide or a description was unclear · missing_capability: you needed something Doop cannot do · other',
      ),
    message: messageToTheTeam('What you tried, what happened, and what you expected or needed instead.'),
    tool: toolInvolved,
  },
  share_feedback: {
    category: z
      .enum(AGENT_IDEA_CATEGORIES)
      .describe(
        'idea: something new Doop could offer · improvement: a change to something that exists · praise: something that worked well · other',
      ),
    message: messageToTheTeam('What you were doing and what would have helped (or what worked well).'),
    tool: toolInvolved,
  },
  set_canvas_pages: {
    expectedPages: z
      .array(z.object({ id: z.string(), name: z.string() }))
      .describe('Exact ordered pages returned by get_canvas; protects collaborators from overwritten changes'),
    pages: z
      .array(z.object({ id: z.string().trim().min(1).max(100), name: z.string().trim().min(1).max(100) }))
      .min(1)
      .max(100)
      .describe('The new ordered list; keep each page id, change names and order, leave out a page to delete it'),
  },
  create_canvas_page: {
    name: z.string().trim().min(1).max(MAX_PAGE_NAME).describe('The page name shown in the Pages panel'),
  },
  get_prototype: {},
  set_prototype_start: {
    pageId: pageId("Page ID from get_canvas; defaults to the start frame's page"),
    frame_id: z.string().nullable().describe("The start frame, or null to clear the page's start"),
  },
  create_frame: {
    pageId: pageId('Target page ID from get_canvas; defaults to the first page'),
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
    fit_to_content: z
      .enum(FIT_AXES)
      .optional()
      .describe(
        `${FIT_ON.create} Needs the whole design in html: after streaming with append_frame_html, call update_frame with fit_to_content instead.`,
      ),
  },
  set_frame_html: {
    frame_id: z.string(),
    html: z.string(),
    fit_to_content: z.enum(FIT_AXES).optional().describe(FIT_ON.set),
  },
  export_layer: {
    frame_id: z.string(),
    element_id: z.string().optional().describe("the element's data-doop-id; preferred, it survives edits"),
    selector: z
      .string()
      .max(MAX_LAYER_SELECTOR_CHARS)
      .optional()
      .describe('a CSS selector for an element without a data-doop-id, e.g. "#pricing .card:nth-of-type(2)"'),
    format: z.enum(['png', 'jpg']).optional().describe('default png'),
    quality: z.number().min(1).max(100).optional().describe('jpg only, default 90'),
    scale: exportScale(`pixel density, default ${DEFAULT_EXPORT_SCALE}`),
  },
  upload_font: {
    source_url: z.string().optional().describe('Public http(s) URL of the font file'),
    local_file: z
      .boolean()
      .optional()
      .describe('true = the file is on YOUR machine: returns a one-time upload URL + curl command to run'),
    data: z.string().optional().describe('The file as base64 (raw or a data: URL). Last resort, small files only.'),
    file_name: z.string().optional().describe('The file name the library shows, e.g. "Oxanium-Light.ttf"'),
  },
  generate_image: {
    prompt: z.string().describe('What to draw: subject, style, composition, palette, lighting, mood'),
    aspect: z
      .enum(IMAGE_ASPECTS)
      .optional()
      .describe('square 1024×1024 (default), landscape 1536×1024, portrait 1024×1536 — match the slot'),
    quality: z.enum(IMAGE_QUALITIES).optional().describe('low is fast and cheap; default medium'),
  },
  search_images: {
    query: z.string().describe('Scene-level description of the photo you want'),
    orientation: z.enum(['landscape', 'portrait', 'square']).optional().describe('Match the slot the photo will fill'),
    count: z.number().min(1).max(8).optional().describe('Candidates to return, default 5'),
  },
  list_backgrounds: {
    query: z
      .string()
      .optional()
      .describe('Mood / palette words to put first, e.g. "warm sunset glow" — reorders, never filters'),
    tone: z.enum(BACKGROUND_TONES).optional().describe('light = dark copy on it, dark = light copy on it'),
    style: z.enum(BACKGROUND_STYLES).optional().describe('Restrict to one look'),
    slot: z.enum(BACKGROUND_SLOTS).optional().describe('Where it goes: hero, section band, or card/bento tile'),
    count: z.number().min(1).max(24).optional().describe('Thumbnails to return, default 12'),
  },
  search_icons: {
    query: z.string().describe('A single icon concept, e.g. "light bulb"'),
    limit: z.number().min(1).max(48).optional().describe('Max results, default 24'),
  },
  search_logos: {
    query: z.string().describe('A single company name or domain, e.g. "vercel.com"'),
    count: z.number().min(1).max(8).optional().describe('Candidates to return, default 5'),
  },
  view_website: {
    url: z.string().describe('The page URL — a bare domain like "acme.io" is loaded over https'),
  },
  import_webpage: {
    url: z.string().describe('The page URL — a bare domain like "acme.io" is loaded over https'),
  },
  inspect_frame: {
    frame_id: z.string(),
    selectors: z
      .array(z.string())
      .max(20)
      .optional()
      .describe('CSS selectors to report on (up to 20 matches each) instead of the automatic outline'),
  },
  edit_frame_html: {
    frame_id: z.string(),
    old_str: z.string().describe('Exact text to find in the frame HTML — must occur exactly once'),
    new_str: z.string().describe('Replacement text'),
  },
  update_frame: {
    frame_id: z.string(),
    pageId: pageId('The page to move the frame to'),
    name: z.string().optional(),
    x: z.number().optional().describe('Canvas position in px'),
    y: z.number().optional().describe('Canvas position in px'),
    width: z.number().optional().describe('px; the design is not rescaled'),
    height: z.number().optional().describe('px; the design is not rescaled'),
    fit_to_content: z.enum(FIT_AXES).optional().describe(FIT_ON.update),
    locked: z.boolean().optional().describe('true keeps humans from selecting, moving or deleting it'),
    rotation: z.number().optional().describe('Degrees clockwise about its centre; 0 straightens it'),
  },
  set_frame_approval: {
    frame_id: z.string(),
    status: z.enum(['ready_for_dev', 'draft']),
  },
} satisfies Record<string, z.ZodRawShape>

export type SharedToolName = keyof typeof TOOL_SHAPES
