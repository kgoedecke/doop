import { and, desc, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from '../db/index.ts'
import { storybookSources } from '../db/schema.ts'
import type { StorybookRunResult, StorybookSourceComponent, StorybookSourceView } from '../../shared/storybookSource.ts'

/**
 * The Storybooks a canvas imports from (`storybook_sources`): read and written when someone
 * imports or syncs, never kept in memory. Spec: .context/specs/storybook-import.md, "Sync".
 */

type Row = typeof storybookSources.$inferSelect

export interface StorybookSource extends StorybookSourceView {
  tokens: string[]
}

const view = (row: Row): StorybookSource => ({
  id: row.id,
  canvasId: row.canvasId,
  url: row.url,
  components: row.components,
  tokens: row.tokens,
  lastResult: row.lastResult ?? null,
  createdAt: row.createdAt,
  syncedAt: row.syncedAt ?? null,
})

/** What the import section shows: everything but the token bookkeeping. */
export const publicView = ({ tokens: _tokens, ...source }: StorybookSource): StorybookSourceView => source

export async function sourcesOf(canvasId: string): Promise<StorybookSource[]> {
  const rows = await db
    .select()
    .from(storybookSources)
    .where(eq(storybookSources.canvasId, canvasId))
    .orderBy(desc(storybookSources.createdAt))
  return rows.map(view)
}

export async function sourceById(canvasId: string, id: string): Promise<StorybookSource | null> {
  const [row] = await db
    .select()
    .from(storybookSources)
    .where(and(eq(storybookSources.canvasId, canvasId), eq(storybookSources.id, id)))
  return row ? view(row) : null
}

export async function sourceByUrl(canvasId: string, url: string): Promise<StorybookSource | null> {
  const [row] = await db
    .select()
    .from(storybookSources)
    .where(and(eq(storybookSources.canvasId, canvasId), eq(storybookSources.url, url)))
  return row ? view(row) : null
}

/** The source for this canvas and URL, made when there is none; its picks merged with `picked`
 *  (a title picked again keeps what it became). */
export async function upsertSource(
  canvasId: string,
  url: string,
  picked: StorybookSourceComponent[],
  userId: string,
): Promise<StorybookSource> {
  const existing = await sourceByUrl(canvasId, url)
  if (existing) {
    const known = new Map(existing.components.map((component) => [component.title, component]))
    for (const pick of picked) known.set(pick.title, { ...known.get(pick.title), ...pick })
    const components = [...known.values()]
    await db.update(storybookSources).set({ components }).where(eq(storybookSources.id, existing.id))
    return { ...existing, components }
  }
  const row = {
    id: nanoid(10),
    canvasId,
    url,
    components: picked,
    tokens: [],
    lastResult: null,
    createdBy: userId,
    createdAt: Date.now(),
    syncedAt: null,
  }
  await db.insert(storybookSources).values(row).onConflictDoNothing()
  /* a concurrent first import of the same Storybook made it first: use that one */
  return (await sourceByUrl(canvasId, url)) ?? view(row)
}

export async function recordRun(
  id: string,
  update: { components?: StorybookSourceComponent[]; tokens?: string[]; result?: StorybookRunResult },
): Promise<void> {
  await db
    .update(storybookSources)
    .set({
      components: update.components,
      tokens: update.tokens,
      lastResult: update.result,
      syncedAt: update.result?.at,
    })
    .where(eq(storybookSources.id, id))
}

export async function deleteSource(canvasId: string, id: string): Promise<boolean> {
  const deleted = await db
    .delete(storybookSources)
    .where(and(eq(storybookSources.canvasId, canvasId), eq(storybookSources.id, id)))
    .returning({ id: storybookSources.id })
  return deleted.length > 0
}
