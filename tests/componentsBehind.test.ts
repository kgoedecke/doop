import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { drizzle as pgliteDrizzle } from 'drizzle-orm/pglite'
import { db } from '../server/db/index.ts'
import * as t from '../server/db/schema.ts'
import type { ComponentDef } from '../shared/components.ts'

/* The propagation queue lives in memory: a restart mid-drain leaves instances on an older
   revision until their frame is written again (1,585 of them on prod, 2026-11-12). This
   finds them, in the database. */
vi.mock('../server/db/index.ts', async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const { drizzle } = await import('drizzle-orm/pglite')
  const schema = await import('../server/db/schema.ts')
  return { db: drizzle(new PGlite(), { schema }) }
})

const persist = await import('../server/db/persist.ts')

beforeAll(async () => {
  const { migrate } = await import('drizzle-orm/pglite/migrator')
  await migrate(db as unknown as ReturnType<typeof pgliteDrizzle>, { migrationsFolder: 'server/db/migrations' })
})

const def = (id: string, rev: number, status?: 'deleted'): ComponentDef => ({
  id,
  name: id,
  description: '',
  template: '<b></b>',
  css: '',
  rawCss: '',
  head: [],
  props: [],
  slots: [],
  rev,
  mainFrameId: null,
  history: [],
  createdAt: 1,
  updatedAt: 1,
  updatedBy: 'Ada',
  ...(status ? { status } : {}),
})

const frame = (id: string, canvasId: string, body: string) => ({
  id,
  canvasId,
  name: id,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  html: `<!doctype html><html><body>${body}</body></html>`,
  createdAt: 1,
  updatedAt: 1,
  updatedBy: 'Ada',
})

const use = (id: string, rev: number) => `<b data-doop-instance="${id}" data-doop-rev="${rev}"></b>`

describe('components with instances behind', () => {
  it('are the ones a stored instance is older than, and no others', async () => {
    persist.saveComponent('c1', def('behind', 3))
    persist.saveComponent('c1', def('current', 2))
    persist.saveComponent('c1', def('gone', 4, 'deleted'))
    persist.saveComponent('c2', def('behind', 5))
    await persist.pendingComponentWrites()
    await db.insert(t.frames).values([
      frame('f1', 'c1', use('behind', 3) + use('behind', 2) + use('current', 2) + use('gone', 1)),
      /* the same id on another canvas is that canvas's component */
      frame('f2', 'c2', use('behind', 5)),
    ])
    expect(await persist.componentsBehind()).toEqual([{ canvasId: 'c1', componentId: 'behind' }])
  })
})
