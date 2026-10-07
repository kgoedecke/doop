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
    deleteMember: noop,
    deleteReference: noop,
    saveCanvas: noop,
    saveCanvasCopy: noop,
    saveFrame: noop,
    saveGuideline: noop,
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
import { store } from '../server/store.ts'
import { purgeUserData } from '../server/accountDeletion.ts'

beforeEach(() => {
  for (const canvas of store.allCanvases()) store.deleteCanvas(canvas.id)
  rig.workspaces.clear()
  rig.dbDeletes = 0
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
  expect(rig.dbDeletes).toBe(2) // live activity update tokens and push-to-start tokens
})
