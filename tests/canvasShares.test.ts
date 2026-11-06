import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'

vi.mock('../server/db/index.ts', () => ({ db: {} }))

const { shareEmail } = await import('../server/canvasShares.ts')
const userEvents = await import('../server/userEvents.ts')

describe('shareEmail', () => {
  it('names the inviter and the canvas and links straight to it', () => {
    const mail = shareEmail(
      { name: 'Alice', email: 'alice@example.com' },
      { name: 'Bob', email: 'bob@example.com' },
      { id: 'c1', name: 'Landing' },
    )
    expect(mail.to).toBe('bob@example.com')
    expect(mail.subject).toBe('Alice shared “Landing” with you')
    expect(mail.text).toContain('Hi Bob,')
    expect(mail.text).toContain('alice@example.com')
    expect(mail.text).toMatch(/\/c\/c1\n/)
  })

  it('greets an account without a name', () => {
    const mail = shareEmail({ name: 'Alice', email: 'a@x' }, { name: '', email: 'b@x' }, { id: 'c', name: 'N' })
    expect(mail.text).toContain('Hi there,')
  })
})

function openStream(userId: string) {
  const req = Object.assign(new EventEmitter(), { user: { id: userId } }) as unknown as Request
  const writes: string[] = []
  const res = { writeHead: vi.fn(), write: (chunk: string) => writes.push(chunk) } as unknown as Response
  userEvents.subscribe(req, res)
  return { writes, close: () => (req as unknown as EventEmitter).emit('close') }
}

describe('user event streams', () => {
  it('pushes an event to every open tab of the named user only', () => {
    const a1 = openStream('ann')
    const a2 = openStream('ann')
    const b = openStream('ben')
    userEvents.notifyUsers(['ann', 'ann'], { type: 'canvases' })
    const pushed = (w: string[]) => w.filter((l) => l.startsWith('data:'))
    expect(pushed(a1.writes)).toEqual(['data: {"type":"canvases"}\n\n'])
    expect(pushed(a2.writes)).toHaveLength(1)
    expect(pushed(b.writes)).toHaveLength(0)
    a1.close()
    a2.close()
    b.close()
  })

  it('forgets a stream once its connection closes', () => {
    const s = openStream('cat')
    expect(userEvents.streamCount('cat')).toBe(1)
    s.close()
    expect(userEvents.streamCount('cat')).toBe(0)
    userEvents.notifyUsers(['cat'], { type: 'canvases' })
    expect(s.writes.some((l) => l.startsWith('data:'))).toBe(false)
  })
})
