import { describe, expect, it, vi } from 'vitest'
import { LocalAgentRuns, type LocalHarnessRequest } from '../server/localAgentRuns.ts'

function harness(
  execute: LocalHarnessRequest['execute'] = async (block) => ({
    type: 'tool_result',
    tool_use_id: block.id,
    content: 'ok',
  }),
): LocalHarnessRequest {
  return {
    canvasId: 'canvas-a',
    prompt: 'Design a page',
    system: 'Use canvas tools',
    maxTurns: 24,
    tools: [{ name: 'create_frame', input_schema: { type: 'object' } }],
    execute,
  }
}

describe('local Claude run ownership', () => {
  it('leases each run to one device and only its requester can finish it', async () => {
    const runs = new LocalAgentRuns()
    const result = runs.start('alice', 'sonnet', harness())
    expect(runs.poll('bob', 'bob-device')).toBeNull()
    const job = runs.poll('alice', 'first')!
    expect(job.model).toBe('sonnet')
    expect(runs.poll('alice', 'second')).toBeNull()
    expect(await runs.finish(job.id, 'bob', 'first', { success: true, text: '' })).toBe(false)
    expect(await runs.finish(job.id, 'alice', 'second', { success: true, text: '' })).toBe(false)
    expect(await runs.finish(job.id, 'alice', 'first', { success: true, text: 'Done' })).toBe(true)
    expect(await result).toEqual({ success: true, text: 'Done' })
    expect(runs.authorized(job.id, job.token)).toBeUndefined()
  })

  it('does not allow tools before claiming, with a wrong token, or after cancellation', async () => {
    const runs = new LocalAgentRuns()
    const execute = vi.fn(harness().execute)
    const result = runs.start('alice', 'default', harness(execute))
    const job = runs.poll('alice', 'first')!
    await expect(runs.execute(job.id, 'wrong-token', 'create_frame', {})).rejects.toThrow()
    await expect(runs.execute(job.id, job.token, 'Bash', {})).rejects.toThrow()
    expect(execute).not.toHaveBeenCalled()
    await runs.cancel('alice')
    await expect(runs.execute(job.id, job.token, 'create_frame', {})).rejects.toThrow()
    expect((await result).success).toBe(false)
  })

  it('serializes tool calls and waits for an in-flight mutation before completing', async () => {
    const runs = new LocalAgentRuns()
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const order: string[] = []
    const result = runs.start(
      'alice',
      'default',
      harness(async (block) => {
        order.push('started')
        await pending
        order.push('finished')
        return { type: 'tool_result', tool_use_id: block.id, content: 'ok' }
      }),
    )
    const job = runs.poll('alice', 'first')!
    const call = runs.execute(job.id, job.token, 'create_frame', {})
    await Promise.resolve()
    const finish = runs.finish(job.id, 'alice', 'first', { success: true, text: 'Done' }).then(() => {
      order.push('completed')
    })
    expect(order).toEqual(['started'])
    release()
    await call
    await finish
    await result
    expect(order).toEqual(['started', 'finished', 'completed'])
  })

  it('expires disconnected runs without handing them to another device', async () => {
    const runs = new LocalAgentRuns()
    const result = runs.start('alice', 'default', harness())
    const job = runs.poll('alice', 'first')!
    expect(runs.online('alice')).toBe(true)
    const later = Date.now() + 46_000
    expect(runs.poll('alice', 'second', later)).toBeNull()
    await runs.expire(later)
    expect((await result).success).toBe(false)
    expect(runs.authorized(job.id, job.token)).toBeUndefined()
  })
})

it('keeps queued canvas runs alive while another canvas occupies the desktop', async () => {
  const runs = new LocalAgentRuns()
  const now = Date.now()
  const first = runs.start('alice', 'default', harness())
  const second = runs.start('alice', 'default', harness())
  const job = runs.poll('alice', 'desktop', now)!
  runs.poll('alice', 'desktop', now + 50_000)
  await runs.expire(now + 50_000)
  expect(await runs.finish(job.id, 'alice', 'desktop', { success: true, text: 'First' })).toBe(true)
  expect((await first).success).toBe(true)
  const next = runs.poll('alice', 'desktop', now + 50_001)!
  expect(next.id).not.toBe(job.id)
  await runs.finish(next.id, 'alice', 'desktop', { success: true, text: 'Second' })
  expect((await second).success).toBe(true)
})
