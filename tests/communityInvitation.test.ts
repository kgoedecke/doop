import { beforeEach, describe, expect, it } from 'vitest'
import type { Canvas, Frame } from '../shared/types'
import {
  canInviteToCommunity,
  claimCommunityInvitation,
  optOutOfCommunityInvitations,
} from '../src/lib/communityInvitation'

const frame: Frame = {
  id: 'frame',
  canvasId: 'canvas',
  name: 'Generated frame',
  x: 0,
  y: 0,
  width: 400,
  height: 300,
  html: '<h1>Sample</h1>',
  createdAt: 3,
  updatedAt: 3,
  updatedBy: 'Doop',
}
const canvas: Canvas = { id: 'canvas', name: 'Design', ownerId: 'owner', createdAt: 1, updatedAt: 3, frames: [frame] }
describe('community invitation eligibility', () => {
  it('requires a generated non-demo frame that still exists on the canvas', () => {
    expect(canInviteToCommunity(canvas, [frame.id], 'owner')).toBe(true)
    expect(canInviteToCommunity({ ...canvas, frames: [{ ...frame, demo: true }] }, [frame.id], 'owner')).toBe(false)
    expect(canInviteToCommunity(canvas, ['deleted-frame'], 'owner')).toBe(false)
    expect(canInviteToCommunity(canvas, [], 'owner')).toBe(false)
  })

  it('requires the owner of an unpublished canvas', () => {
    expect(canInviteToCommunity({ ...canvas, publishedAt: 4 }, [frame.id], 'owner')).toBe(false)
    expect(canInviteToCommunity(canvas, [frame.id], 'collaborator')).toBe(false)
  })
})

describe('community invitation preferences', () => {
  const week = 7 * 24 * 60 * 60 * 1000

  beforeEach(() => localStorage.clear())

  it('shares the seven-day cooldown across the account’s canvases and views', () => {
    expect(claimCommunityInvitation('owner', 1)).toBe(true)
    expect(claimCommunityInvitation('owner', week)).toBe(false)
    expect(claimCommunityInvitation('owner', week + 1)).toBe(true)
  })

  it('does not invite the opted-out account again or change anyone else’s preference', () => {
    optOutOfCommunityInvitations('owner')
    expect(claimCommunityInvitation('owner', 10 * week)).toBe(false)
    expect(claimCommunityInvitation('someone-else', 10 * week)).toBe(true)
  })
})
