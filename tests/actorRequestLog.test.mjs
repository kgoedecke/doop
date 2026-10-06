import { describe, expect, it } from 'vitest'
import { actorRequestLogFilter } from '../scripts/run-with-actors.mjs'

describe('actor control-plane request log', () => {
  it('hides request logs unless dev:logs or RUST_LOG asks for them', () => {
    expect(actorRequestLogFilter({}, false)).toBe('durable_actors=error')
    expect(actorRequestLogFilter({}, true)).toBeUndefined()
    expect(actorRequestLogFilter({ RUST_LOG: 'debug' }, false)).toBeUndefined()
    expect(actorRequestLogFilter({ RUST_LOG: 'debug' }, true)).toBeUndefined()
  })
})
