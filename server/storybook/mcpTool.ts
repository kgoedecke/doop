import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpToolHelpers } from '../extensions.ts'
import { MAX_STORYBOOK_COMPONENTS } from '../../shared/storybookSource.ts'
import { storybookBase } from '../../shared/storybookIndex.ts'
import type { ComponentCapture } from '../../shared/storybookAcquire.ts'
import type { StoryCapture } from '../../shared/storybookCapture.ts'
import { readStorybook } from './importer.ts'
import { jobById, jobView, runningJobOn, startStorybookJob, waitForJob, type StorybookJob } from './jobs.ts'
import { publicView, sourceByUrl, sourcesOf } from './sources.ts'
import { parsePicks } from './routes.ts'

/**
 * Storybook over MCP: list a Storybook's components, import them (or what the CLI captured on the
 * developer's machine), sync what a canvas imports from. Imports run on as a job; a call waits up
 * to `WAIT_MS` and then answers with its progress. Spec: .context/specs/storybook-import.md.
 */

const WAIT_MS = 50_000
const MAX_SCREENSHOT_CHARS = 1_000_000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const strings = (value: unknown) => isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string')

function asStory(raw: unknown): StoryCapture | null {
  if (!isRecord(raw) || typeof raw.html !== 'string' || !Array.isArray(raw.rules)) return null
  if (!raw.rules.every((rule) => typeof rule === 'string') || !strings(raw.vars)) return null
  return {
    html: raw.html,
    rules: raw.rules as string[],
    vars: raw.vars as Record<string, string>,
    fontFaces: Array.isArray(raw.fontFaces)
      ? raw.fontFaces.filter((face): face is string => typeof face === 'string')
      : [],
    text: strings(raw.text) ? (raw.text as Record<string, string>) : {},
    width: Number(raw.width) || 0,
    height: Number(raw.height) || 0,
    warnings: Array.isArray(raw.warnings) ? raw.warnings.filter((w): w is string => typeof w === 'string') : [],
  }
}

/** The CLI's captures, checked for shape; the server renders nothing for them. */
export function asCaptures(raw: unknown): ComponentCapture[] | string {
  if (!Array.isArray(raw)) return 'captures must be a list'
  if (raw.length > MAX_STORYBOOK_COMPONENTS) return `up to ${MAX_STORYBOOK_COMPONENTS} captures a call`
  const out: ComponentCapture[] = []
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.title !== 'string' || typeof entry.name !== 'string')
      return 'a capture needs title and name'
    const base = asStory(entry.base)
    if (!base) return `capture “${entry.title}” has no base render`
    const props = Array.isArray(entry.props) ? entry.props.filter(isRecord) : []
    out.push({
      title: entry.title,
      name: entry.name,
      storyId: typeof entry.storyId === 'string' ? entry.storyId : '',
      ...(typeof entry.codePath === 'string' ? { codePath: entry.codePath } : {}),
      ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
      props: props
        .filter(
          (prop) => typeof prop.name === 'string' && Array.isArray(prop.options) && typeof prop.default === 'string',
        )
        .map((prop) => ({
          name: String(prop.name),
          arg: String(prop.arg ?? prop.name),
          kind: prop.kind === 'boolean' ? ('boolean' as const) : ('enum' as const),
          options: (prop.options as unknown[]).map(String),
          values: (prop.options as unknown[]).map(String),
          default: String(prop.default),
        })),
      texts: (Array.isArray(entry.texts) ? entry.texts.filter(isRecord) : [])
        .filter((text) => typeof text.name === 'string' && typeof text.value === 'string')
        .map((text) => ({ name: String(text.name), arg: String(text.arg ?? text.name), value: String(text.value) })),
      base,
      variants: (Array.isArray(entry.variants) ? entry.variants.filter(isRecord) : []).map((variant) => {
        const capture = asStory(variant.capture)
        return {
          prop: String(variant.prop ?? ''),
          value: String(variant.value ?? ''),
          ...(capture ? { capture } : { error: String(variant.error ?? 'not rendered') }),
        }
      }),
      ...(strings(entry.darkVars) ? { darkVars: entry.darkVars as Record<string, string> } : {}),
      /* the CLI's screenshot of the story, for the fidelity check */
      ...(typeof entry.screenshot === 'string' &&
      entry.screenshot.length <= MAX_SCREENSHOT_CHARS &&
      /^[A-Za-z0-9+/=]+$/.test(entry.screenshot)
        ? { screenshot: entry.screenshot }
        : {}),
      warnings: Array.isArray(entry.warnings) ? entry.warnings.filter((w): w is string => typeof w === 'string') : [],
    })
  }
  return out
}

const NEXT_STEPS =
  'Each component is on the canvas’s Components page with its variants as enum props, its code path in `code`, and the theme as tokens. Check a few with get_component_preview beside the story; a note under a component says what did not come across. Use them in frames as <doop-use component="…">.'

export function registerStorybookMcpTools(server: McpServer, helpers: McpToolHelpers): void {
  const { ownerId, actorFrom, canvasFor, noCanvas, err, text, textWithNudge, withFeedback } = helpers

  /** Wait for the job a while, then say where it stands. */
  async function answer(job: StorybookJob, canvasId: string, agent?: string) {
    const finished = await waitForJob(job, WAIT_MS)
    const view = jobView(job)
    if (!finished)
      return text({
        ...view,
        note: `Still importing. Call import_storybook with canvas_id and job_id "${job.id}" to wait for it again; the canvas shows it as the Storybook Import task.`,
      })
    if (job.state === 'failed') return err(`Storybook import failed: ${job.error}`)
    return withFeedback(textWithNudge(view, NEXT_STEPS), canvasId, actorFrom(agent))
  }

  server.registerTool(
    'list_storybook_components',
    {
      title: 'List a Storybook’s components',
      description:
        'Read a published Storybook (its URL, e.g. https://storybook.example.com) and list the components import_storybook can bring onto a canvas: each story title, its Doop name, how many stories it has and its source file. Also says which of them this canvas already imports from that Storybook.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        canvas_id: z.string(),
        url: z.string().describe('Where the Storybook is published'),
        agent_name: helpers.agentName,
      },
    },
    async ({ canvas_id, url }) => {
      if (!canvasFor(canvas_id, 'edit')) return noCanvas(canvas_id)
      try {
        if (!helpers.takeImportSlot(ownerId ?? canvas_id)) return err('import rate limit — wait a minute')
        const { base, components } = await readStorybook(url)
        const source = await sourceByUrl(canvas_id, base.href)
        const imported = new Set(source?.components.map((component) => component.title) ?? [])
        return text({
          url: base.href,
          components: components.slice(0, 400).map((component) => ({
            title: component.title,
            name: component.name,
            stories: component.stories.length,
            ...(component.codePath ? { code: component.codePath } : {}),
            ...(imported.has(component.title) ? { imported: true } : {}),
          })),
          ...(components.length > 400 ? { more: components.length - 400 } : {}),
        })
      } catch (error) {
        return err(error instanceof Error ? error.message : 'reading the Storybook failed')
      }
    },
  )

  server.registerTool(
    'import_storybook',
    {
      title: 'Import components from Storybook',
      description:
        'Bring a team’s real components from its published Storybook onto a canvas as Doop components: each story rendered and lifted with its CSS, its controls (variant, size, boolean flags) as enum props whose variants are CSS, shown text as text props, its source file as `code`, the theme’s colours as tokens (with dark when the Storybook has it) and its fonts in the font library. Pass the Storybook URL and the story titles to import (from list_storybook_components); importing again updates what changed. Runs as a job: if it is not done within a minute, the answer has a job_id to wait on. A Storybook only the developer’s machine reaches (localhost, VPN) is imported with Doop’s CLI, which calls this tool with `captures`.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        canvas_id: z.string(),
        url: z.string().optional().describe('Where the Storybook is published (or was, for captures)'),
        components: z
          .array(
            z.union([
              z.string(),
              z.object({
                title: z.string(),
                story_id: z.string().optional().describe('A story other than the one picked by itself'),
                select: z.string().optional().describe('CSS selector for the part of the story that is the component'),
              }),
            ]),
          )
          .max(MAX_STORYBOOK_COMPONENTS)
          .optional()
          .describe('Story titles, e.g. "Components/Button"'),
        job_id: z.string().optional().describe('Wait for an import already running'),
        captures: z.array(z.unknown()).optional().describe('From the CLI only'),
        agent_name: helpers.agentName,
      },
    },
    async ({ canvas_id, url, components, job_id, captures, agent_name }) => {
      if (!canvasFor(canvas_id, 'edit')) return noCanvas(canvas_id)
      if (job_id) {
        const job = jobById(canvas_id, job_id)
        if (!job) return err(`no Storybook import ${job_id} on this canvas (finished imports are kept 30 minutes)`)
        return answer(job, canvas_id, agent_name)
      }
      if (!ownerId) return err('importing needs a signed-in account')
      if (!url) return err('pass the Storybook url')
      try {
        const base = storybookBase(url).href
        const picks = parsePicks(
          (components ?? []).map((pick) =>
            typeof pick === 'string' ? pick : { title: pick.title, storyId: pick.story_id, select: pick.select },
          ),
        )
        if (!picks) return err('components must be story titles')
        const parsed = captures ? asCaptures(captures) : undefined
        if (typeof parsed === 'string') return err(parsed)
        if (!parsed && !picks.length)
          return err('pass components: the story titles to import (list_storybook_components lists them)')
        const running = runningJobOn(canvas_id)
        if (running)
          return err(`another Storybook job is running on this canvas (${running.id}); retry after it finishes`)
        const actor = actorFrom(agent_name)
        if (!helpers.takeImportSlot(ownerId)) return err('import rate limit — wait a minute')
        const count = parsed?.length ?? picks.length
        const job = startStorybookJob(
          {
            canvasId: canvas_id,
            url: base,
            picks,
            ...(parsed ? { captures: parsed } : {}),
            user: { id: ownerId, name: actor.owner ?? actor.name },
            actor,
          },
          `Importing ${count} ${count === 1 ? 'component' : 'components'} from Storybook`,
        )
        return answer(job, canvas_id, agent_name)
      } catch (error) {
        return err(error instanceof Error ? error.message : 'the Storybook import failed')
      }
    },
  )

  server.registerTool(
    'sync_storybook',
    {
      title: 'Sync components with Storybook',
      description:
        'Bring a canvas’s Storybook components up to date with the Storybook they came from: every component it imported is rendered again and updated where it changed (instances follow), unchanged ones are left alone, tokens it made take their new values. Pass url when the canvas imports from more than one Storybook. Call it after the Storybook was redeployed, e.g. from CI.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        canvas_id: z.string(),
        url: z.string().optional(),
        agent_name: helpers.agentName,
      },
    },
    async ({ canvas_id, url, agent_name }) => {
      if (!canvasFor(canvas_id, 'edit')) return noCanvas(canvas_id)
      if (!ownerId) return err('syncing needs a signed-in account')
      try {
        const sources = await sourcesOf(canvas_id)
        const wanted = url ? sources.filter((source) => source.url === storybookBase(url).href) : sources
        if (!wanted.length)
          return err(
            url
              ? 'this canvas imports nothing from that Storybook'
              : 'this canvas imports from no Storybook yet: use import_storybook',
          )
        if (wanted.length > 1)
          return text({
            ok: false,
            reason: 'this canvas imports from several Storybooks: pass url',
            sources: wanted.map(publicView),
          })
        const source = wanted[0]!
        const running = runningJobOn(canvas_id)
        if (running)
          return err(`another Storybook job is running on this canvas (${running.id}); retry after it finishes`)
        if (!helpers.takeImportSlot(ownerId)) return err('import rate limit — wait a minute')
        const actor = actorFrom(agent_name)
        const job = startStorybookJob(
          {
            canvasId: canvas_id,
            url: source.url,
            picks: source.components,
            syncSourceId: source.id,
            user: { id: ownerId, name: actor.owner ?? actor.name },
            actor,
          },
          `Syncing ${source.components.length} ${source.components.length === 1 ? 'component' : 'components'} from Storybook`,
        )
        return answer(job, canvas_id, agent_name)
      } catch (error) {
        return err(error instanceof Error ? error.message : 'the Storybook sync failed')
      }
    },
  )
}
