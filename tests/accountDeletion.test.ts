import { beforeEach, expect, it, vi } from 'vitest'

const rig = vi.hoisted(() => ({
  deleted: [] as string[],
  workspaces: new Map<string, Set<string>>(),
  dbDeletes: 0,
}))
vi.mock('../server/db/persist.ts', () => {
  const noop = () => undefined
  return {
    deleteCanvas: noop,
    deleteFrame: noop,
    deleteGuideline: noop,
    deleteToken: noop,
    deleteMember: noop,
    deleteReference: noop,
    saveCanvas: noop,
    saveCanvasCopy: noop,
    saveFrame: noop,
    saveGuideline: noop,
    saveToken: noop,
    saveMember: noop,
    saveReference: noop,
  }
})
vi.mock('../server/db/index.ts', () => ({
  db: {
    delete: () => ({
      where: async () => {
        rig.dbDeletes += 1
      },
    }),
  },
}))
vi.mock('../server/workspaces.ts', () => ({
  workspaceIdsFor: (userId: string) => [...rig.workspaces].filter(([, m]) => m.has(userId)).map(([id]) => id),
  removeMember: (workspaceId: string, userId: string) => rig.workspaces.get(workspaceId)?.delete(userId) ?? false,
}))
vi.mock('../server/slack/jobs.ts', () => ({ disconnectAgent: vi.fn() }))
vi.mock('../server/linear/jobs.ts', () => ({ disconnectAgent: vi.fn() }))
import { store } from '../server/store.ts'
import { purgeUserData } from '../server/accountDeletion.ts'
import { disconnectAgent as disconnectSlack } from '../server/slack/jobs.ts'
import { disconnectAgent as disconnectLinear } from '../server/linear/jobs.ts'

beforeEach(() => {
  for (const canvas of store.allCanvases()) store.deleteCanvas(canvas.id)
  rig.workspaces.clear()
  rig.dbDeletes = 0
  vi.clearAllMocks()
})

it('deletes only the canvases nobody else can reach, and leaves the rest', async () => {
  const mine = store.createCanvas('Private board', 'alice')
  const shared = store.createCanvas('Shared board', 'alice')
  store.addMember(shared.id, 'bob', 'alice')
  const inWorkspace = store.createCanvas('Team board', 'alice', 'ws1')
  const theirs = store.createCanvas("Bob's board", 'bob')
  store.addMember(theirs.id, 'alice', 'bob')
  rig.workspaces.set('ws1', new Set(['alice', 'bob']))

  const result = await purgeUserData('alice')

  expect(result.deletedCanvases).toBe(1)
  expect(store.getCanvas(mine.id)).toBeUndefined()
  expect(store.getCanvas(shared.id)).toBeDefined()
  expect(store.getCanvas(inWorkspace.id)).toBeDefined()
  expect(store.getCanvas(theirs.id)?.memberIds ?? []).not.toContain('alice')
  expect(rig.workspaces.get('ws1')?.has('alice')).toBe(false)
  expect(rig.workspaces.get('ws1')?.has('bob')).toBe(true)
  expect(rig.dbDeletes).toBe(4) // Slack and Linear OAuth handoffs, live activity update tokens, push-to-start tokens
})

it('disconnects the Slack and Linear agents, so no installation outlives its installer', async () => {
  await purgeUserData('alice')
  expect(disconnectSlack).toHaveBeenCalledWith('alice')
  expect(disconnectLinear).toHaveBeenCalledWith('alice')
})
