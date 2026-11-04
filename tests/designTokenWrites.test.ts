import { describe, expect, it, vi } from 'vitest'
import type { Actor } from '../shared/types'
import { TOKEN_BLOCK_ATTR } from '../shared/designTokens'

/* Frame writes mirror into Postgres and broadcast; only the saved HTML and
   what the room is sent matter here. */
vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  saveCanvas: () => {},
  saveFrame: () => {},
  saveToken: () => {},
  deleteToken: () => {},
  saveCanvasCopy: async () => {},
  saveFrameVersion: () => {},
}))
vi.mock('../server/fonts.ts', () => ({ fontsForCanvas: () => [] }))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')

/**
 * Design tokens on frame writes: a write that names a token gets its value
 * in the managed block; a token change restyles every frame naming it as an
 * annotation (sign-off stands, viewers are sent the new document); a rename
 * follows into frames and aliases; a delete is refused while aliased.
 */

const agent: Actor = { name: 'Claude', kind: 'agent', color: '#e5533c' }
const human: Actor = { name: 'Kevin', kind: 'user', color: '#2743ee' }

const sent: { type: string; frameId?: string; html?: string }[] = []
actions.wire(
  (_canvasId, msg) => {
    if (msg.type === 'frame:updated') sent.push({ type: msg.type, frameId: msg.frame.id, html: msg.frame.html })
    else sent.push({ type: msg.type })
  },
  () => {},
)

function setup() {
  const canvasId = store.createCanvas('tokens', 'kevin').id
  const results = actions.createTokens(
    canvasId,
    [
      { name: '--color-ink', type: 'color', value: '#111' },
      { name: '--color-primary', type: 'color', value: 'var(--color-ink)' },
      { name: '--spacing-4', type: 'spacing', value: '16px' },
    ],
    human,
  )!
  expect(results.every((r) => r.result === 'created')).toBe(true)
  return canvasId
}

describe('design tokens on frame writes', () => {
  it('writes the block on create and keeps it current on update', () => {
    const canvasId = setup()
    const frame = actions.createFrame(
      canvasId,
      { name: 'Hero', html: '<html><head></head><body style="color:var(--color-primary)"></body></html>' },
      agent,
    )!
    expect(store.getFrame(frame.id)!.html).toContain(':root{--color-ink:#111;--color-primary:var(--color-ink)}')
    actions.updateFrame(
      frame.id,
      { html: '<html><head></head><body style="gap:var(--spacing-4)"></body></html>' },
      agent,
    )
    expect(store.getFrame(frame.id)!.html).toContain(':root{--spacing-4:16px}')
    expect(store.getFrame(frame.id)!.html).not.toContain('--color-ink')
  })

  it('restyles the frames naming a changed token, keeping sign-off', () => {
    const canvasId = setup()
    /* human writes: an agent's create plays back as a reveal, which defers the broadcast */
    const uses = actions.createFrame(
      canvasId,
      { name: 'Uses', html: '<html><head></head><body style="gap:var(--spacing-4)"></body></html>' },
      human,
    )!
    const other = actions.createFrame(canvasId, { name: 'Other', html: '<html><body>plain</body></html>' }, human)!
    store.updateFrame(
      uses.id,
      {
        approval: {
          status: 'ready_for_dev',
          approvedBy: 'Kevin',
          approvedByUserId: 'kevin',
          approvedAt: 1,
          approvedFrameUpdatedAt: uses.updatedAt,
        },
      },
      'Kevin',
    )
    const otherBefore = store.getFrame(other.id)!.updatedAt
    sent.length = 0
    const results = actions.setTokens(canvasId, [{ name: '--spacing-4', value: '24px' }], human)!
    expect(results).toEqual([{ name: '--spacing-4', result: 'updated' }])
    const saved = store.getFrame(uses.id)!
    expect(saved.html).toContain(':root{--spacing-4:24px}')
    expect(saved.approval?.status).toBe('ready_for_dev')
    expect(store.getFrame(other.id)!.updatedAt).toBe(otherBefore)
    expect(sent.filter((m) => m.type === 'frame:updated').map((m) => m.frameId)).toEqual([uses.id])
    expect(sent.some((m) => m.type === 'tokens')).toBe(true)
  })

  it('renames a theme with its values, and keeps “default” reserved', () => {
    const canvasId = setup()
    actions.setTokens(canvasId, [{ name: '--color-ink', themes: { dark: '#eee' } }], human)
    const frame = actions.createFrame(
      canvasId,
      { name: 'Hero', html: '<html><head></head><body style="color:var(--color-ink)"></body></html>' },
      human,
    )!
    expect(actions.setTokenThemes(canvasId, ['night'], human, [{ from: 'dark', to: 'night' }])).toEqual(['night'])
    expect(store.getTokens(canvasId).find((t) => t.name === '--color-ink')!.themes).toEqual({ night: '#eee' })
    expect(store.getFrame(frame.id)!.html).toContain('[data-doop-theme="night"]{--color-ink:#eee}')
    expect(() => actions.setTokenThemes(canvasId, ['default'], human)).toThrow(/invalid theme name/)
    expect(() => actions.setTokenThemes(canvasId, ['night'], human, [{ from: 'nope', to: 'x' }])).toThrow(/no theme/)
  })

  it('follows a rename into frames and aliases', () => {
    const canvasId = setup()
    const frame = actions.createFrame(
      canvasId,
      { name: 'Hero', html: '<html><head></head><body style="color:var(--color-ink, #000)"></body></html>' },
      agent,
    )!
    const results = actions.setTokens(canvasId, [{ name: '--color-ink', newName: '--color-text' }], human)!
    expect(results).toEqual([{ name: '--color-text', result: 'updated' }])
    const html = store.getFrame(frame.id)!.html
    expect(html).toContain('color:var(--color-text, #000)')
    expect(html).toContain(':root{--color-text:#111}')
    expect(store.getTokens(canvasId).find((t) => t.name === '--color-primary')!.value).toBe('var(--color-text)')
    expect(store.getTokens(canvasId).some((t) => t.name === '--color-ink')).toBe(false)
  })

  it('refuses bad input in-band and lands the rest of a batch', () => {
    const canvasId = setup()
    const results = actions.createTokens(
      canvasId,
      [
        { name: 'bad name!', type: 'color', value: '#fff' },
        { name: '--color-ink', type: 'color', value: '#000' },
        { name: '--x', type: 'color', value: 'var(--nope)' },
        { name: '--y', type: 'radius', value: '4px; } body { display: none' },
        { name: 'radius sm', type: 'radius', value: 4 },
      ],
      human,
    )!
    expect(results.map((r) => r.result)).toEqual(['error', 'error', 'error', 'error', 'created'])
    expect(store.getTokens(canvasId).find((t) => t.name === '--radius-sm')!.value).toBe('4')
    const [deletion] = actions.setTokens(canvasId, [{ name: '--color-ink', delete: true }], human)!
    expect(deletion).toMatchObject({ result: 'error', message: expect.stringContaining('--color-primary') })
    expect(
      actions.setTokens(canvasId, [{ name: '--color-ink', value: 'var(--color-primary)' }], human)![0],
    ).toMatchObject({
      result: 'error',
      message: expect.stringContaining('loop'),
    })
  })

  it('drops a deleted token from the frames that named it', () => {
    const canvasId = setup()
    const frame = actions.createFrame(
      canvasId,
      { name: 'Hero', html: '<html><head></head><body style="gap:var(--spacing-4)"></body></html>' },
      agent,
    )!
    const results = actions.setTokens(canvasId, [{ name: '--spacing-4', delete: true }], human)!
    expect(results).toEqual([{ name: '--spacing-4', result: 'deleted' }])
    expect(store.getFrame(frame.id)!.html).not.toContain(TOKEN_BLOCK_ATTR)
    expect(store.getFrame(frame.id)!.html).toContain('gap:var(--spacing-4)')
  })

  it('copies tokens with a duplicated canvas', async () => {
    const canvasId = setup()
    const copy = (await store.duplicateCanvas(canvasId, 'kevin', 'kevin'))!
    expect(copy.tokens?.map((t) => t.name)).toEqual(['--color-ink', '--color-primary', '--spacing-4'])
  })
})
