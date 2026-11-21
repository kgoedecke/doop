import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  saveFrame: () => {},
  saveActivity: () => {},
  saveFrameVersion: () => {},
  saveTask: () => {},
  saveComponent: () => {},
  deleteComponent: () => {},
  deleteFrame: () => {},
}))

/* every engine parse of a document, by what was parsed: how a test knows which frames were read */
const parsed = vi.hoisted(() => ({ documents: [] as string[] }))

vi.mock('../server/workBudget.ts', async (original) => {
  const real = await original<typeof import('../server/workBudget.ts')>()
  return {
    ...real,
    parse: ((html: string, options?: never) => {
      parsed.documents.push(html)
      return real.parse(html, options)
    }) as typeof real.parse,
  }
})

import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import * as actions from '../server/actions.ts'
import * as propagation from '../server/propagation.ts'
import { blankComponent } from '../server/components.ts'
import { catalog, componentDetail, updateComponent, usageOf } from '../server/componentActions.ts'
import { usageScans } from '../server/componentUsage.ts'
import { COMPONENT_ATTR, INSTANCE_ATTR } from '../shared/components.ts'
import type { Actor, Canvas } from '../shared/types.ts'

const OWNER = 'owner-usage'
const actor = { name: 'Tester', kind: 'user', color: '#000', clientId: 'x' } as unknown as Actor

const doc = (body: string) => `<!doctype html><html><head><style></style></head><body>${body}</body></html>`
const framed = (id: string) => store.getFrame(id)!.html

/** Usage as it was computed before the index: one split of every frame per component. */
function oldUsageOf(canvas: Canvas, id: string) {
  const marker = ` ${INSTANCE_ATTR}="${id}"`
  const frames = canvas.frames.flatMap((frame) => {
    const instances = frame.html.split(marker).length - 1
    return instances
      ? [{ id: frame.id, name: frame.name, instances, approved: frame.approval?.status === 'ready_for_dev' }]
      : []
  })
  return { instances: frames.reduce((total, frame) => total + frame.instances, 0), frames }
}

/** Five components (one nesting another, one unused) across twenty frames, some approved. */
function fixture() {
  const canvas = store.createCanvas('usage test', OWNER)
  const make = (name: string, markup: (id: string) => string) => {
    const def = blankComponent({ name, by: 'Tester' })
    store.saveComponent(canvas.id, def)
    const frame = actions.createFrame(canvas.id, { name: `${name} main`, html: '' }, actor)!
    actions.updateFrame(frame.id, { html: doc(markup(def.id)) }, actor)
    return { def, frame }
  }
  const button = make('Button', (id) => `<button class="btn" ${COMPONENT_ATTR}="${id}"><span>Buy</span></button>`)
  const tag = make('Tag', (id) => `<span class="tag" ${COMPONENT_ATTR}="${id}">New</span>`)
  const card = make(
    'Card',
    (id) => `<div class="card" ${COMPONENT_ATTR}="${id}"><h2>T</h2><doop-use component="Button"></doop-use></div>`,
  )
  const row = make('Row', (id) => `<li class="row" ${COMPONENT_ATTR}="${id}"><span>Row</span></li>`)
  const unused = make('Unused', (id) => `<i ${COMPONENT_ATTR}="${id}">x</i>`)
  const bodies = [
    `<doop-use component="Button"></doop-use><doop-use component="Button"></doop-use>`,
    `<doop-use component="Card"></doop-use><doop-use component="Tag"></doop-use>`,
    `<ul><doop-use component="Row"></doop-use><doop-use component="Row"></doop-use><doop-use component="Row"></doop-use></ul>`,
    `<p>no components, but the text data-doop-instance="${button.def.id}" in a paragraph</p>`,
    `<p>plain</p>`,
  ]
  const frames = Array.from({ length: 20 }, (_, index) => {
    const frame = actions.createFrame(canvas.id, { name: `Page ${index}`, html: '' }, actor)!
    actions.updateFrame(frame.id, { html: doc(bodies[index % bodies.length]!) }, actor)
    if (index % 4 === 0) actions.setFrameApproval(frame.id, true, { id: 'u', name: 'Reviewer' })
    return frame
  })
  return { canvas, button, tag, card, row, unused, frames }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await propagation.whenIdle()
})

describe('component usage', () => {
  it('is what splitting every frame per component gave', () => {
    const { canvas, frames } = fixture()
    for (const def of canvas.components ?? []) expect(usageOf(canvas, def.id)).toEqual(oldUsageOf(canvas, def.id))
    expect(usageOf(canvas, 'nosuch')).toEqual({ instances: 0, frames: [] })
    /* and again after a write, a rename, an approval and a delete */
    actions.updateFrame(frames[4]!.id, { html: doc(`<doop-use component="Tag"></doop-use>`) }, actor)
    actions.updateFrame(frames[0]!.id, { name: 'Renamed' }, actor)
    actions.setFrameApproval(frames[1]!.id, true, { id: 'u', name: 'Reviewer' })
    actions.deleteFrame(frames[2]!.id, actor)
    for (const def of canvas.components ?? []) {
      expect(usageOf(canvas, def.id)).toEqual(oldUsageOf(canvas, def.id))
      expect(componentDetail(canvas, def).usage_by_frame).toEqual(oldUsageOf(canvas, def.id).frames)
    }
  })

  it('reads the canvas once for a whole catalog, and only written frames after that', () => {
    const { canvas, frames } = fixture()
    const total = canvas.frames.length
    const first = usageScans()
    const entries = catalog(canvas)
    expect(entries.map((entry) => entry.instances)).toEqual(
      (canvas.components ?? []).map((def) => oldUsageOf(canvas, def.id).instances),
    )
    expect(usageScans().passes - first.passes).toBe(1)
    expect(usageScans().framesScanned - first.framesScanned).toBe(total)

    const second = usageScans()
    catalog(canvas)
    expect(usageScans().passes - second.passes).toBe(1)
    expect(usageScans().framesScanned - second.framesScanned).toBe(0)

    actions.updateFrame(frames[4]!.id, { html: doc(`<doop-use component="Tag"></doop-use>`) }, actor)
    const third = usageScans()
    expect(catalog(canvas).find((entry) => entry.name === 'Tag')!.instances).toBe(5)
    expect(usageScans().framesScanned - third.framesScanned).toBe(1)
  })

  it('makes get_canvas one pass over the canvas, whatever the number of components', async () => {
    const { canvas } = fixture()
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await buildMcpServer('Owner', OWNER).connect(serverSide)
    const client = new Client({ name: 'usage-test', version: '0' })
    await client.connect(clientSide)
    catalog(canvas)
    const before = usageScans()
    const response = (await client.callTool({
      name: 'get_canvas',
      arguments: { canvas_id: canvas.id, agent_name: 'Tester' },
    })) as { content: { text?: string }[] }
    const data = JSON.parse(response.content[0]!.text!) as { components: { name: string; instances: number }[] }
    expect(data.components.map((entry) => [entry.name, entry.instances])).toEqual(
      (canvas.components ?? []).map((def) => [def.name, oldUsageOf(canvas, def.id).instances]),
    )
    expect(usageScans().passes - before.passes).toBe(1)
    expect(usageScans().framesScanned - before.framesScanned).toBe(0)
    await client.close()
  })
})

describe('a dry run of update_component', () => {
  it('parses no frame when no instance could lose an override', () => {
    const { canvas, button } = fixture()
    parsed.documents.length = 0
    const dry = updateComponent(
      canvas.id,
      'Button',
      { find: 'class="btn"', replace: 'class="btn big"', dryRun: true },
      actor,
    )
    expect(dry.impact.instances).toBe(oldUsageOf(canvas, button.def.id).instances)
    expect(dry.impact.overrides_orphaned).toEqual([])
    expect(parsed.documents).toEqual([])
  })

  it('parses only the frames whose instances carry overrides, and finds the ones a rewrite orphans', () => {
    const { canvas, frames } = fixture()
    const overridden = frames[0]!
    actions.updateFrame(
      overridden.id,
      { html: framed(overridden.id).replace('<span', '<span style="color: red"') },
      actor,
    )
    expect(framed(overridden.id)).toContain('data-doop-overrides')
    parsed.documents.length = 0
    const dry = updateComponent(canvas.id, 'Button', { html: '<button class="btn">Buy</button>', dryRun: true }, actor)
    expect(dry.impact.overrides_orphaned).toHaveLength(1)
    expect(dry.impact.overrides_orphaned[0]!.frame_id).toBe(overridden.id)
    expect(parsed.documents).toEqual([framed(overridden.id)])
  })
})
