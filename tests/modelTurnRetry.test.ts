import { afterEach, expect, it, vi } from 'vitest'
import { ModelStreamInterruptedError, retryModelTurn } from '../server/modelTurnRetry.ts'
import { readEventStream } from '../server/openaiAgent.ts'

afterEach(() => vi.useRealTimers())
const socketError = () =>
  new TypeError('terminated', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) })
const options = () => ({ isCanceled: () => false, onRetry: vi.fn() })

it('retries dropped responses without executing their partial tool calls', async () => {
  vi.useFakeTimers()
  const execute = vi.fn()
  const run = vi
    .fn()
    .mockImplementationOnce(() =>
      readEventStream(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"type":"response.output_item.done","item":{"type":"function_call","name":"append_frame_rewrite","arguments":"{}"}}\n\n',
                ),
              )
            },
            pull(controller) {
              controller.error(socketError())
            },
          }),
        ),
      ),
    )
    .mockResolvedValueOnce({ output: [{ type: 'function_call', name: 'append_frame_rewrite', arguments: '{}' }] })
  const opts = options()
  const result = retryModelTurn(run, opts).then(execute)
  await vi.runAllTimersAsync()
  await result
  expect(run).toHaveBeenCalledTimes(2)
  expect(opts.onRetry).toHaveBeenCalledExactlyOnceWith(1)
  expect(execute).toHaveBeenCalledTimes(1)
})

it('stops after two retries', async () => {
  vi.useFakeTimers()
  const error = socketError()
  const run = vi.fn().mockRejectedValue(error)
  const result = expect(retryModelTurn(run, options())).rejects.toBe(error)
  await vi.runAllTimersAsync()
  await result
  expect(run).toHaveBeenCalledTimes(3)
})

it('does not retry credential errors or arbitrary tool/application errors', async () => {
  const run = vi.fn().mockRejectedValue(new Error('credentials rejected'))
  await expect(retryModelTurn(run, options())).rejects.toThrow('credentials rejected')
  expect(run).toHaveBeenCalledTimes(1)
})

it('does not start another request after cancellation during backoff', async () => {
  vi.useFakeTimers()
  let canceled = false
  const error = socketError()
  const run = vi.fn().mockRejectedValue(error)
  const result = expect(
    retryModelTurn(run, {
      isCanceled: () => canceled,
      onRetry: () => {
        canceled = true
      },
    }),
  ).rejects.toBe(error)
  await vi.runAllTimersAsync()
  await result
  expect(run).toHaveBeenCalledTimes(1)
})

it('recognizes a stream that closes without a terminal response', async () => {
  await expect(readEventStream(new Response('data: {"type":"response.created"}\n\n'))).rejects.toBeInstanceOf(
    ModelStreamInterruptedError,
  )
})
