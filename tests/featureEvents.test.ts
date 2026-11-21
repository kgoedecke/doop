import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ capture: vi.fn() }))
vi.mock('../server/analytics.ts', () => ({ capture: mocks.capture }))

const { captureFeature, captureTokenResults } = await import('../server/featureEvents.ts')

beforeEach(() => mocks.capture.mockReset())

it('counts a feature on its person, with where it was used from', () => {
  captureFeature('u1', 'page_background_changed', 'mcp', { canvas_id: 'c1', cleared: false })
  expect(mocks.capture).toHaveBeenCalledExactlyOnceWith('u1', 'page_background_changed', {
    canvas_id: 'c1',
    cleared: false,
    via: 'mcp',
  })
})

it('counts nothing without a person to count it on', () => {
  captureFeature(undefined, 'prototype_start_set', 'mcp')
  expect(mocks.capture).not.toHaveBeenCalled()
})

it('counts a token write by outcome and leaves the failures out', () => {
  captureTokenResults('u1', 'c1', 'resident', [
    { name: '--a', result: 'created' },
    { name: '--b', result: 'updated' },
    { name: '--c', result: 'deleted' },
    { name: '--d', result: 'created' },
    { name: '--e', result: 'error', message: 'bad value' },
  ])
  expect(mocks.capture).toHaveBeenCalledExactlyOnceWith('u1', 'tokens_changed', {
    canvas_id: 'c1',
    created: 2,
    updated: 1,
    deleted: 1,
    via: 'resident',
  })
})

it('does not count a token write where every token failed', () => {
  captureTokenResults('u1', 'c1', 'ui', [{ name: '--a', result: 'error', message: 'bad value' }])
  captureTokenResults('u1', 'c1', 'ui', undefined)
  expect(mocks.capture).not.toHaveBeenCalled()
})
