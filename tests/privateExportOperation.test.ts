import { createHash } from 'node:crypto'
// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { PrivateExportOperation } from '../src/lib/privateExport'
import { invalidatePrivateMedia, type PrivateMaterializer } from '../src/lib/privateMaterialization'

/** Explicit transport stand-in: these checks prove parent accounting/lifetime,
 * not HTTP authorization or the native decoder's metadata. */
function transport() {
  return vi.fn<PrivateMaterializer>(async (source) => ({
    html: source,
    replacements: [],
    privateMedia: source !== '',
    costs: {
      resources: source
        ? [{ key: 'private:canvas:resource.png', mime: 'image/png', encodedBytes: 8, decodedBytes: 16 }]
        : [],
      references: source ? 1 : 0,
      parserWork: source ? 2 : 0,
      expandedBytes: source.length,
    },
  }))
}

it('one export composes root and CSS costs, deduplicates a repeated identity and lowers subsequent allowances', async () => {
  const materialize = transport()
  const operation = new PrivateExportOperation({ id: 'frame', canvasId: 'canvas' }, undefined, materialize)
  try {
    await operation.document('root')
    await operation.document('css', 'stylesheet')
    expect(operation.budget.usage).toEqual({
      encodedBytes: 8,
      decodedBytes: 16,
      references: 2,
      parserWork: 4,
      expandedBytes: 7,
    })
    const first = materialize.mock.calls[0]![4]!
    const second = materialize.mock.calls[1]![4]!
    expect(second.encodedBytes).toBe(first.encodedBytes! - 8)
    expect(second.decodedBytes).toBe(first.decodedBytes! - 16)
    await operation.revalidate()
    expect(materialize.mock.calls[2]![0]).toBe('')
    expect(materialize.mock.calls[2]![1]).toEqual({ id: 'frame', canvasId: 'canvas', kind: 'frame' })
  } finally {
    operation.close()
  }
})

it('observed access invalidation aborts an export between requests and forbids late delivery', async () => {
  const materialize = transport()
  const operation = new PrivateExportOperation({ id: 'frame', canvasId: 'canvas' }, undefined, materialize)
  try {
    await operation.document('root')
    invalidatePrivateMedia()
    expect(operation.signal.aborted).toBe(true)
    await expect(operation.revalidate()).rejects.toThrow()
    expect(materialize).toHaveBeenCalledOnce()
  } finally {
    operation.close()
  }
})

it('late preparation is discarded if the actor/context epoch changes while it is pending', async () => {
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const base = transport()
  let started = false
  const delayed: PrivateMaterializer = async (...args) => {
    started = true
    await held
    return base(...args)
  }
  const operation = new PrivateExportOperation({ id: 'frame', canvasId: 'canvas' }, undefined, delayed)
  try {
    const pending = operation.document('private bytes')
    await vi.waitFor(() => expect(started).toBe(true))
    invalidatePrivateMedia()
    release()
    await expect(pending).rejects.toThrow()
    expect(operation.budget.usage.decodedBytes).toBe(0)
  } finally {
    release()
    operation.close()
  }
})

it('competing preparations read remaining limits after prior admission settles', async () => {
  const base = transport()
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let calls = 0
  const controlled: PrivateMaterializer = async (...args) => {
    if (++calls === 1) await held
    return base(...args)
  }
  const operation = new PrivateExportOperation({ id: 'frame', canvasId: 'canvas' }, undefined, controlled)
  const first = operation.document('first')
  const second = operation.document('second')
  try {
    await vi.waitFor(() => expect(calls).toBe(1))
    release()
    await Promise.all([first, second])
    expect(calls).toBe(2)
    expect(base.mock.calls[1]![4]!.decodedBytes).toBe(base.mock.calls[0]![4]!.decodedBytes! - 16)
  } finally {
    release()
    await Promise.allSettled([first, second])
    operation.close()
  }
})

it('a reserved public resource spends its bytes and source reference once while distinct URLs keep distinct decode costs', async () => {
  const materialize = vi.fn<PrivateMaterializer>(async (source) => ({
    html: source,
    replacements: [],
    privateMedia: true,
    costs: {
      resources: [{ key: 'inline:fixture', mime: 'image/png', encodedBytes: 3, decodedBytes: 1024 }],
      references: 1,
      parserWork: 2,
      expandedBytes: source.length,
    },
  }))
  const operation = new PrivateExportOperation({ id: 'frame', canvasId: 'canvas' }, undefined, materialize)
  try {
    operation.budget.reference(2)
    for (const url of ['https://first.example/image', 'https://second.example/image']) {
      operation.publicChunk(url, 3)
      expect(await operation.publicResource('data:text/plain;base64,YWJj', url, 3)).toBe('data:image/png;base64,YWJj')
    }
    expect(operation.budget.usage).toMatchObject({ encodedBytes: 6, decodedBytes: 2048, references: 2 })
    expect(materialize.mock.calls[0]![4]!.encodedBytes).toBe(15_000_000)
    expect(materialize.mock.calls[1]![4]!.encodedBytes).toBe(15_000_000 - 3)
    expect(materialize.mock.calls[1]![4]!.decodedBytes).toBe(64 * 1024 * 1024 - 1024)
  } finally {
    operation.close()
  }
})

it('reuses one producer-admitted inline payload with alternate encoding even at the decoded boundary', async () => {
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6mioAAAAASUVORK5CYII=',
    'base64',
  )
  const key = `inline:image/png:${createHash('sha256').update(bytes).digest('hex')}`
  const transport = vi.fn(async () => ({
    html: '<img>',
    replacements: [],
    privateMedia: true,
    costs: {
      resources: [{ key, mime: 'image/png', encodedBytes: bytes.length, decodedBytes: 4 }],
      references: 1,
      parserWork: 1,
      expandedBytes: 5,
    },
  }))
  const operation = new PrivateExportOperation({ id: 'inline-frame', canvasId: 'inline-canvas' }, undefined, transport)
  try {
    await operation.document('<img>')
    operation.budget.reserveDecoded('other-already-admitted-resource', 64 * 1024 * 1024 - 4)
    expect(operation.budget.remaining.decodedBytes).toBe(0)
    const alternate = `data:text/plain,${[...bytes].map((byte) => '%' + byte.toString(16).padStart(2, '0')).join('')}`
    await expect(operation.inlineResource(alternate)).resolves.toBe(alternate)
    expect(transport).toHaveBeenCalledTimes(1)
    expect(operation.budget.remaining.decodedBytes).toBe(0)
    expect(operation.budget.usage.encodedBytes).toBe(bytes.length)
  } finally {
    operation.close()
  }
})
