import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_COMPONENT_HISTORY, type ComponentDef } from '../shared/components.ts'
import type { Canvas } from '../shared/types.ts'

/*
 * A component's earlier revisions are rows of component_revisions (migration 0062), where
 * they used to ride inline in the component's own row and were rewritten with it on every
 * change. Here: the real persistence code on an embedded Postgres with the whole migration
 * journal applied, so what is asserted is what the table holds.
 */
const database = vi.hoisted(() => ({ client: undefined as unknown as PGlite }))

vi.mock('../server/db/index.ts', async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const { drizzle } = await import('drizzle-orm/pglite')
  const { migrate } = await import('drizzle-orm/pglite/migrator')
  const { fileURLToPath } = await import('node:url')
  const schema = await import('../server/db/schema.ts')
  const client = new PGlite()
  const db = drizzle(client, { schema })
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../server/db/migrations', import.meta.url)) })
  database.client = client
  return { db }
})

const persist = await import('../server/db/persist.ts')
const { bumpRevision } = await import('../server/components.ts')
const { renameInComponents } = await import('../server/tokenRenames.ts')

const def = (patch: Partial<ComponentDef> = {}): ComponentDef => ({
  id: 'cmp-1',
  name: 'Button',
  description: '',
  template: '<button>rev 1</button>',
  css: '',
  rawCss: '.btn { color: red }',
  head: ['<link rel="stylesheet" href="/a.css">'],
  props: [{ name: 'label', type: 'text' }],
  slots: [],
  rev: 1,
  mainFrameId: null,
  history: [],
  createdAt: 1,
  updatedAt: 1,
  updatedBy: 'Ada',
  ...patch,
})

/** The next revision of a definition, as a change to its main makes it. */
const next = (from: ComponentDef): ComponentDef => {
  const bumped = bumpRevision(from, 'Grace')
  return { ...bumped, template: `<button>rev ${bumped.rev}</button>` }
}

const canvas = (id: string, components: ComponentDef[] = []): Canvas => ({
  id,
  name: id,
  frames: [],
  components,
  createdAt: 1,
  updatedAt: 1,
})

interface StoredRevision {
  rev: number
  template: string
  /** the transaction that wrote this row version: it changes if the row is ever rewritten */
  xmin: string
}

async function revisions(canvasId: string, componentId = 'cmp-1'): Promise<StoredRevision[]> {
  const result = await database.client.query<StoredRevision>(
    `select rev, template, xmin::text as xmin from component_revisions
     where canvas_id = $1 and component_id = $2 order by rev`,
    [canvasId, componentId],
  )
  return result.rows
}

async function save(canvasId: string, component: ComponentDef) {
  persist.saveComponent(canvasId, component)
  await persist.pendingComponentWrites()
}

async function loaded(canvasId: string): Promise<ComponentDef[]> {
  const { canvases } = await persist.hydrate()
  return canvases.find((candidate) => candidate.id === canvasId)?.components ?? []
}

let canvasId = ''
let made = 0

beforeEach(async () => {
  canvasId = `canvas-${++made}`
  await persist.saveCanvasCopy(canvas(canvasId))
})

describe('component revisions', () => {
  it('files one row for a new revision and leaves the earlier ones as they were written', async () => {
    const first = def()
    await save(canvasId, first)
    expect(await revisions(canvasId)).toEqual([])

    const second = next(first)
    await save(canvasId, second)
    const afterSecond = await revisions(canvasId)
    expect(afterSecond.map((row) => row.rev)).toEqual([1])
    expect(afterSecond[0]!.template).toBe('<button>rev 1</button>')

    await save(canvasId, next(second))
    const afterThird = await revisions(canvasId)
    expect(afterThird.map((row) => row.rev)).toEqual([1, 2])
    expect(afterThird[0]).toEqual(afterSecond[0])
  })

  it('files the state before a token rename as a revision, the new name in the definition', async () => {
    const first = def({
      template: '<button style="color:var(--ink)">Go</button>',
      rawCss: '.btn { color: var(--ink) }',
    })
    await save(canvasId, first)
    const held = [first]
    /* the definitions a token store hands the rename, each save filed as the server files it */
    renameInComponents(
      held,
      { kind: 'token', from: '--ink', to: '--text' },
      (component) => bumpRevision(component, 'Grace'),
      (component) => {
        held.splice(0, 1, component)
        persist.saveComponent(canvasId, component)
        return component
      },
    )
    await persist.pendingComponentWrites()
    expect((await revisions(canvasId)).map((row) => [row.rev, row.template])).toEqual([[1, first.template]])
    const [stored] = await loaded(canvasId)
    expect(stored).toMatchObject({ rev: 2, rawCss: '.btn { color: var(--text) }' })
    expect(stored!.template).toContain('var(--text)')
  })

  it('writes nothing to the revisions when a save changes none', async () => {
    const second = next(def())
    await save(canvasId, second)
    const before = await revisions(canvasId)
    await save(canvasId, { ...second, name: 'Renamed', updatedAt: 9 })
    expect(await revisions(canvasId)).toEqual(before)
    expect((await loaded(canvasId))[0]!.name).toBe('Renamed')
  })

  it('leaves the retired inline column alone', async () => {
    await save(canvasId, next(next(def())))
    const row = await database.client.query<{ history: unknown[] }>(
      'select history from components where canvas_id = $1',
      [canvasId],
    )
    expect(row.rows).toEqual([{ history: [] }])
  })

  it('keeps the newest revisions and prunes the rest', async () => {
    let current = def()
    await save(canvasId, current)
    for (let step = 0; step < MAX_COMPONENT_HISTORY + 5; step++) {
      current = next(current)
      await save(canvasId, current)
    }
    const kept = await revisions(canvasId)
    expect(kept).toHaveLength(MAX_COMPONENT_HISTORY)
    expect(kept.map((row) => row.rev)).toEqual(current.history.map((entry) => entry.rev))
    expect(kept[0]!.rev).toBe(6)
  })

  it('files every revision a save skipped past, when only the latest state was sent', async () => {
    const first = def()
    const second = next(first)
    const third = next(second)
    persist.saveComponent(canvasId, first)
    persist.saveComponent(canvasId, second)
    persist.saveComponent(canvasId, third)
    await persist.pendingComponentWrites()
    expect((await revisions(canvasId)).map((row) => row.rev)).toEqual([1, 2])
  })

  it('loads at boot as the history memory held', async () => {
    let current = def()
    for (let step = 0; step < 3; step++) current = next(current)
    await save(canvasId, current)
    const [again] = await loaded(canvasId)
    expect(again!.rev).toBe(4)
    expect(again!.history).toEqual(current.history)
    /* and a save after that boot adds only what is new */
    const before = await revisions(canvasId)
    await save(canvasId, next(again!))
    const after = await revisions(canvasId)
    expect(after.map((row) => row.rev)).toEqual([1, 2, 3, 4])
    expect(after.slice(0, 3)).toEqual(before)
  })

  it('never writes over a revision already filed', async () => {
    /* a row this process does not know is there, so the save sends revision 1 again */
    await database.client.query(
      `insert into component_revisions (canvas_id, component_id, rev, template, raw_css, head, props, saved_at, saved_by)
       values ($1, 'cmp-2', 1, 'kept', '', '[]', '[]', 1, 'Ada')`,
      [canvasId],
    )
    const other = next(def({ id: 'cmp-2' }))
    await save(canvasId, other)
    expect((await revisions(canvasId, 'cmp-2')).map((row) => row.template)).toEqual(['kept'])
  })

  it('drops the revisions of a definition made again under its id', async () => {
    let current = def()
    for (let step = 0; step < 3; step++) current = next(current)
    await save(canvasId, current)
    /* back at an earlier revision with no history: not the definition those rows were kept for */
    const again = def({ template: '<button>made again</button>' })
    await save(canvasId, again)
    expect(await revisions(canvasId)).toEqual([])
    await save(canvasId, next(again))
    expect((await revisions(canvasId)).map((row) => row.template)).toEqual(['<button>made again</button>'])
  })

  it('removes a component’s revisions with the component', async () => {
    await save(canvasId, next(next(def())))
    await save(canvasId, next(def({ id: 'cmp-2' })))
    persist.deleteComponent(canvasId, 'cmp-1')
    await persist.pendingComponentWrites()
    expect(await revisions(canvasId)).toEqual([])
    expect(await revisions(canvasId, 'cmp-2')).toHaveLength(1)
    expect((await loaded(canvasId)).map((component) => component.id)).toEqual(['cmp-2'])
  })

  it('copies revisions with a duplicated canvas and removes them with a deleted one', async () => {
    const component = next(next(def()))
    await save(canvasId, component)
    const copyId = `${canvasId}-copy`
    await persist.saveCanvasCopy(canvas(copyId, [{ ...component, updatedBy: 'Copier' }]))
    expect((await revisions(copyId)).map((row) => row.rev)).toEqual([1, 2])
    expect((await loaded(copyId))[0]!.history).toEqual(component.history)
    /* the copy's next revision is one more row, on the copy alone */
    await save(copyId, next(component))
    expect((await revisions(copyId)).map((row) => row.rev)).toEqual([1, 2, 3])
    expect((await revisions(canvasId)).map((row) => row.rev)).toEqual([1, 2])

    persist.deleteCanvas(canvasId)
    await vi.waitFor(async () => expect(await revisions(canvasId)).toEqual([]))
    expect(await revisions(copyId)).toHaveLength(3)
  })
})

describe('migration 0062', () => {
  it('turns every inline history entry into a revision row, and can run again', async () => {
    const db = new PGlite()
    try {
      await db.exec(`CREATE TABLE components (canvas_id text NOT NULL, id text NOT NULL, history jsonb NOT NULL,
        updated_at bigint NOT NULL, PRIMARY KEY (canvas_id, id))`)
      const entry = (rev: number, extra: object = {}) => ({
        rev,
        template: `<b>${rev}</b>`,
        rawCss: `.r${rev}{}`,
        head: [`<link href="/${rev}.css">`],
        props: [{ name: 'label', type: 'text' }],
        savedAt: 1000 + rev,
        savedBy: 'Ada',
        ...extra,
      })
      await db.query('INSERT INTO components VALUES ($1, $2, $3, 5), ($1, $4, $5, 6), ($6, $2, $7, 7)', [
        'canvas-a',
        'cmp-1',
        JSON.stringify([entry(1), entry(2), entry(2, { template: 'a repeat' })]),
        'cmp-2',
        JSON.stringify([]),
        'canvas-b',
        /* an entry from before a field existed, and one that is not a revision at all */
        JSON.stringify([{ rev: 4, template: '<i>4</i>' }, { template: 'no rev' }]),
      ])
      const migration = readFileSync(
        new URL('../server/db/migrations/0062_component_revisions.sql', import.meta.url),
        'utf8',
      ).replaceAll('--> statement-breakpoint', '')
      await db.exec(migration)
      await db.exec(migration)
      const rows = await db.query('SELECT * FROM component_revisions ORDER BY canvas_id, component_id, rev')
      expect(rows.rows).toEqual([
        {
          canvas_id: 'canvas-a',
          component_id: 'cmp-1',
          rev: 1,
          template: '<b>1</b>',
          raw_css: '.r1{}',
          head: ['<link href="/1.css">'],
          props: [{ name: 'label', type: 'text' }],
          saved_at: 1001,
          saved_by: 'Ada',
        },
        expect.objectContaining({ canvas_id: 'canvas-a', rev: 2, template: '<b>2</b>' }),
        {
          canvas_id: 'canvas-b',
          component_id: 'cmp-1',
          rev: 4,
          template: '<i>4</i>',
          raw_css: '',
          head: [],
          props: [],
          saved_at: 7,
          saved_by: '',
        },
      ])
      /* the inline column stays for the release before this one, and new rows need not fill it */
      await db.exec(`INSERT INTO components (canvas_id, id, updated_at) VALUES ('canvas-c', 'cmp-9', 1)`)
      const kept = await db.query<{ n: number }>(
        `SELECT jsonb_array_length(history) AS n FROM components WHERE canvas_id = 'canvas-a' AND id = 'cmp-1'`,
      )
      expect(kept.rows[0]!.n).toBe(3)
    } finally {
      await db.close()
    }
  }, 30_000)
})
