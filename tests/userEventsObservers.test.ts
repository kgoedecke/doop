import { EventEmitter } from 'node:events'
import type { Request, Response } from 'express'
import { expect, it, vi } from 'vitest'
import { notifyUsers, onCanvasesChanged, streamCount, subscribe } from '../server/userEvents'

it('notifies access observers once with deduplicated users from a one-shot iterable', () => {
  const observed: string[][] = []
  const stop = onCanvasesChanged((users) => observed.push([...users]))
  try {
    function* users() {
      yield 'a'
      yield 'b'
      yield 'a'
    }
    notifyUsers(users(), { type: 'canvases' })
    expect(observed).toEqual([['a', 'b']])
  } finally {
    stop()
  }
})

it('unsubscribes only the selected access observer', () => {
  const first = vi.fn()
  const second = vi.fn()
  const stopFirst = onCanvasesChanged(first)
  const stopSecond = onCanvasesChanged(second)
  try {
    notifyUsers(['a'], { type: 'canvases' })
    stopFirst()
    notifyUsers(['a'], { type: 'canvases' })
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(2)
  } finally {
    stopFirst()
    stopSecond()
  }
})

it('refreshes current access before a disconnected optional SSE stream can throw', () => {
  const order: string[] = []
  const request = Object.assign(new EventEmitter(), { user: { id: 'observer-order' } })
  const response = { writeHead: vi.fn(), write: vi.fn() }
  subscribe(request as unknown as Request, response as unknown as Response)
  const stop = onCanvasesChanged(() => order.push('access'))
  response.write.mockImplementation(() => {
    order.push('stream')
    throw new Error('closed test stream')
  })
  try {
    expect(() => notifyUsers(['observer-order'], { type: 'canvases' })).toThrow('closed test stream')
    expect(order).toEqual(['access', 'stream'])
  } finally {
    stop()
    request.emit('close')
  }
  expect(streamCount('observer-order')).toBe(0)
})
