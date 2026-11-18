import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* fit_height (#532): a frame's height set to its content's, measured in the
   server's Chromium. Writes persist and broadcast like any canvas change;
   only the frame left behind matters here, so both are stubbed. */
vi.mock('../server/db/persist.ts', () => ({
  saveFrame: () => {},
  saveFrameNow: async () => {},
  saveCanvas: () => {},
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
}))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { buildMcpServer } = await import('../server/mcp.ts')
const { execTool } = await import('../server/resident.ts')
const { findBrowserPath } = await import('../server/screenshot.ts')
const { FIT_HEIGHT_MAX } = await import('../server/frameFit.ts')
const { DEFAULT_ROLE_ID, roleName } = await import('../shared/agents.ts')

const OWNER = 'fit-owner'
const doc = (body: string, bodyStyle = 'margin:0') =>
  `<!doctype html><html><head></head><body style="${bodyStyle}">${body}</body></html>`
const block = (height: number, style = '') => `<div style="height:${height}px;${style}"></div>`

let canvasId: string
let client: Client
let closeClient: () => Promise<void>

beforeEach(async () => {
  actions.wire(
    () => {},
    () => {},
  )
  canvasId = store.createCanvas('fit', OWNER).id
  const server = buildMcpServer('Fit Owner', OWNER)
  client = new Client({ name: 'fit-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  await client.connect(a)
  closeClient = async () => {
    await client.close()
    await server.close()
  }
})

afterEach(async () => {
  await closeClient()
})

const agent = () => actions.resolveActor({ name: 'Fitter', kind: 'agent' })

function frameWith(html: string, size: { width?: number; height?: number } = {}) {
  return actions.createFrame(canvasId, { name: 'Fit', html, width: 400, height: 300, ...size }, agent())!
}

interface CallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

async function callTool(name: string, args: Record<string, unknown>): Promise<CallResult> {
  return (await client.callTool({ name, arguments: { agent_name: 'Fitter', ...args } })) as unknown as CallResult
}

const texts = (result: CallResult) => result.content.map((part) => part.text ?? '').join('\n')

describe('fit_height refusals', () => {
  it('refuses height and fit_height together on update_frame and create_frame', async () => {
    const frame = frameWith(doc(block(500)))
    const update = await callTool('update_frame', { frame_id: frame.id, height: 200, fit_height: true })
    expect(update.isError).toBe(true)
    expect(texts(update)).toContain('either height or fit_height')
    expect(frame.height).toBe(300)
    const create = await callTool('create_frame', {
      canvas_id: canvasId,
      name: 'Both',
      html: doc(block(500)),
      height: 200,
      fit_height: true,
    })
    expect(create.isError).toBe(true)
  })

  it('refuses a create with no design to measure, before making the frame', async () => {
    const before = store.getCanvas(canvasId)!.frames.length
    const result = await callTool('create_frame', { canvas_id: canvasId, name: 'Empty', html: '', fit_height: true })
    expect(result.isError).toBe(true)
    expect(texts(result)).toContain('update_frame with fit_height')
    expect(store.getCanvas(canvasId)!.frames.length).toBe(before)
  })
})

describe.skipIf(!findBrowserPath())('fit_height in a browser', () => {
  it('grows a frame whose content is cut off', async () => {
    const frame = frameWith(doc(block(700) + block(584)))
    const result = await callTool('update_frame', { frame_id: frame.id, fit_height: true })
    expect(result.isError).toBeFalsy()
    expect(frame.height).toBe(1284)
    expect(texts(result)).toContain('now 1284px tall')
  }, 60_000)

  it('shrinks a frame whose body holds it at the viewport height', async () => {
    const frame = frameWith(doc(block(240), 'margin:0;min-height:100vh'), { height: 900 })
    await callTool('update_frame', { frame_id: frame.id, fit_height: true })
    expect(frame.height).toBe(240)
    const full = frameWith(doc(block(180), 'margin:0;height:100%'), { height: 900 })
    await callTool('update_frame', { frame_id: full.id, fit_height: true })
    expect(full.height).toBe(180)
  }, 60_000)

  it('counts body margins, positioned layers and overflow, but not fixed bars or what a clipper hides', async () => {
    const frame = frameWith(
      doc(
        block(100) +
          '<div style="position:absolute;top:400px;width:10px;height:50px"></div>' +
          '<div style="position:fixed;bottom:0;height:40px;width:100%"></div>' +
          `<div style="height:60px;overflow:hidden">${block(2000)}</div>`,
        'margin:20px',
      ),
    )
    await callTool('update_frame', { frame_id: frame.id, fit_height: true })
    /* the absolute layer ends at 400 + 50 from the root, past the 20+100+60+20 of flow */
    expect(frame.height).toBe(450)
  }, 60_000)

  it('measures at the new width when the same call changes it', async () => {
    const frame = frameWith(doc('<div style="width:100%;aspect-ratio:2/1"></div>'))
    await callTool('update_frame', { frame_id: frame.id, width: 800, fit_height: true })
    expect(frame).toMatchObject({ width: 800, height: 400 })
  }, 60_000)

  it('fits the frame after create_frame and set_frame_html write it', async () => {
    const created = await callTool('create_frame', {
      canvas_id: canvasId,
      name: 'Created',
      html: doc(block(333)),
      fit_height: true,
    })
    expect(created.isError).toBeFalsy()
    const { frame } = JSON.parse(created.content[0]!.text!) as { frame: { id: string; height: number } }
    expect(frame.height).toBe(333)
    expect(texts(created)).toContain('now 333px tall')

    const set = await callTool('set_frame_html', { frame_id: frame.id, html: doc(block(512)), fit_height: true })
    expect(set.isError).toBeFalsy()
    expect(store.getFrame(frame.id)!.height).toBe(512)
  }, 60_000)

  it('stops at the export limit and says how tall the content is', async () => {
    const frame = frameWith(doc(block(FIT_HEIGHT_MAX + 1000)))
    const result = await callTool('update_frame', { frame_id: frame.id, fit_height: true })
    expect(frame.height).toBe(FIT_HEIGHT_MAX)
    expect(texts(result)).toContain(`${FIT_HEIGHT_MAX + 1000}px tall`)
  }, 60_000)

  it('fits from the resident agent’s update_frame too', async () => {
    const frame = frameWith(doc(block(640)))
    const resident = actions.resolveActor({ name: roleName(DEFAULT_ROLE_ID), kind: 'agent' })
    const result = await execTool(
      { type: 'tool_use', id: 't1', name: 'update_frame', input: { frame_id: frame.id, fit_height: true } },
      canvasId,
      resident,
      {
        mutatedFrames: new Set<string>(),
        sourceFrames: new Set<string>(),
        verificationFrames: new Set<string>(),
        verifiedFrames: new Set<string>(),
        seenVerified: new Set<string>(),
        rewriteDrafts: new Map<string, string>(),
        vision: false,
        imagesGenerated: 0,
        repliedThreads: new Set<string>(),
        awaitingThreads: new Set<string>(),
        tokenWrites: 0,
        arrangeWrites: 0,
      },
    )
    expect(result.is_error).toBeUndefined()
    expect(frame.height).toBe(640)
    expect(String(result.content)).toContain('now 640px tall')
  }, 60_000)
})
