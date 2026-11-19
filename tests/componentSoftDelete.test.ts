import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  refreshAssetRefs: () => {},
  saveFrame: () => {},
  saveFrameNow: async () => {},
  saveActivity: () => {},
  saveFrameVersion: () => {},
  saveTask: () => {},
  saveComponent: () => {},
  deleteComponent: () => {},
  deleteFrame: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
}))

import { buildMcpServer } from '../server/mcp.ts'
import { execTool, newRunState, RESIDENT_TOOL_NAMES } from '../server/resident.ts'
import { store } from '../server/store.ts'
import * as actions from '../server/actions.ts'
import { settleIdleStreams } from '../server/canvasWrites.ts'
import * as propagation from '../server/propagation.ts'
import { blankComponent } from '../server/components.ts'
import {
  catalog,
  changeInstances,
  compactFrameHtml,
  ComponentError,
  deleteComponent,
  deletedComponentsInUse,
  detachAllInstances,
  importComponent,
  insertInstance,
  restoreComponent,
  syncComponent,
  updateComponent,
} from '../server/componentActions.ts'
import { COMPONENT_ATTR, INSTANCE_ATTR } from '../shared/components.ts'
import { DEFAULT_ROLE_ID, roleName } from '../shared/agents.ts'
import { renderedHtml } from './rendered.ts'
import type { Actor } from '../shared/types.ts'

const OWNER = 'owner-soft-delete'
const actor = { name: 'Tester', kind: 'user', color: '#000', clientId: 'x' } as unknown as Actor

const doc = (body: string, css = '') =>
  `<!doctype html><html><head><style>${css}</style></head><body>${body}</body></html>`

const framed = renderedHtml
const current = (canvasId: string, id: string) => store.getComponents(canvasId).find((d) => d.id === id)!

/** A Button, a Card built from it, and pages using each. */
function setup(pages = 6) {
  const canvas = store.createCanvas('soft delete test', OWNER)
  const button = blankComponent({ name: 'Button', by: 'Tester' })
  store.saveComponent(canvas.id, button)
  const buttonMain = actions.createFrame(canvas.id, { name: 'Button main', html: '' }, actor)!
  actions.updateFrame(
    buttonMain.id,
    {
      html: doc(
        `<button class="btn" ${COMPONENT_ATTR}="${button.id}"><span data-doop-prop="label">Buy</span></button>`,
        '.btn { padding: 8px; background: teal }',
      ),
    },
    actor,
  )
  const card = blankComponent({ name: 'Card', by: 'Tester' })
  store.saveComponent(canvas.id, card)
  const cardMain = actions.createFrame(canvas.id, { name: 'Card main', html: '' }, actor)!
  actions.updateFrame(
    cardMain.id,
    {
      html: doc(
        `<div class="card" ${COMPONENT_ATTR}="${card.id}"><h2 data-doop-prop="title">Title</h2><doop-use component="Button" label="Inside"></doop-use></div>`,
        '.card { border: 1px solid }',
      ),
    },
    actor,
  )
  const frames = Array.from({ length: pages }, (_, index) => {
    const frame = actions.createFrame(canvas.id, { name: `Page ${index}`, html: '' }, actor)!
    const body =
      index % 2 === 0
        ? `<doop-use component="Button" label="Go ${index}"></doop-use><p>text ${index}</p>`
        : `<doop-use component="Card" title="Card ${index}"></doop-use>`
    actions.updateFrame(frame.id, { html: doc(body) }, actor)
    return frame
  })
  return { canvas, button, buttonMain, card, cardMain, frames }
}

const allHtml = (canvasId: string) =>
  Object.fromEntries(store.getCanvas(canvasId)!.frames.map((frame) => [frame.id, framed(frame.id)]))

afterEach(async () => {
  vi.restoreAllMocks()
  await propagation.whenIdle()
})

describe('deleting a component', () => {
  it('writes no frame, keeps every instance byte for byte, and keeps the definition', async () => {
    const { canvas, button } = setup()
    await propagation.whenIdle()
    const before = allHtml(canvas.id)
    const frameWrites = vi.spyOn(store, 'updateFrame')

    const result = deleteComponent(canvas.id, 'Button', actor)

    expect(frameWrites).not.toHaveBeenCalled()
    await propagation.whenIdle()
    expect(frameWrites).not.toHaveBeenCalled()
    expect(allHtml(canvas.id)).toEqual(before)
    const kept = current(canvas.id, button.id)
    expect(kept.status).toBe('deleted')
    expect(kept.deletedBy).toBe('Tester')
    expect(kept.deletedAt).toBeGreaterThan(0)
    expect(kept.template).toContain('btn')
    /* 3 pages use it directly, 3 through a Card, and the Card's main holds one */
    expect(result).toMatchObject({ deleted: 'Button', instances_kept: 7, frames: 7 })
    expect(catalog(canvas).map((entry) => entry.name)).toEqual(['Card'])
    expect(deletedComponentsInUse(canvas)).toMatchObject([{ id: button.id, name: 'Button', instances: 7 }])
  })

  it('is refused twice, and names what can be done instead', () => {
    const { canvas } = setup(2)
    deleteComponent(canvas.id, 'Button', actor)
    expect(() => deleteComponent(canvas.id, 'Button', actor)).toThrow(/already deleted/)
    expect(() => updateComponent(canvas.id, 'Button', { description: 'x' }, actor)).toThrow(/was deleted.*restore/i)
  })

  it('leaves its instances out of everything that follows a main', async () => {
    const { canvas, button, buttonMain, frames } = setup()
    await propagation.whenIdle()
    deleteComponent(canvas.id, 'Button', actor)
    const definition = current(canvas.id, button.id)
    const before = allHtml(canvas.id)

    /* an old client saves the deleted main, changed: only that frame takes it */
    const edited = framed(buttonMain.id).replace('class="btn"', 'class="btn stale-edit"')
    actions.updateFrame(buttonMain.id, { html: edited }, actor)
    expect(framed(buttonMain.id)).toContain('btn stale-edit')
    expect(framed(buttonMain.id)).toContain(`${COMPONENT_ATTR}="${button.id}"`)
    expect(propagation.pendingFrames(canvas.id)).toBe(0)
    await propagation.whenIdle()

    expect(current(canvas.id, button.id)).toBe(definition)
    expect(current(canvas.id, button.id).status).toBe('deleted')
    for (const frame of frames) expect(framed(frame.id)).toBe(before[frame.id])

    /* and a frame holding an instance saves unchanged, its stylesheet still in the head */
    const page = frames[0]!
    actions.updateFrame(page.id, { html: framed(page.id) }, actor)
    expect(framed(page.id)).toBe(before[page.id])
    expect(framed(page.id)).toContain(`data-doop-component-css="${button.id}"`)
  })

  it('does not come back when its main reappears in another frame', () => {
    const { canvas, button, buttonMain } = setup(2)
    const main = /<button[\s\S]*?<\/button>/.exec(framed(buttonMain.id))![0]
    deleteComponent(canvas.id, 'Button', actor)
    const definition = current(canvas.id, button.id)
    const fresh = actions.createFrame(canvas.id, { name: 'Pasted', html: '' }, actor)!
    actions.updateFrame(fresh.id, { html: doc(`${main.replace('Buy', 'Sell')}<p>pasted</p>`) }, actor)
    expect(current(canvas.id, button.id)).toBe(definition)
    expect(framed(fresh.id)).toContain('Sell')
    expect(framed(fresh.id)).toContain(`${COMPONENT_ATTR}="${button.id}"`)
    expect(actions.takeComponentIssues(fresh.id)).toEqual([])
  })

  it('refuses a new use, in markup and through insert_instance', () => {
    const { canvas, frames } = setup(2)
    deleteComponent(canvas.id, 'Button', actor)
    const page = frames[0]!
    actions.updateFrame(
      page.id,
      { html: doc(`<p>kept</p><doop-use component="Button" label="New"></doop-use>`) },
      actor,
    )
    expect(framed(page.id)).toContain('<p>kept</p>')
    expect(framed(page.id)).not.toContain('New')
    const issues = actions.takeComponentIssues(page.id)
    expect(issues.map((issue) => issue.code)).toContain('deleted_component')
    expect(issues.find((issue) => issue.code === 'deleted_component')!.message).toMatch(
      /“Button” was deleted.*restore/i,
    )

    expect(() => insertInstance(canvas.id, { frameId: page.id, component: 'Button' }, actor)).toThrow(ComponentError)
    expect(() => insertInstance(canvas.id, { frameId: page.id, component: 'Button' }, actor)).toThrow(/was deleted/)
  })

  it('reads back as full markup, so writing a frame back never asks for it again', () => {
    const { canvas, frames } = setup(2)
    const page = frames[0]!
    expect(compactFrameHtml(store.getFrame(page.id)!)).toContain('<doop-use component="Button"')
    deleteComponent(canvas.id, 'Button', actor)
    const before = framed(page.id)
    const compact = compactFrameHtml(store.getFrame(page.id)!)
    expect(compact).not.toContain('<doop-use')
    expect(compact).toContain(INSTANCE_ATTR)
    actions.updateFrame(page.id, { html: compact }, actor)
    expect(framed(page.id)).toBe(before)
    expect(actions.takeComponentIssues(page.id)).toEqual([])
  })

  it('is allowed while another component is built from it, which keeps rendering as it did', async () => {
    const { canvas, cardMain, frames } = setup()
    await propagation.whenIdle()
    const before = allHtml(canvas.id)
    expect(() => deleteComponent(canvas.id, 'Button', actor)).not.toThrow()
    expect(allHtml(canvas.id)).toEqual(before)

    /* the Card changes: its instances follow, each still holding the Button it was drawn with */
    actions.updateFrame(cardMain.id, { html: framed(cardMain.id).replace('class="card"', 'class="card wide"') }, actor)
    await propagation.whenIdle()
    const cardPage = frames[1]!
    expect(framed(cardPage.id)).toContain('card wide')
    expect(framed(cardPage.id)).toContain('Inside')
    expect(framed(cardPage.id)).toContain('class="btn"')
    expect(framed(cardMain.id)).toContain('Inside')
    /* a new Card can still be placed, Button and all */
    actions.updateFrame(frames[0]!.id, { html: doc(`<doop-use component="Card" title="Fresh"></doop-use>`) }, actor)
    expect(framed(frames[0]!.id)).toContain('Fresh')
    expect(framed(frames[0]!.id)).toContain('Inside')
    expect(actions.takeComponentIssues(frames[0]!.id)).toEqual([])
  })

  it('still lets one instance be detached, and refuses to change one', () => {
    const { canvas, frames } = setup(2)
    const page = frames[0]!
    const instanceId = /data-doop-id="([^"]+)"/.exec(framed(page.id))![1]!
    deleteComponent(canvas.id, 'Button', actor)
    expect(() => changeInstances(canvas.id, page.id, [{ instanceId, props: { label: 'x' } }], actor)).toThrow(
      /was deleted/,
    )
    changeInstances(canvas.id, page.id, [{ instanceId, detach: true }], actor)
    expect(framed(page.id)).not.toContain(` ${INSTANCE_ATTR}="`)
    expect(framed(page.id)).toContain('data-doop-detached-from')
    expect(framed(page.id)).toContain('Go 0')
  })
})

describe('importing a component built from a deleted one', () => {
  it('copies the deleted dependency, still deleted, so the imported component is whole', async () => {
    const source = setup(0)
    await propagation.whenIdle()
    deleteComponent(source.canvas.id, 'Button', actor)
    const target = store.createCanvas('personal target', OWNER)

    const card = importComponent(target.id, source.canvas.id, 'Card', actor)
    await propagation.whenIdle()

    const defs = store.getComponents(target.id)
    const button = defs.find((def) => def.id === source.button.id)
    expect(button).toMatchObject({ status: 'deleted', name: 'Button', mainFrameId: null })
    expect(button!.template).toBe(current(source.canvas.id, source.button.id).template)
    expect(button!.css).toBe(current(source.canvas.id, source.button.id).css)
    expect(catalog(target).map((entry) => entry.name)).toEqual(['Card'])
    /* the Card's own main, and a new instance of it, hold the button */
    expect(card.template).toContain(`component="${source.button.id}"`)
    expect(framed(card.mainFrameId!)).toContain('Inside')
    expect(framed(card.mainFrameId!)).toContain('class="btn"')
    const page = actions.createFrame(target.id, { name: 'Page', html: '' }, actor)!
    actions.updateFrame(page.id, { html: doc('<doop-use component="Card" title="Mine"></doop-use>') }, actor)
    expect(framed(page.id)).toContain('Mine')
    expect(framed(page.id)).toContain('Inside')
    expect(framed(page.id)).toContain(`data-doop-component-css="${source.button.id}"`)
    expect(actions.takeComponentIssues(page.id)).toEqual([])
    /* and it is not there to be used by itself */
    expect(() => insertInstance(target.id, { frameId: page.id, component: 'Button' }, actor)).toThrow(/was deleted/)
  })

  it('leaves a dependency this canvas already has, deleted or not, as it is on a later sync', async () => {
    const source = setup(0)
    await propagation.whenIdle()
    const target = store.createCanvas('personal target', OWNER)
    importComponent(target.id, source.canvas.id, 'Card', actor)
    await propagation.whenIdle()
    const mine = current(target.id, source.button.id)
    expect(mine.status ?? 'active').toBe('active')
    /* the source deletes its Button, then changes the Card */
    deleteComponent(source.canvas.id, 'Button', actor)
    updateComponent(source.canvas.id, 'Card', { find: 'class="card"', replace: 'class="card v2"' }, actor)
    await propagation.whenIdle()

    const synced = syncComponent(target.id, 'Card', actor, () => true)
    await propagation.whenIdle()
    expect(synced.updated).toBe(true)
    expect(current(target.id, source.card.id).template).toContain('card v2')
    expect(current(target.id, source.button.id)).toBe(mine)
  })
})

describe('restoring a component', () => {
  it('round-trips: active again on its surviving main, and instances follow it again', async () => {
    const { canvas, button, buttonMain, frames } = setup()
    await propagation.whenIdle()
    const before = allHtml(canvas.id)
    const frameCount = canvas.frames.length
    deleteComponent(canvas.id, 'Button', actor)

    const restored = restoreComponent(canvas.id, 'Button', actor)
    await propagation.whenIdle()

    expect(restored.component.id).toBe(button.id)
    expect(restored.main).toBe('kept')
    const def = current(canvas.id, button.id)
    expect(def.status ?? 'active').toBe('active')
    expect(def.deletedAt).toBeUndefined()
    expect(def.mainFrameId).toBe(buttonMain.id)
    expect(def.rev).toBe(1)
    expect(canvas.frames).toHaveLength(frameCount)
    expect(allHtml(canvas.id)).toEqual(before)
    expect(
      catalog(canvas)
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(['Button', 'Card'])
    expect(deletedComponentsInUse(canvas)).toEqual([])

    actions.updateFrame(
      buttonMain.id,
      { html: framed(buttonMain.id).replace('class="btn"', 'class="btn again"') },
      actor,
    )
    await propagation.whenIdle()
    expect(framed(frames[0]!.id)).toContain('btn again')
    expect(framed(frames[1]!.id)).toContain('btn again')
  })

  it('writes a main from the kept definition when the old one is gone', async () => {
    const { canvas, button, buttonMain, frames } = setup(2)
    await propagation.whenIdle()
    deleteComponent(canvas.id, 'Button', actor)
    actions.deleteFrame(buttonMain.id, actor)
    const before = framed(frames[0]!.id)

    const restored = restoreComponent(canvas.id, button.id, actor)
    await propagation.whenIdle()

    expect(restored.main).toBe('written')
    const def = current(canvas.id, button.id)
    expect(def.mainFrameId).not.toBeNull()
    expect(def.mainFrameId).not.toBe(buttonMain.id)
    expect(framed(def.mainFrameId!)).toContain(`${COMPONENT_ATTR}="${button.id}"`)
    expect(framed(def.mainFrameId!)).toContain('Buy')
    expect(def.template).toContain('btn')
    expect(framed(frames[0]!.id)).toBe(before)
  })

  it('takes edits made to its main while it was deleted as a new revision', async () => {
    const { canvas, button, buttonMain, frames } = setup(2)
    await propagation.whenIdle()
    deleteComponent(canvas.id, 'Button', actor)
    actions.updateFrame(
      buttonMain.id,
      { html: framed(buttonMain.id).replace('class="btn"', 'class="btn late"') },
      actor,
    )
    expect(current(canvas.id, button.id).rev).toBe(1)

    restoreComponent(canvas.id, 'Button', actor)
    expect(current(canvas.id, button.id).rev).toBe(2)
    await propagation.whenIdle()
    expect(framed(frames[0]!.id)).toContain('btn late')
  })

  it('takes another name when its own was given away meanwhile', () => {
    const { canvas, button } = setup(2)
    deleteComponent(canvas.id, 'Button', actor)
    const replacement = blankComponent({ name: 'Button', by: 'Tester' })
    store.saveComponent(canvas.id, replacement)
    const restored = restoreComponent(canvas.id, button.id, actor)
    expect(restored.component.name).toBe('Button (restored)')
    expect(() => restoreComponent(canvas.id, button.id, actor)).toThrow(/not deleted/)
  })
})

describe('detaching every instance', () => {
  it('runs through the queue, a frame per tick, and leaves plain markup', async () => {
    const { canvas, button, frames } = setup()
    await propagation.whenIdle()
    deleteComponent(canvas.id, 'Button', actor)
    const before = allHtml(canvas.id)
    let turn = 0
    const immediate = globalThis.setImmediate
    vi.spyOn(globalThis, 'setImmediate').mockImplementation(((run: () => void) =>
      immediate(() => {
        turn += 1
        run()
      })) as typeof setImmediate)
    const perTurn = new Map<number, number>()
    vi.spyOn(store, 'updateFrame').mockImplementation(function (this: typeof store, ...args) {
      perTurn.set(turn, (perTurn.get(turn) ?? 0) + 1)
      return Object.getPrototypeOf(store).updateFrame.apply(store, args)
    })

    const queued = detachAllInstances(canvas.id, 'Button', actor)

    expect(queued).toMatchObject({ queued: true, instances: 7, frames: 7 })
    expect(allHtml(canvas.id)).toEqual(before)
    expect(perTurn.size).toBe(0)

    await propagation.whenIdle()
    expect(Math.max(...perTurn.values())).toBe(1)
    const direct = framed(frames[0]!.id)
    expect(direct).not.toContain(` ${INSTANCE_ATTR}="${button.id}"`)
    expect(direct).toContain(`data-doop-detached-from="${button.id}.`)
    expect(direct).toContain('Go 0')
    expect(deletedComponentsInUse(canvas)).toEqual([])
    const line = actions.getActivity(canvas.id).find((item) => item.message.startsWith('detached'))
    expect(line?.message).toContain('“Button”')
  })

  it('waits for a frame an agent is streaming into, without spinning, and detaches it when the stream closes', async () => {
    const { canvas, button, frames } = setup(4)
    await propagation.whenIdle()
    const agent = actions.resolveActor({ name: 'Streamer', kind: 'agent' })
    const streaming = frames[0]!
    actions.appendFrameHtml(
      streaming.id,
      '<!doctype html><html><head></head><body><doop-use component="Button" label="Streamed"></doop-use>',
      agent,
      { start: true },
    )
    expect(actions.isFrameMidStream(streaming.id)).toBe(true)
    expect(framed(streaming.id)).toContain(` ${INSTANCE_ATTR}="${button.id}"`)

    let visits = 0
    const immediate = globalThis.setImmediate
    vi.spyOn(globalThis, 'setImmediate').mockImplementation(((run: () => void) =>
      immediate(() => {
        visits += 1
        run()
      })) as typeof setImmediate)
    detachAllInstances(canvas.id, 'Button', actor)
    await propagation.whenIdle()

    /* everything else is done, the queue is empty, and the request is kept, not dropped */
    expect(framed(frames[2]!.id)).not.toContain(` ${INSTANCE_ATTR}="${button.id}"`)
    expect(framed(streaming.id)).toContain(` ${INSTANCE_ATTR}="${button.id}"`)
    expect(propagation.pendingFrames(canvas.id)).toBe(0)
    expect(propagation.deferredFrames()).toContain(streaming.id)
    const settled = visits
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(visits).toBeLessThanOrEqual(settled + 1)
    expect(visits).toBeLessThan(60)

    actions.appendFrameHtml(streaming.id, '<p>last</p></body></html>', agent, { done: true })
    await propagation.whenIdle()
    expect(framed(streaming.id)).not.toContain(` ${INSTANCE_ATTR}="${button.id}"`)
    expect(framed(streaming.id)).toContain(`data-doop-detached-from="${button.id}.`)
    expect(framed(streaming.id)).toContain('Streamed')
    expect(propagation.deferredFrames()).toEqual([])
    expect(deletedComponentsInUse(canvas)).toEqual([])
  })

  it('detaches a frame whose stream was abandoned, when the idle stream is closed', async () => {
    const { canvas, button, frames } = setup(2)
    await propagation.whenIdle()
    const agent = actions.resolveActor({ name: 'Streamer', kind: 'agent' })
    const streaming = frames[0]!
    actions.appendFrameHtml(
      streaming.id,
      '<!doctype html><html><head></head><body><doop-use component="Button" label="Left"></doop-use></body></html>',
      agent,
      { start: true },
    )
    detachAllInstances(canvas.id, 'Button', actor)
    await propagation.whenIdle()
    expect(framed(streaming.id)).toContain(` ${INSTANCE_ATTR}="${button.id}"`)

    await settleIdleStreams(Date.now() + 60 * 60_000)
    await propagation.whenIdle()
    expect(framed(streaming.id)).not.toContain(` ${INSTANCE_ATTR}="${button.id}"`)
    expect(framed(streaming.id)).toContain('Left')
    expect(propagation.deferredFrames()).toEqual([])
  })

  it('works on a component that is not deleted, which then has no instances', async () => {
    const { canvas, button, frames } = setup(2)
    await propagation.whenIdle()
    detachAllInstances(canvas.id, 'Button', actor)
    await propagation.whenIdle()
    expect(framed(frames[0]!.id)).not.toContain(` ${INSTANCE_ATTR}="${button.id}"`)
    expect(current(canvas.id, button.id).status ?? 'active').toBe('active')
    expect(catalog(canvas).find((entry) => entry.name === 'Button')!.instances).toBe(0)
  })
})

describe('agents', () => {
  type ToolResponse = { content: { type: string; text?: string }[]; isError?: boolean }

  async function connect() {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await buildMcpServer('Owner', OWNER).connect(serverSide)
    const client = new Client({ name: 'soft-delete-test', version: '0' })
    await client.connect(clientSide)
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = (await client.callTool({ name, arguments: { agent_name: 'Tester', ...args } })) as ToolResponse
      const text = response.content.map((block) => block.text ?? '').join('\n')
      // eslint-disable-next-line typescript/no-explicit-any
      let data: any
      try {
        data = JSON.parse(response.content[0]?.text ?? '')
      } catch {
        data = undefined
      }
      return { data, text, isError: !!response.isError }
    }
    return { client, call }
  }

  it('delete, see what is left, and restore over MCP', async () => {
    const { canvas, button, frames } = setup()
    await propagation.whenIdle()
    const before = allHtml(canvas.id)
    const { client, call } = await connect()

    const deleted = await call('delete_component', { canvas_id: canvas.id, component: 'Button' })
    expect(deleted.isError).toBe(false)
    expect(deleted.data).toMatchObject({ ok: true, deleted: 'Button', instances_kept: 7 })
    expect(deleted.text).toContain('restore_component')
    expect(allHtml(canvas.id)).toEqual(before)

    const listed = await call('get_canvas', { canvas_id: canvas.id })
    expect(listed.data.components.map((entry: { name: string }) => entry.name)).toEqual(['Card'])
    expect(listed.data.deletedComponents).toMatchObject([{ id: button.id, name: 'Button', instances: 7 }])

    const frame = await call('get_frame', { frame_id: frames[0]!.id })
    expect(frame.text).not.toContain('<doop-use component=\\"Button\\"')

    const used = await call('insert_instance', { canvas_id: canvas.id, frame_id: frames[0]!.id, component: 'Button' })
    expect(used.isError).toBe(true)
    expect(used.text).toMatch(/was deleted/)

    const restored = await call('restore_component', { canvas_id: canvas.id, component: 'Button' })
    expect(restored.isError).toBe(false)
    expect(restored.data.component.name).toBe('Button')
    const again = await call('get_canvas', { canvas_id: canvas.id })
    expect(again.data.components.map((entry: { name: string }) => entry.name).sort()).toEqual(['Button', 'Card'])
    expect(again.data.deletedComponents).toBeUndefined()
    expect(allHtml(canvas.id)).toEqual(before)
    await client.close()
  })

  it('detach everything on request over MCP, in the background', async () => {
    const { canvas, button, frames } = setup()
    await propagation.whenIdle()
    const { client, call } = await connect()
    const deleted = await call('delete_component', {
      canvas_id: canvas.id,
      component: 'Button',
      detach_instances: true,
    })
    expect(deleted.isError).toBe(false)
    expect(deleted.data.detach).toMatchObject({ queued: true, frames: 7 })
    await propagation.whenIdle()
    expect(framed(frames[0]!.id)).toContain(`data-doop-detached-from="${button.id}.`)
    await client.close()
  })

  it('gives the resident agent the same tools, with the same result', async () => {
    expect(RESIDENT_TOOL_NAMES).toContain('delete_component')
    expect(RESIDENT_TOOL_NAMES).toContain('restore_component')
    const { canvas, button } = setup()
    await propagation.whenIdle()
    const before = allHtml(canvas.id)
    const resident = actions.resolveActor({ name: roleName(DEFAULT_ROLE_ID), kind: 'agent' })
    const runState = newRunState()
    const call = (name: string, input: unknown) => ({ type: 'tool_use' as const, id: 't1', name, input })

    const deleted = await execTool(call('delete_component', { component: 'Button' }), canvas.id, resident, runState)
    expect(deleted.is_error).toBeUndefined()
    expect(String(deleted.content)).toContain('"instances_kept":7')
    expect(current(canvas.id, button.id).status).toBe('deleted')
    expect(allHtml(canvas.id)).toEqual(before)

    const restored = await execTool(call('restore_component', { component: 'Button' }), canvas.id, resident, runState)
    expect(restored.is_error).toBeUndefined()
    expect(current(canvas.id, button.id).status ?? 'active').toBe('active')
    expect(allHtml(canvas.id)).toEqual(before)
  })
})
