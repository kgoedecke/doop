import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'
import { DOOP_GUIDE, GUIDE_TOPICS, guideFor } from '../server/guide.ts'
import { buildMcpServer, INSTRUCTIONS } from '../server/mcp.ts'

vi.mock('../server/db/persist.ts', () => ({ saveCanvas: () => {}, saveFrame: () => {}, saveActivity: () => {} }))

/* Clients cut what a server says in its handshake: Claude Code at 4,096 characters
   (2,048 in older versions), and ChatGPT reads the first 512 most. What does not fit was
   never read, so the instructions keep to the oldest cut and the rest lives in get_guide:
   a main guide every agent loads, and topics loaded when a task needs one. */

const OLDEST_CLAUDE_CODE_CUT = 2048
const MAIN_GUIDE_BUDGET = 30_000

async function connect() {
  const client = new Client({ name: 'instructions-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await buildMcpServer('Owner', 'owner').connect(b)
  await client.connect(a)
  return client
}

describe('server instructions', () => {
  it('fit the oldest Claude Code cut, as the handshake sends them', async () => {
    const client = await connect()
    const sent = client.getInstructions() ?? ''
    await client.close()
    expect(sent).toBe(INSTRUCTIONS)
    expect(sent.length).toBeLessThanOrEqual(OLDEST_CLAUDE_CODE_CUT)
  })

  it('say to load the guide within the first 512 characters', () => {
    expect(INSTRUCTIONS.slice(0, 512)).toContain('get_guide({ topic: "doop-instructions" })')
  })
})

describe('get_guide', () => {
  it('keeps the main guide within its budget and points at every other topic', () => {
    expect(DOOP_GUIDE.length).toBeLessThanOrEqual(MAIN_GUIDE_BUDGET)
    for (const topic of GUIDE_TOPICS.filter((t) => t !== 'doop-instructions')) {
      expect(DOOP_GUIDE).toContain(`**${topic}**`)
    }
  })

  it('serves every topic, and its description names them', async () => {
    const client = await connect()
    const { tools } = await client.listTools()
    const description = tools.find((tool) => tool.name === 'get_guide')?.description ?? ''
    for (const topic of GUIDE_TOPICS) {
      expect(description).toContain(`"${topic}"`)
      const result = (await client.callTool({ name: 'get_guide', arguments: { topic } })) as {
        content: { text: string }[]
      }
      expect(result.content[0]!.text.startsWith(guideFor(topic))).toBe(true)
    }
    await client.close()
  })

  it('adds the server’s integrations to the main guide only', () => {
    const lines = ['- Linear: list_linear_issues discovers open tickets.']
    expect(guideFor('doop-instructions', lines)).toContain('## Integrations on this server')
    expect(guideFor('doop-instructions', lines)).toContain(lines[0])
    expect(guideFor('images', lines)).not.toContain(lines[0])
  })
})
