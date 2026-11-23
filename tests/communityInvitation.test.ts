import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentTask, Canvas, Frame } from '../shared/types'
import {
  canInviteToCommunity,
  claimCommunityInvitation,
  isNewTaskCompletion,
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
const started: AgentTask = {
  id: 'task',
  agentName: 'Doop',
  color: '#000000',
  status: 'Generate a frame',
  startedAt: 2,
  queuedBy: 'Owner',
  queuedByUserId: 'owner',
  frameIds: [frame.id],
}
const completed = { ...started, endedAt: 4 }

describe('community invitation eligibility', () => {
  it('requires a live transition into successful completion', () => {
    expect(isNewTaskCompletion(completed, started)).toBe(true)
    expect(isNewTaskCompletion(completed, completed)).toBe(false)
    expect(isNewTaskCompletion(completed, undefined)).toBe(false)
    expect(isNewTaskCompletion({ ...started, failedAt: 4 }, started)).toBe(false)
    expect(isNewTaskCompletion({ ...completed, failedAt: 4 }, started)).toBe(false)
  })

  it('requires an unpublished canvas and a new non-demo frame from the owner’s request', () => {
    expect(canInviteToCommunity(canvas, completed, 'owner')).toBe(true)
    expect(canInviteToCommunity({ ...canvas, publishedAt: 4 }, completed, 'owner')).toBe(false)
    expect(canInviteToCommunity({ ...canvas, frames: [{ ...frame, demo: true }] }, completed, 'owner')).toBe(false)
    expect(canInviteToCommunity(canvas, { ...completed, startedAt: 4 }, 'owner')).toBe(false)
    expect(canInviteToCommunity(canvas, { ...completed, frameIds: [] }, 'owner')).toBe(false)
    expect(canInviteToCommunity(canvas, { ...completed, queuedByUserId: 'collaborator' }, 'owner')).toBe(false)
    expect(canInviteToCommunity(canvas, completed, 'collaborator')).toBe(false)
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
