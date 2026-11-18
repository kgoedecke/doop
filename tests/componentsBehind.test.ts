import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { drizzle as pgliteDrizzle } from 'drizzle-orm/pglite'
import { db } from '../server/db/index.ts'
import * as t from '../server/db/schema.ts'
import type { ComponentDef } from '../shared/components.ts'

/* The propagation queue lives in memory: a restart mid-drain left instances on an older
   revision until their frame was written again (1,585 of them on prod, 2026-11-12). */
vi.mock('../server/db/index.ts', async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const { drizzle } = await import('drizzle-orm/pglite')
  const schema = await import('../server/db/schema.ts')
  return { db: drizzle(new PGlite(), { schema }) }
})

const persist = await import('../server/db/persist.ts')
const { wakingHtml } = await import('../server/frameRest.ts')

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

/** An instance as the engine writes it: the template's root, then its marker. */
const use = (id: string, rev: number, elementId: string, cls = '') =>
  `<b${cls ? ` class="${cls}"` : ''} data-doop-instance="${id}" data-doop-rev="${rev}" data-doop-id="${elementId}"></b>`

const kept = (rev: number, template: string) => ({
  rev,
  template,
  rawCss: '',
  head: [],
  props: [],
  savedAt: 1,
  savedBy: 'Ada',
})

describe('components with instances behind', () => {
  /* These were found by a query over every stored frame at boot (`componentsBehind`) and
     rewritten through the propagation queue. A frame is now brought up to its components
     when it is read (server/frameRest.ts), so what is behind is decided there, per frame,
     by the same rule: an instance marked older than its component's `renderRev`. */
  const awake = (body: string, defs: ComponentDef[]) => wakingHtml(frame('f', 'c', body).html, defs, 'test')
  const NOW = '<b class="now"></b>'

  it('are the ones a stored instance is older than, and no others', () => {
    const defs = [
      { ...def('behind', 3), template: NOW, history: [kept(2, '<b></b>')] },
      def('current', 2),
      { ...def('gone', 4, 'deleted'), template: NOW },
    ]
    const stored = [use('behind', 3, 'aaaaa1', 'now'), use('behind', 2, 'aaaaa2'), use('current', 2, 'aaaaa3')]
    const read = awake(stored.join('') + use('gone', 1, 'aaaaa4'), defs)
    /* the one behind is rendered at the current markup; the rest are as stored, byte for byte */
    expect(read).toContain(
      [stored[0], use('behind', 3, 'aaaaa2', 'now'), stored[2], use('gone', 1, 'aaaaa4')].join('') + '</body>',
    )
    /* the same id on another canvas is that canvas's component */
    const other = use('behind', 5, 'aaaaa5')
    expect(awake(other, [def('behind', 5)])).toBe(frame('f', 'c', other).html)
  })

  it('do not include instances behind only in revisions of the component’s rules', () => {
    /* 30 revisions, the markup last changed at the 4th: an instance marked 4 is current,
       however many times the stylesheet was saved since and whatever history was kept */
    const restyled = { ...def('restyled', 30), renderRev: 4, template: NOW, history: [kept(3, '<b></b>')] }
    const current = use('restyled', 4, 'aaaaa1', 'now') + use('restyled', 17, 'aaaaa2', 'now')
    expect(awake(current, [restyled])).toBe(frame('f', 'c', current).html)
    /* one from before the markup changed is behind */
    const read = awake(use('restyled', 4, 'aaaaa1', 'now') + use('restyled', 3, 'aaaaa2'), [restyled])
    expect(read).toContain(use('restyled', 4, 'aaaaa1', 'now') + use('restyled', 4, 'aaaaa2', 'now') + '</body>')
  })

  it('keep where a component last changed its markup, and each kept state’s span, across a load', async () => {
    const history = [
      { rev: 28, renderRev: 4, template: '<b></b>', rawCss: '', head: [], props: [], savedAt: 1, savedBy: 'Ada' },
      { rev: 29, template: '<i></i>', rawCss: '', head: [], props: [], savedAt: 1, savedBy: 'Ada' },
    ]
    await db.insert(t.canvases).values({ id: 'c5', name: 'Loaded', createdAt: 1, updatedAt: 1 })
    persist.saveComponent('c5', { ...def('spans', 31), renderRev: 30, history })
    await persist.pendingComponentWrites()
    const loaded = (await persist.hydrate()).canvases.find((canvas) => canvas.id === 'c5')!.components![0]!
    expect(loaded.renderRev).toBe(30)
    expect(loaded.history).toEqual(history)
  })
})
