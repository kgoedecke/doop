import { beforeAll, describe, expect, it, vi } from 'vitest'

/* the mirror reads one personal agent named like an outside agent ("Claude")
   at boot; nothing here writes */
vi.mock('../server/db/index.ts', async () => {
  const t = await import('../server/db/schema.ts')
  const row = {
    id: 'r1',
    scope: 'user:alice',
    handle: 'claude',
    name: 'Claude',
    color: '#DB2777',
    blurb: 'A personal agent',
    brief: 'You are Alice’s personal reviewer for every page she designs.',
    reviewer: false,
    createdBy: 'alice',
    createdAt: 1,
    updatedAt: 1,
  }
  return {
    db: {
      select: () => ({ from: (table: unknown) => Promise.resolve(table === t.customAgents ? [row] : []) }),
    },
  }
})

const { AgentInputError, hydrateCustomAgents, resetBuiltInAgent, updateBuiltInAgent } =
  await import('../server/customAgents.ts')

beforeAll(() => hydrateCustomAgents())

describe('built-in agent writes', () => {
  it('ask again whether the person may change the team once their turn comes', async () => {
    const refused = () => false
    await expect(
      updateBuiltInAgent({ workspaceId: 'ws1' }, 'mallory', 'ux', { disabled: true }, refused),
    ).rejects.toBeInstanceOf(AgentInputError)
    await expect(resetBuiltInAgent({ workspaceId: 'ws1' }, 'mallory', 'ux', refused)).rejects.toBeInstanceOf(
      AgentInputError,
    )
  })
})
