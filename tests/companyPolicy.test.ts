import { describe, expect, it } from 'vitest'
import { CompanyPolicy, CompanyPolicyError } from '../server/companyPolicy.ts'
import type { Canvas } from '../shared/types.ts'

const configured = JSON.stringify([{ workspaceId: 'space_a', botUserId: 'bot_a' }])
const policy = () => new CompanyPolicy(configured)
const canvas = (patch: Partial<Canvas> = {}): Canvas => ({
  id: 'canvas_a',
  name: 'Synthetic',
  ownerId: 'bot_a',
  workspaceId: 'space_a',
  frames: [],
  createdAt: 1,
  updatedAt: 1,
  ...patch,
})
const setup = () => ({
  users: [{ id: 'bot_a', role: null as string | null }],
  workspaces: [{ id: 'space_a', ownerId: 'human_a' }],
  memberships: [{ workspaceId: 'space_a', userId: 'bot_a', role: 'member' }],
  canvases: [canvas()],
})

describe('company policy configuration and setup', () => {
  it.each([
    'null',
    '{}',
    'oops',
    '[{}]',
    '[{"workspaceId":"x","botUserId":"b","unknown":true}]',
    '[{"workspaceId":"../foreign","botUserId":"b"}]',
    ' '.repeat(65537),
  ])('rejects malformed or unbounded configuration', (value) => {
    expect(() => new CompanyPolicy(value)).toThrow(CompanyPolicyError)
  })

  it('rejects duplicate bot/workspace assignments and excessive entries', () => {
    const entry = { workspaceId: 'space_a', botUserId: 'bot_a' }
    expect(() => new CompanyPolicy(JSON.stringify([entry, { ...entry, workspaceId: 'space_b' }]))).toThrow()
    expect(() => new CompanyPolicy(JSON.stringify([entry, { ...entry, botUserId: 'bot_b' }]))).toThrow()
    expect(
      () =>
        new CompanyPolicy(
          JSON.stringify(Array.from({ length: 129 }, (_, i) => ({ workspaceId: 's' + i, botUserId: 'b' + i }))),
        ),
    ).toThrow()
  })

  it('validates ready setup and preserves deliberate membership revocation', () => {
    const facts = setup()
    expect(() => policy().validate(facts)).not.toThrow()
    facts.memberships = []
    expect(() => policy().validate(facts)).not.toThrow()
  })

  it('rejects missing/admin users and bot-owned workspaces', () => {
    const facts = setup()
    expect(() => policy().validate({ ...facts, users: [] })).toThrow()
    expect(() => policy().validate({ ...facts, workspaces: [] })).toThrow()
    expect(() => policy().validate({ ...facts, users: [{ id: 'bot_a', role: 'admin' }] })).toThrow()
    expect(() => policy().validate({ ...facts, workspaces: [{ id: 'space_a', ownerId: 'bot_a' }] })).toThrow()
  })

  it('rejects foreign membership, promotion, ownership and direct invitations', () => {
    const facts = setup()
    expect(() =>
      policy().validate({ ...facts, memberships: [{ workspaceId: 'space_b', userId: 'bot_a', role: 'member' }] }),
    ).toThrow()
    expect(() =>
      policy().validate({ ...facts, memberships: [{ workspaceId: 'space_a', userId: 'bot_a', role: 'admin' }] }),
    ).toThrow()
    expect(() => policy().validate({ ...facts, canvases: [canvas({ workspaceId: undefined })] })).toThrow()
    expect(() =>
      policy().validate({
        ...facts,
        canvases: [canvas({ ownerId: 'human_b', workspaceId: 'space_b', memberIds: ['bot_a'] })],
      }),
    ).toThrow()
  })

  it('rejects preexisting shared/published company canvases without repairing data', () => {
    const facts = setup()
    const shared = canvas({ linkAccess: 'view' })
    expect(() => policy().validate({ ...facts, canvases: [shared] })).toThrow()
    expect(shared.linkAccess).toBe('view')
    expect(() => policy().validate({ ...facts, canvases: [canvas({ publishedAt: 1 })] })).toThrow()
  })
})

describe('company policy ongoing mutations', () => {
  it('constrains all managed creation/adoption destinations and workspace ownership', () => {
    const p = policy()
    expect(() => p.assertCreation('bot_a', 'space_a')).not.toThrow()
    for (const destination of [undefined, 'space_b']) expect(() => p.assertCreation('bot_a', destination)).toThrow()
    expect(() => p.assertWorkspaceOwner('bot_a')).toThrow()
    expect(() => p.assertCreation('human_a', undefined)).not.toThrow()
  })

  it('denies public features and cross-workspace detachment even to the owner', () => {
    const p = policy()
    expect(() => p.assertPublicFeature('space_a')).toThrow()
    expect(() => p.assertMove(canvas(), undefined)).toThrow()
    expect(() => p.assertMove(canvas({ ownerId: 'human_a' }), 'space_b')).toThrow()
    expect(() => p.assertMove(canvas(), 'space_a')).not.toThrow()
    expect(() => p.assertPublicFeature(undefined)).not.toThrow()
  })

  it('does not adopt public content into a private workspace', () => {
    expect(() =>
      policy().assertMove(canvas({ ownerId: 'human_a', workspaceId: undefined, linkAccess: 'view' }), 'space_a'),
    ).toThrow()
    expect(() =>
      policy().assertMove(canvas({ ownerId: 'human_a', workspaceId: undefined, publishedAt: 1 }), 'space_a'),
    ).toThrow()
  })

  it('binds invitations and roles and requires current membership for private listing', () => {
    const p = policy()
    expect(p.allowsMembership('space_a', 'bot_a', 'member')).toBe(true)
    expect(p.allowsMembership('space_b', 'bot_a', 'member')).toBe(false)
    expect(p.allowsMembership('space_a', 'bot_a', 'admin')).toBe(false)
    expect(() => p.assertInvite(canvas({ ownerId: 'human_b', workspaceId: 'space_b' }), 'bot_a')).toThrow()
    expect(p.allowsListing('bot_a', canvas(), ['space_a'])).toBe(true)
    expect(p.allowsListing('bot_a', canvas(), [])).toBe(false)
    expect(p.allowsListing('human_a', canvas({ ownerId: 'human_a' }), [])).toBe(false)
    expect(p.allowsListing('bot_a', canvas({ ownerId: undefined, workspaceId: undefined }), [])).toBe(false)
  })
})
