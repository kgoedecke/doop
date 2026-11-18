import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  refreshAssetRefs: () => {},
  saveFrame: () => {},
  saveActivity: () => {},
  saveFrameVersion: () => {},
  saveTask: () => {},
  saveComponent: () => {},
  deleteComponent: () => {},
}))

import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import * as actions from '../server/actions.ts'
import * as propagation from '../server/propagation.ts'
import { blankComponent } from '../server/components.ts'
import { updateComponent } from '../server/componentActions.ts'
import { parse, runOperation, usage, WorkBudgetError } from '../server/workBudget.ts'
import { COMPONENT_ATTR } from '../shared/components.ts'
import type { Actor } from '../shared/types.ts'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

const OWNER = 'owner-budget'
const actor = { name: 'Tester', kind: 'user', color: '#000', clientId: 'x' } as unknown as Actor

const doc = (body: string, css = '') =>
  `<!doctype html><html><head><style>${css}</style></head><body>${body}</body></html>`

const framed = (id: string) => store.getFrame(id)!.html
/* markup the engine has to read but that changes nothing: what makes a frame expensive */
const filler = (bytes: number) => `<p>${'lorem ipsum '.repeat(Math.ceil(bytes / 12))}</p>`

function setup(pages = 2) {
  const canvas = store.createCanvas('budget test', OWNER)
  const def = blankComponent({ name: 'Button', by: 'Tester' })
  store.saveComponent(canvas.id, def)
  const mainFrame = actions.createFrame(canvas.id, { name: 'Main', html: '' }, actor)!
  actions.updateFrame(
    mainFrame.id,
    {
      html: doc(
        `<button class="btn" ${COMPONENT_ATTR}="${def.id}"><span data-doop-prop="label">Buy</span></button>`,
        '.btn { padding: 8px }',
      ),
    },
    actor,
  )
  const frames = Array.from({ length: pages }, (_, index) => {
    const frame = actions.createFrame(canvas.id, { name: `Page ${index}`, html: '' }, actor)!
    actions.updateFrame(frame.id, { html: doc(`<doop-use component="Button" label="Go ${index}"></doop-use>`) }, actor)
    return frame
  })
  return { canvas, def, mainFrame, frames }
}

const snapshot = (canvasId: string) => ({
  frames: store.getCanvas(canvasId)!.frames.map((frame) => [frame.id, frame.html, frame.updatedAt]),
  components: [...store.getComponents(canvasId)],
})

afterEach(async () => {
  vi.restoreAllMocks()
  unstubAllEnvs()
  await propagation.whenIdle()
})

describe('the work budget', () => {
  it('leaves a normal edit alone, and far below the limit', async () => {
    const { mainFrame, frames } = setup()
    const spent = runOperation('PATCH /api/frames/main', undefined, () => {
      actions.updateFrame(mainFrame.id, { html: framed(mainFrame.id).replace('class="btn"', 'class="btn big"') }, actor)
      return usage()
    })
    /* a small frame costs a few of its own size to prepare: kilobytes against a 96 MB limit */
    expect(spent.parsedBytes).toBeGreaterThan(0)
    expect(spent.parsedBytes).toBeLessThan(64 * 1024)
    await propagation.whenIdle()
    expect(framed(frames[0]!.id)).toContain('btn big')
  })

  it('charges each operation on its own, and work outside one is never refused', () => {
    stubEnv('DOOP_WORK_BUDGET_PARSE_MB', '1')
    const big = doc(filler(700 * 1024))
    const once = () => runOperation('one', undefined, () => parse(big) && usage().parsedBytes)
    expect(once()).toBe(big.length)
    expect(once()).toBe(big.length)
    expect(() => runOperation('twice', undefined, () => [parse(big), parse(big)])).toThrow(WorkBudgetError)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => [parse(big), parse(big)]).not.toThrow()
    expect(logged).toHaveBeenCalledTimes(1)
  })

  it('refuses a request that goes over, naming it and its canvas, and writes nothing', () => {
    const { canvas, def, mainFrame } = setup()
    stubEnv('DOOP_WORK_BUDGET_PARSE_MB', '1')
    const before = snapshot(canvas.id)
    const saves = vi.spyOn(store, 'saveComponent')
    const frameWrites = vi.spyOn(store, 'updateFrame')
    /* a changed main in a frame big enough that preparing it parses more than the limit */
    const html = framed(mainFrame.id)
      .replace('class="btn"', 'class="btn big"')
      .replace('</body>', `${filler(300 * 1024)}</body>`)

    let refusal: unknown
    try {
      runOperation('PATCH /api/frames/main', undefined, () => actions.updateFrame(mainFrame.id, { html }, actor))
    } catch (error) {
      refusal = error
    }
    expect(refusal).toBeInstanceOf(WorkBudgetError)
    const error = refusal as WorkBudgetError
    expect(error.operation).toBe('PATCH /api/frames/main')
    expect(error.canvasId).toBe(canvas.id)
    expect(error.message).toContain('PATCH /api/frames/main')
    expect(error.message).toContain(canvas.id)
    expect(error.message).toContain('Nothing was changed')

    /* the main had been folded into its definition before the budget ran out: that is undone */
    expect(saves.mock.calls.length).toBeGreaterThan(0)
    expect(frameWrites).not.toHaveBeenCalled()
    expect(snapshot(canvas.id)).toEqual(before)
    expect(store.getComponents(canvas.id).find((d) => d.id === def.id)).toBe(before.components[0])
    expect(propagation.pendingFrames(canvas.id)).toBe(0)
  })

  it('puts a component back when its update ran out part of the way', () => {
    const { canvas, mainFrame } = setup()
    actions.updateFrame(
      mainFrame.id,
      { html: framed(mainFrame.id).replace('</body>', `${filler(400 * 1024)}</body>`) },
      actor,
    )
    const before = snapshot(canvas.id)
    stubEnv('DOOP_WORK_BUDGET_PARSE_MB', '1')
    expect(() =>
      runOperation('mcp update_component', canvas.id, () =>
        updateComponent(
          canvas.id,
          'Button',
          { name: 'Renamed', props: [{ name: 'tone', type: 'enum', options: ['a', 'b'] }] },
          actor,
        ),
      ),
    ).toThrow(WorkBudgetError)
    expect(snapshot(canvas.id)).toEqual(before)
  })

  it('skips a frame over budget in the queue, leaves it as it was and carries on', async () => {
    const { mainFrame, frames } = setup(3)
    const heavy = frames[1]!
    actions.updateFrame(heavy.id, { html: framed(heavy.id).replace('</body>', `${filler(600 * 1024)}</body>`) }, actor)
    await propagation.whenIdle()
    const before = framed(heavy.id)
    actions.updateFrame(mainFrame.id, { html: framed(mainFrame.id).replace('class="btn"', 'class="btn big"') }, actor)
    stubEnv('DOOP_WORK_BUDGET_PARSE_MB', '1')
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    await propagation.whenIdle()
    expect(framed(heavy.id)).toBe(before)
    expect(framed(frames[0]!.id)).toContain('btn big')
    expect(framed(frames[2]!.id)).toContain('btn big')
    expect(logged.mock.calls.some(([line]) => String(line).includes(`frame ${heavy.id} skipped`))).toBe(true)
  })

  it('reaches an agent as a tool error it can act on', async () => {
    const { canvas, mainFrame } = setup()
    const before = snapshot(canvas.id)
    stubEnv('DOOP_WORK_BUDGET_PARSE_MB', '1')
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await buildMcpServer('Owner', OWNER).connect(serverSide)
    const client = new Client({ name: 'budget-test', version: '0' })
    await client.connect(clientSide)
    const html = framed(mainFrame.id)
      .replace('class="btn"', 'class="btn big"')
      .replace('</body>', `${filler(400 * 1024)}</body>`)

    const response = (await client.callTool({
      name: 'set_frame_html',
      arguments: { frame_id: mainFrame.id, html, agent_name: 'Tester' },
    })) as { content: { text?: string }[]; isError?: boolean }
    expect(response.isError).toBe(true)
    const text = response.content.map((block) => block.text ?? '').join('\n')
    expect(text).toContain('mcp set_frame_html')
    expect(text).toContain(canvas.id)
    expect(snapshot(canvas.id)).toEqual(before)
    await client.close()
  })
})
