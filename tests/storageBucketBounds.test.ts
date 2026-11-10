import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// Controlled SDK/stream fixture: real S3-compatible service checks remain in
// private-file deployment verification. These cases drive deadline and byte
// failures, including a response whose headers arrive but body never completes.
const rig = vi.hoisted(() => ({ send: vi.fn() }))
vi.mock('../server/env.ts', () => ({ env: { BUCKET: 'private-test-bucket', REGION: 'test' } }))
vi.mock('@aws-sdk/client-s3', () => {
  class Command {
    constructor(readonly input: unknown) {}
  }
  return {
    S3Client: class {
      send = rig.send
    },
    GetObjectCommand: Command,
    PutObjectCommand: Command,
    DeleteObjectCommand: Command,
  }
})
const storage = await import('../server/storage.ts')

beforeEach(() => {
  vi.useFakeTimers()
  rig.send.mockReset()
})
afterEach(() => {
  expect(vi.getTimerCount()).toBe(0)
  vi.useRealTimers()
})

it.each(['get', 'put', 'delete'] as const)('aborts a stalled bucket %s operation at its deadline', async (kind) => {
  rig.send.mockImplementation(
    (_command: unknown, { abortSignal }: { abortSignal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        abortSignal.addEventListener('abort', () => reject(abortSignal.reason), { once: true })
      }),
  )
  const operation =
    kind === 'get'
      ? storage.getObject('private.png')
      : kind === 'put'
        ? storage.putObject('private.png', Buffer.from('file'), 'image/png')
        : storage.deleteObject('private.png')
  const failed = expect(operation).rejects.toThrow(/timed out/)
  await vi.waitFor(() => expect(rig.send).toHaveBeenCalledOnce())
  const signal = rig.send.mock.calls[0]![1].abortSignal as AbortSignal
  await vi.advanceTimersByTimeAsync(storage.STORAGE_TIMEOUT_MS - 1000)
  expect(signal.aborted).toBe(false)
  await vi.advanceTimersByTimeAsync(1000)
  await failed
  expect(signal.aborted).toBe(true)
})

it('keeps the same deadline through streamed bytes and cancels a stalled body', async () => {
  const cancel = vi.fn()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from('first chunk'))
    },
    cancel,
  })
  rig.send.mockResolvedValue({ Body: { transformToWebStream: () => stream } })
  const operation = storage.getObject('private.png')
  const failed = expect(operation).rejects.toThrow(/timed out/)
  await vi.waitFor(() => expect(stream.locked).toBe(true))
  await vi.advanceTimersByTimeAsync(storage.STORAGE_TIMEOUT_MS)
  await failed
  expect(cancel).toHaveBeenCalledOnce()
  expect(stream.locked).toBe(false)
})

it.each([true, false])('cancels oversized bucket bytes with declared length: %s', async (declared) => {
  const cancel = vi.fn()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.alloc(9))
    },
    cancel,
  })
  rig.send.mockResolvedValue({
    ...(declared ? { ContentLength: 9 } : {}),
    Body: { transformToWebStream: () => stream },
  })
  await expect(storage.getObject('private.png', 8)).rejects.toThrow(/read budget/)
  expect(cancel).toHaveBeenCalledOnce()
  expect(stream.locked).toBe(false)
})

it('returns bounded bytes and preserves missing-object versus operational failures', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from('file'))
      controller.close()
    },
  })
  rig.send.mockResolvedValueOnce({ ContentLength: 4, Body: { transformToWebStream: () => stream } })
  expect((await storage.getObject('private.png', 4))?.toString()).toBe('file')
  rig.send.mockRejectedValueOnce(Object.assign(new Error('missing'), { name: 'NoSuchKey' }))
  expect(await storage.getObject('missing.png')).toBeNull()
  rig.send.mockRejectedValueOnce(new Error('bucket is unavailable'))
  await expect(storage.getObject('private.png')).rejects.toThrow(/unavailable/)
})
