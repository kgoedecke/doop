import { expect, it, vi } from 'vitest'
import { createMaterializationRunner } from '../server/materializationJob.ts'
import { PrivateMaterializationError } from '../shared/privateMedia.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it('response timeout keeps all four signal-ignoring leaves counted until they actually settle', async () => {
  const run = createMaterializationRunner({ responseMs: 50 })
  const held = deferred<void>()
  let outstanding = 0
  let peak = 0
  let starts = 0
  let latePublication = 0
  const pending = Array.from({ length: 4 }, () =>
    run(async (job) => {
      await job.read(async () => {
        outstanding++
        starts++
        peak = Math.max(peak, outstanding)
        try {
          await held.promise
        } finally {
          outstanding--
        }
      })
      latePublication++
      return 'late'
    }).catch((error: unknown) => error),
  )
  await vi.waitFor(() => expect(starts).toBe(4))
  const results = await Promise.all(pending)
  for (const result of results) expect(result).toBeInstanceOf(PrivateMaterializationError)
  expect(outstanding).toBe(4)
  const replacements = Array.from({ length: 3 }, () =>
    run(async () => {
      starts++
      return 'replacement'
    }).catch((error: unknown) => error),
  )
  await Promise.all(replacements)
  expect(starts).toBe(4)
  expect(outstanding).toBe(4)
  held.resolve()
  // Cancelled queue entries may acquire only to release: no hidden replacement work.
  await vi.waitFor(() => expect(outstanding).toBe(0))
  await expect(run(async () => 'after drain')).resolves.toBe('after drain')
  expect(starts).toBe(4)
  expect(peak).toBe(4)
  expect(latePublication).toBe(0)
})

it('queued cancellation starts no work and does not release another job’s permit', async () => {
  const run = createMaterializationRunner({ responseMs: 2_000 })
  const held = deferred<void>()
  let active = 0
  const started = deferred<void>()
  const owners = Array.from({ length: 4 }, () =>
    run(async (job) => {
      active++
      if (active === 4) started.resolve()
      await job.read(() => held.promise)
      active--
    }),
  )
  await started.promise
  const controller = new AbortController()
  let queuedStarts = 0
  const queued = run(async () => {
    queuedStarts++
  }, controller.signal)
  controller.abort()
  await expect(queued).rejects.toBeInstanceOf(PrivateMaterializationError)
  expect(active).toBe(4)
  expect(queuedStarts).toBe(0)
  held.resolve()
  await Promise.all(owners)
  await expect(run(async () => 'next')).resolves.toBe('next')
  expect(active).toBe(0)
  expect(queuedStarts).toBe(0)
})

it('cancellation stops subsequent reads even when the current read ignores its signal', async () => {
  const run = createMaterializationRunner({ responseMs: 2_000 })
  const controller = new AbortController()
  const exit = deferred<void>()
  const started = deferred<void>()
  let stopRequests = 0
  let secondReads = 0
  const outcome = run(async (job) => {
    job.onCancel(() => {
      stopRequests++
    })
    await job.read(async () => {
      started.resolve()
      await exit.promise
    })
    await job.read(async () => {
      secondReads++
    })
    return 'late read result'
  }, controller.signal)
  await started.promise
  controller.abort()
  await expect(outcome).rejects.toBeInstanceOf(PrivateMaterializationError)
  expect(stopRequests).toBe(1)
  expect(secondReads).toBe(0)
  exit.resolve()
  await expect(run(async () => 'normal')).resolves.toBe('normal')
  await vi.waitFor(() => expect(secondReads).toBe(0))
  expect(stopRequests).toBe(1)
})
