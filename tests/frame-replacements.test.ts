import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { expect, it, vi } from 'vitest'
import { frameActor } from '../server/frame-sync.ts'

vi.mock('../server/db/persist.ts', () => ({
  loadLegacyFrameIds: async () => [],
  legacyFrameCanvasId: async () => undefined,
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  saveCanvas: () => {},
}))
const { store } = await import('../server/store.ts')
const { buildMcpServer } = await import('../server/mcp.ts')
const by = { name: 'Agent', kind: 'agent' as const, color: '#123456' }

it('serializes replacements inside the frame actor, including conflicting edits', async () => {
  const canvas = store.createCanvas('Replacements', 'owner')
  const frame = (await store.createFrame(canvas.id, { name: 'Hero', html: '<p>Alpha Beta</p>' }, 'Owner'))!
  const actor = frameActor(frame.id)
  await Promise.all([
    actor.write({ type: 'replace', find: 'Alpha', replacement: 'First' }, by),
    actor.write({ type: 'replace', find: 'Beta', replacement: 'Second' }, by),
  ])
  expect((await actor.snapshot()).frame?.html).toBe('<p>First Second</p>')
  const competing = await Promise.allSettled([
    actor.write({ type: 'replace', find: 'First', replacement: 'One' }, by),
    actor.write({ type: 'replace', find: 'First', replacement: 'Two' }, by),
  ])
  expect(competing.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  expect(competing.filter((result) => result.status === 'rejected')).toHaveLength(1)
  await actor.write({ type: 'update', patch: { html: '<p>duplicate duplicate</p>' } }, by)
  const unchanged = await actor.snapshot()
  await expect(actor.write({ type: 'replace', find: 'duplicate', replacement: 'single' }, by)).rejects.toThrow(
    'more than once',
  )
  expect(await actor.snapshot()).toEqual(unchanged)
})

it('keeps both MCP edits even when both authorization reads saw the old HTML', async () => {
  const canvas = store.createCanvas('MCP replacements', 'owner')
  const frame = (await store.createFrame(canvas.id, { name: 'Hero', html: '<p>Alpha Beta</p>' }, 'Owner'))!
  const server = buildMcpServer('Owner', 'owner')
  const client = new Client({ name: 'replacement-test', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  const read = store.getFrame.bind(store)
  let reads = 0,
    release!: () => void
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const spy = vi.spyOn(store, 'getFrame').mockImplementation(async (id) => {
    const value = await read(id)
    if (id === frame.id && reads < 2) {
      if (++reads === 2) release()
      await barrier
    }
    return value
  })
  try {
    const results = await Promise.all([
      client.callTool({
        name: 'edit_frame_html',
        arguments: { frame_id: frame.id, old_str: 'Alpha', new_str: 'First', agent_name: 'Agent' },
      }),
      client.callTool({
        name: 'edit_frame_html',
        arguments: { frame_id: frame.id, old_str: 'Beta', new_str: 'Second', agent_name: 'Agent' },
      }),
    ])
    expect(results.every((result) => !result.isError)).toBe(true)
    expect((await read(frame.id))?.html).toBe('<p>First Second</p>')
  } finally {
    spy.mockRestore()
    await client.close()
    await server.close()
  }
})
