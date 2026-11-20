import express from 'express'
import * as actions from '../actions.ts'
import type { CanvasRouteHelpers } from '../extensions.ts'
import {
  MAX_STORYBOOK_COMPONENTS,
  type StorybookOffer,
  type StorybookSourceComponent,
} from '../../shared/storybookSource.ts'
import { storybookBase } from '../../shared/storybookIndex.ts'
import { readStorybook } from './importer.ts'
import { jobById, jobView, startStorybookJob, StorybookBusyError } from './jobs.ts'
import { deleteSource, publicView, sourceById, sourceByUrl, sourcesOf } from './sources.ts'

/**
 * The import section's HTTP surface, under /api/canvases/:id/storybook (edit role): read a
 * Storybook's components, import a pick, list and sync what the canvas imports from.
 * Spec: .context/specs/storybook-import.md, "Surfaces".
 */

function failure(res: express.Response, error: unknown, fallback: string) {
  if (error instanceof StorybookBusyError) return res.status(409).json({ error: error.message })
  const message = error instanceof Error ? error.message : fallback
  console.warn('[storybook]', fallback, message)
  res.status(400).json({ error: message })
}

/** `[{ title, storyId?, select? }]` as sent, or null when it is not that. */
export function parsePicks(raw: unknown): StorybookSourceComponent[] | null {
  if (!Array.isArray(raw)) return null
  const picks: StorybookSourceComponent[] = []
  for (const entry of raw) {
    const pick = typeof entry === 'string' ? { title: entry } : (entry as Record<string, unknown>)
    if (!pick || typeof pick.title !== 'string' || !pick.title.trim() || pick.title.length > 300) return null
    picks.push({
      title: pick.title,
      ...(typeof pick.storyId === 'string' && pick.storyId ? { storyId: pick.storyId.slice(0, 300) } : {}),
      ...(typeof pick.select === 'string' && pick.select ? { select: pick.select.slice(0, 300) } : {}),
    })
  }
  return picks
}

export function storybookCanvasRouter({ requireCanvas, takeImportSlot }: CanvasRouteHelpers): express.Router {
  const router = express.Router({ mergeParams: true })
  const person = (req: express.Request) => ({ id: req.user!.id, name: req.user!.name })

  router.post<{ id: string }>('/discover', async (req, res) => {
    const canvas = requireCanvas(req, res, req.params.id, 'edit')
    if (!canvas) return
    try {
      if (!takeImportSlot(req.user!.id)) return res.status(429).json({ error: 'too many imports — wait a minute' })
      const { base, components } = await readStorybook(String(req.body?.url ?? ''))
      const source = await sourceByUrl(canvas.id, base.href)
      const offers: StorybookOffer[] = components.map((component) => ({
        title: component.title,
        name: component.name,
        stories: component.stories.length,
        ...(component.codePath ? { codePath: component.codePath } : {}),
      }))
      res.json({ url: base.href, components: offers, source: source ? publicView(source) : null })
    } catch (error) {
      failure(res, error, 'reading the Storybook failed')
    }
  })

  router.post<{ id: string }>('/import', (req, res) => {
    const canvas = requireCanvas(req, res, req.params.id, 'edit')
    if (!canvas) return
    try {
      const picks = parsePicks(req.body?.components)
      if (!picks?.length) return res.status(400).json({ error: 'pick at least one component' })
      if (picks.length > MAX_STORYBOOK_COMPONENTS)
        return res.status(400).json({ error: `an import takes up to ${MAX_STORYBOOK_COMPONENTS} components at a time` })
      const url = storybookBase(String(req.body?.url ?? '')).href
      if (!takeImportSlot(req.user!.id)) return res.status(429).json({ error: 'too many imports — wait a minute' })
      const actor = actions.resolveActor({ name: req.user!.name, kind: 'user' })
      const label = `Importing ${picks.length} ${picks.length === 1 ? 'component' : 'components'} from Storybook`
      const job = startStorybookJob({ canvasId: canvas.id, url, picks, user: person(req), actor }, label)
      res.status(202).json({ job: jobView(job) })
    } catch (error) {
      failure(res, error, 'the import could not start')
    }
  })

  router.get<{ id: string }>('/sources', async (req, res) => {
    const canvas = requireCanvas(req, res, req.params.id, 'edit')
    if (!canvas) return
    try {
      res.json({ sources: (await sourcesOf(canvas.id)).map(publicView) })
    } catch (error) {
      failure(res, error, 'reading the Storybooks failed')
    }
  })

  router.post<{ id: string; sourceId: string }>('/sources/:sourceId/sync', async (req, res) => {
    const canvas = requireCanvas(req, res, req.params.id, 'edit')
    if (!canvas) return
    try {
      const source = await sourceById(canvas.id, req.params.sourceId)
      if (!source) return res.status(404).json({ error: 'not found' })
      if (!takeImportSlot(req.user!.id)) return res.status(429).json({ error: 'too many imports — wait a minute' })
      const actor = actions.resolveActor({ name: req.user!.name, kind: 'user' })
      const job = startStorybookJob(
        {
          canvasId: canvas.id,
          url: source.url,
          picks: source.components,
          syncSourceId: source.id,
          user: person(req),
          actor,
        },
        `Syncing ${source.components.length} ${source.components.length === 1 ? 'component' : 'components'} from Storybook`,
      )
      res.status(202).json({ job: jobView(job) })
    } catch (error) {
      failure(res, error, 'the sync could not start')
    }
  })

  router.delete<{ id: string; sourceId: string }>('/sources/:sourceId', async (req, res) => {
    const canvas = requireCanvas(req, res, req.params.id, 'edit')
    if (!canvas) return
    try {
      /* the components stay: only the link to the Storybook goes */
      if (!(await deleteSource(canvas.id, req.params.sourceId))) return res.status(404).json({ error: 'not found' })
      res.json({ ok: true })
    } catch (error) {
      failure(res, error, 'removing the Storybook failed')
    }
  })

  router.get<{ id: string; jobId: string }>('/jobs/:jobId', (req, res) => {
    const canvas = requireCanvas(req, res, req.params.id, 'edit')
    if (!canvas) return
    const job = jobById(canvas.id, req.params.jobId)
    if (!job) return res.status(404).json({ error: 'not found' })
    res.json({ job: jobView(job) })
  })

  return router
}
