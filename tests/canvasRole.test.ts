import { describe, expect, it, vi } from 'vitest'
import type { Canvas } from '../shared/types.ts'

/* The access matrix behind every canvas gate (REST, the WS room, MCP): who
 * reads, who comments, who edits. Workspace membership is stubbed so the
 * matrix needs no database. */
vi.mock('../server/workspaces.ts', () => ({
  isWorkspaceMember: (workspaceId: string, userId: string) => workspaceId === 'ws-1' && userId === 'teammate',
  hasRole: () => false,
}))

const { canAccessCanvas, canCommentCanvas, canEditCanvas, canvasRole, hasDurableCanvasAccess, roomMessageNeeds } =
  await import('../server/access.ts')
const { roleAllows, storedLinkAccess, toLinkAccess } = await import('../shared/canvasRole.ts')

function canvas(overrides: Partial<Canvas> = {}): Canvas {
  return {
    id: 'c1',
    name: 'Matrix',
    ownerId: 'owner',
    memberIds: ['member'],
    workspaceId: 'ws-1',
    createdAt: 0,
    updatedAt: 0,
    frames: [],
    ...overrides,
  }
}

describe('canvasRole', () => {
  it.each([
    [undefined, 'none'],
    ['none', 'none'],
    ['view', 'view'],
    ['comment', 'comment'],
    ['edit', 'edit'],
  ] as const)('a stranger on a %s link gets %s', (link, expected) => {
    const c = canvas({ linkAccess: link })
    expect(canvasRole('stranger', c)).toBe(expected === 'none' ? null : expected)
  })

  it.each(['owner', 'member', 'teammate'])('%s edits whatever the link says', (user) => {
    for (const link of [undefined, 'none', 'view', 'comment', 'edit'] as const) {
      expect(canvasRole(user, canvas({ linkAccess: link }))).toBe('edit')
    }
  })

  it('reads an unknown stored value as private', () => {
    const c = canvas({ linkAccess: 'admin' as unknown as Canvas['linkAccess'] })
    expect(canvasRole('stranger', c)).toBeNull()
  })

  it('gives signed-out callers nothing, even on an edit link', () => {
    expect(canvasRole(undefined, canvas({ linkAccess: 'edit' }))).toBeNull()
  })

  it('keeps ownerless legacy canvases open so they can be claimed', () => {
    expect(canvasRole(undefined, canvas({ ownerId: undefined }))).toBe('edit')
  })
})

describe('the read / comment / edit gates', () => {
  const table = [
    ['view', true, false, false],
    ['comment', true, true, false],
    ['edit', true, true, true],
    ['none', false, false, false],
  ] as const

  it.each(table)('a %s link: read %s, comment %s, edit %s', (link, read, comment, edit) => {
    const c = canvas({ linkAccess: link === 'none' ? undefined : link })
    expect(canAccessCanvas('stranger', c)).toBe(read)
    expect(canCommentCanvas('stranger', c)).toBe(comment)
    expect(canEditCanvas('stranger', c)).toBe(edit)
  })

  it('never counts a share link, at any level, as durable access', () => {
    for (const link of ['view', 'comment', 'edit'] as const) {
      expect(hasDurableCanvasAccess('stranger', canvas({ linkAccess: link }))).toBe(false)
    }
    expect(hasDurableCanvasAccess('teammate', canvas())).toBe(true)
  })
})

describe('room messages', () => {
  it('lets every reader share cursors and viewports but keeps frame edits to editors', () => {
    expect(roomMessageNeeds({ type: 'cursor', x: 1, y: 2 })).toBe('view')
    expect(roomMessageNeeds({ type: 'viewport', viewport: { x: 0, y: 0, zoom: 1, width: 1, height: 1 } })).toBe('view')
    expect(roomMessageNeeds({ type: 'editing', frameId: 'f1' })).toBe('edit')
    expect(roomMessageNeeds({ type: 'frame:drag', frameId: 'f1', x: 0, y: 0, width: 1, height: 1 })).toBe('edit')
  })

  it('treats a message type it does not know as an edit', () => {
    expect(roomMessageNeeds({ type: 'frame:delete' } as never)).toBe('edit')
  })
})

describe('link access values', () => {
  it('ranks roles view < comment < edit', () => {
    expect(roleAllows('edit', 'comment')).toBe(true)
    expect(roleAllows('comment', 'comment')).toBe(true)
    expect(roleAllows('comment', 'edit')).toBe(false)
    expect(roleAllows('view', 'comment')).toBe(false)
    expect(roleAllows(null, 'view')).toBe(false)
  })

  it('stores private as unset and reads legacy values back', () => {
    expect(storedLinkAccess('none')).toBeUndefined()
    expect(storedLinkAccess(null)).toBeUndefined()
    expect(storedLinkAccess('edit')).toBe('edit')
    expect(storedLinkAccess('view')).toBe('view')
    expect(toLinkAccess('bogus')).toBe('none')
  })
})
