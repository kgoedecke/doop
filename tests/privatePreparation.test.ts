// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api, ApiError } from '../src/lib/api'
import {
  preparePrivateDocument,
  observePrivateMediaActor,
  observePrivateCanvasAccess,
  invalidatePrivateMedia,
} from '../src/lib/privateMaterialization'
import { fixturePrivateMaterializer } from './privateMediaAdapter'

const fixtureApi: typeof api.privateMaterialization = (context, source, ...rest) =>
  fixturePrivateMaterializer(source, context, ...rest)

const context = { canvasId: 'recovery-parent', kind: 'frame' as const, id: 'recovery-frame' }
let actor = 0
beforeEach(() => {
  observePrivateMediaActor(`recovery-actor-${++actor}`)
})
afterEach(() => {
  vi.restoreAllMocks()
})

it('a missing resource fails the draft but allows a corrected draft under the same still-live context', async () => {
  const transport = vi
    .spyOn(api, 'privateMaterialization')
    .mockRejectedValueOnce(new ApiError(404, 'missing'))
    .mockImplementation(fixtureApi)
  await expect(preparePrivateDocument('<img src="/a/missing.png">', context)).rejects.toMatchObject({ kind: 'invalid' })
  expect(transport.mock.calls.map(([, source]) => source)).toEqual(['<img src="/a/missing.png">', ''])
  expect(transport.mock.calls[1]![4]).toEqual({
    encodedBytes: 0,
    decodedBytes: 0,
    references: 0,
    parserWork: 0,
    expandedBytes: 0,
  })
  await expect(preparePrivateDocument('<p>Corrected draft</p>', context)).resolves.toMatchObject({
    html: '<p>Corrected draft</p>',
  })
})

it('a denied current-context probe blocks new preparation until the existing loader observes fresh access', async () => {
  const transport = vi.spyOn(api, 'privateMaterialization').mockRejectedValue(new ApiError(404, 'missing'))
  await expect(preparePrivateDocument('<img src="/a/missing.png">', context)).rejects.toMatchObject({ kind: 'aborted' })
  expect(transport).toHaveBeenCalledTimes(2)
  transport.mockImplementation(fixtureApi)
  await expect(preparePrivateDocument('<p>Still denied</p>', context)).rejects.toMatchObject({ kind: 'aborted' })
  expect(transport).toHaveBeenCalledTimes(2)
  observePrivateCanvasAccess(context.canvasId)
  await expect(preparePrivateDocument('<p>New access</p>', context)).resolves.toMatchObject({
    html: '<p>New access</p>',
  })
})

it('a stale failed probe cannot block a newly observed actor', async () => {
  let rejectProbe!: (error: Error) => void
  const transport = vi
    .spyOn(api, 'privateMaterialization')
    .mockRejectedValueOnce(new ApiError(404, 'missing'))
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectProbe = reject
        }),
    )
  const pending = preparePrivateDocument('<img src="/a/missing.png">', context)
  await vi.waitFor(() => expect(rejectProbe).toBeTypeOf('function'))
  observePrivateMediaActor('new-actor')
  rejectProbe(new ApiError(404, 'stale denial'))
  await expect(pending).rejects.toMatchObject({ kind: 'aborted' })
  transport.mockImplementation(fixtureApi)
  await expect(preparePrivateDocument('<p>New actor</p>', context)).resolves.toMatchObject({ html: '<p>New actor</p>' })
})

it('normal endpoint budget and unsupported-format errors retain their bounded classifications', async () => {
  const transport = vi.spyOn(api, 'privateMaterialization')
  for (const [status, kind] of [
    [413, 'limit'],
    [422, 'unsupported'],
  ] as const) {
    transport.mockRejectedValueOnce(new ApiError(status, 'bounded error'))
    await expect(preparePrivateDocument('<p>Draft</p>', context)).rejects.toMatchObject({ kind })
  }
  invalidatePrivateMedia()
})
