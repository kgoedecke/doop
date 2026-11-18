import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  afterCommit,
  checkpoint,
  detached,
  inTransaction,
  openTransaction,
  outsideOperation,
  postCommit,
  recordUndo,
  requireBoundary,
  transaction,
  WriteBoundaryError,
} from '../server/journal.ts'
import { runOperation, WorkBudgetError } from '../server/workBudget.ts'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

afterEach(() => {
  vi.restoreAllMocks()
  unstubAllEnvs()
})

/** A value that journals its changes, and a log of what reached the outside. */
function fixture() {
  const state = { value: 0 }
  const out: string[] = []
  const set = (value: number) => {
    const before = state.value
    state.value = value
    recordUndo(() => {
      out.push(`undo ${value}`)
      state.value = before
    })
    afterCommit(() => out.push(`sent ${value}`))
  }
  return { state, out, set }
}

describe('a transaction', () => {
  it('applies changes at once and sends nothing until it commits', () => {
    const { state, out, set } = fixture()
    transaction(() => {
      set(1)
      expect(state.value).toBe(1)
      expect(out).toEqual([])
      set(2)
    })
    expect(state.value).toBe(2)
    expect(out).toEqual(['sent 1', 'sent 2'])
  })

  it('undoes in reverse and sends nothing when the work throws', () => {
    const { state, out, set } = fixture()
    expect(() =>
      transaction(() => {
        set(1)
        set(2)
        throw new Error('no')
      }),
    ).toThrow('no')
    expect(state.value).toBe(0)
    expect(out).toEqual(['undo 2', 'undo 1'])
  })

  it('commits when a promise resolves and rolls back when it rejects', async () => {
    const { state, out, set } = fixture()
    await transaction(async () => {
      set(1)
      await Promise.resolve()
      expect(out).toEqual([])
      set(2)
    })
    expect(out).toEqual(['sent 1', 'sent 2'])
    out.length = 0
    await expect(
      transaction(async () => {
        set(3)
        await Promise.resolve()
        throw new Error('late')
      }),
    ).rejects.toThrow('late')
    expect(state.value).toBe(2)
    expect(out).toEqual(['undo 3'])
  })

  it('runs an effect at once when there is no transaction', () => {
    const { out, set } = fixture()
    expect(inTransaction()).toBe(false)
    set(1)
    expect(out).toEqual(['sent 1'])
  })

  it('keeps sending after an effect that throws, and says so', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const out: string[] = []
    transaction(() => {
      afterCommit(() => out.push('first'))
      afterCommit(() => {
        throw new Error('socket closed')
      })
      afterCommit(() => out.push('third'))
    })
    expect(out).toEqual(['first', 'third'])
    expect(logged).toHaveBeenCalledTimes(1)
  })

  it('keeps undoing after an undo that throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { state, set } = fixture()
    expect(() =>
      transaction(() => {
        set(1)
        recordUndo(() => {
          throw new Error('broken undo')
        })
        throw new Error('no')
      }),
    ).toThrow('no')
    expect(state.value).toBe(0)
  })

  it('sends an effect once under one key, where the first was queued', () => {
    const out: string[] = []
    transaction(() => {
      afterCommit(() => out.push('row'), 'row:1')
      afterCommit(() => out.push('other'))
      afterCommit(() => out.push('row again'), 'row:1')
    })
    expect(out).toEqual(['row', 'other'])
  })
})

describe('a transaction inside another', () => {
  it('is a savepoint: its effects wait for the outer commit, in order', () => {
    const { out, set } = fixture()
    transaction(() => {
      set(1)
      transaction(() => set(2))
      expect(out).toEqual([])
      set(3)
    })
    expect(out).toEqual(['sent 1', 'sent 2', 'sent 3'])
  })

  it('undoes only its own part when it throws and the outer one goes on', () => {
    const { state, out, set } = fixture()
    transaction(() => {
      set(1)
      expect(() =>
        transaction(() => {
          set(2)
          throw new Error('inner')
        }),
      ).toThrow('inner')
      expect(state.value).toBe(1)
      set(3)
    })
    expect(state.value).toBe(3)
    expect(out).toEqual(['undo 2', 'sent 1', 'sent 3'])
  })

  it('is undone with the outer one when the outer one throws later', () => {
    const { state, out, set } = fixture()
    expect(() =>
      transaction(() => {
        set(1)
        transaction(() => set(2))
        throw new Error('outer')
      }),
    ).toThrow('outer')
    expect(state.value).toBe(0)
    expect(out).toEqual(['undo 2', 'undo 1'])
  })

  it('forgets a key queued inside a savepoint that was undone', () => {
    const out: string[] = []
    transaction(() => {
      expect(() =>
        transaction(() => {
          afterCommit(() => out.push('undone'), 'row:1')
          throw new Error('inner')
        }),
      ).toThrow('inner')
      afterCommit(() => out.push('kept'), 'row:1')
    })
    expect(out).toEqual(['kept'])
  })
})

describe('a sub-commit', () => {
  it('commits the work that follows it on its own, so the rest being refused cannot undo it', () => {
    const { state, out, set } = fixture()
    expect(() =>
      transaction(() => {
        postCommit(() => set(7))
        checkpoint()
        throw new Error('no')
      }),
    ).toThrow('no')
    expect(state.value).toBe(7)
    expect(out).toEqual(['sent 7'])
  })

  it('sends what is done and keeps it when the rest is refused', () => {
    const { state, out, set } = fixture()
    expect(() =>
      transaction(() => {
        set(1)
        checkpoint()
        expect(out).toEqual(['sent 1'])
        set(2)
        throw new Error('no')
      }),
    ).toThrow('no')
    expect(state.value).toBe(1)
    expect(out).toEqual(['sent 1', 'undo 2'])
  })

  it('commits through every savepoint around it', () => {
    const { state, out, set } = fixture()
    expect(() =>
      transaction(() => {
        set(1)
        transaction(() => {
          set(2)
          checkpoint()
          set(3)
          throw new Error('inner')
        })
      }),
    ).toThrow('inner')
    expect(state.value).toBe(2)
    expect(out).toEqual(['sent 1', 'sent 2', 'undo 3'])
  })

  it('is nothing outside a transaction', () => {
    expect(() => checkpoint()).not.toThrow()
  })
})

describe('work for after the commit', () => {
  it('runs once everything queued has been sent, in a transaction of its own', () => {
    const { out, set } = fixture()
    transaction(() => {
      postCommit(() => {
        out.push(`post, in transaction: ${inTransaction()}`)
        set(9)
      })
      set(1)
    })
    expect(out).toEqual(['sent 1', 'post, in transaction: true', 'sent 9'])
  })

  it('does not run when the transaction is undone', () => {
    const ran = vi.fn()
    expect(() =>
      transaction(() => {
        postCommit(ran)
        throw new Error('no')
      }),
    ).toThrow('no')
    expect(ran).not.toHaveBeenCalled()
  })

  it('cannot undo the commit it follows', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { state, out, set } = fixture()
    transaction(() => {
      set(1)
      postCommit(() => {
        set(2)
        throw new Error('post failed')
      })
    })
    expect(state.value).toBe(1)
    expect(out).toEqual(['sent 1', 'undo 2'])
  })
})

describe('a transaction opened by hand', () => {
  it('commits once, and a second settle is nothing', () => {
    const { out, set } = fixture()
    const request = openTransaction()
    request.run(() => set(1))
    expect(out).toEqual([])
    request.commit()
    request.commit()
    request.rollback()
    expect(out).toEqual(['sent 1'])
    expect(request.open).toBe(false)
  })

  it('rolls back what ran inside it', () => {
    const { state, out, set } = fixture()
    const request = openTransaction()
    request.run(() => set(1))
    request.rollback()
    expect(state.value).toBe(0)
    expect(out).toEqual(['undo 1'])
  })

  it('leaves work that goes on after it settled to commit by itself', () => {
    const { out, set } = fixture()
    const request = openTransaction()
    request.run(() => {
      request.commit()
      set(1)
      transaction(() => set(2))
    })
    expect(out).toEqual(['sent 1', 'sent 2'])
  })
})

describe('detached work', () => {
  it('does not join the transaction it was started from', () => {
    const { state, out, set } = fixture()
    expect(() =>
      transaction(() => {
        detached(() => transaction(() => set(1)))
        expect(out).toEqual(['sent 1'])
        throw new Error('outer')
      }),
    ).toThrow('outer')
    expect(state.value).toBe(1)
  })
})

describe('an operation', () => {
  it('is one transaction: a budget refusal undoes it', () => {
    const { state, out, set } = fixture()
    expect(() =>
      runOperation('test', undefined, () => {
        set(1)
        throw new WorkBudgetError('test', undefined, 'bytes')
      }),
    ).toThrow(WorkBudgetError)
    expect(state.value).toBe(0)
    expect(out).toEqual(['undo 1'])
  })

  it('opened inside another is a savepoint of it', () => {
    const { state, out, set } = fixture()
    expect(() =>
      runOperation('outer', undefined, () => {
        set(1)
        runOperation('inner', undefined, () => set(2))
        expect(out).toEqual([])
        throw new Error('outer')
      }),
    ).toThrow('outer')
    expect(state.value).toBe(0)
  })
})

describe('the write-boundary check', () => {
  it('is silent by default under test', () => {
    expect(() => requireBoundary('store.saveComponent')).not.toThrow()
  })

  it('refuses a write outside any transaction when set to throw', () => {
    stubEnv('DOOP_WRITE_BOUNDARY', 'throw')
    expect(() => requireBoundary('store.saveComponent')).toThrow(WriteBoundaryError)
  })

  it('allows a write inside a transaction, and one marked as outside', () => {
    stubEnv('DOOP_WRITE_BOUNDARY', 'throw')
    expect(() => transaction(() => requireBoundary('store.saveComponent'))).not.toThrow()
    expect(() => outsideOperation('boot seeds the welcome canvas', () => requireBoundary('x'))).not.toThrow()
  })

  it('refuses a write after its transaction settled', () => {
    stubEnv('DOOP_WRITE_BOUNDARY', 'throw')
    const request = openTransaction()
    request.run(() => {
      request.commit()
      expect(() => requireBoundary('store.updateFrame')).toThrow(WriteBoundaryError)
    })
  })

  it('logs once per caller when set to warn', () => {
    stubEnv('DOOP_WRITE_BOUNDARY', 'warn')
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const write = () => requireBoundary('store.warnOnce')
    write()
    write()
    expect(logged).toHaveBeenCalledTimes(1)
  })

  it('keeps the mark through a transaction opened inside it', () => {
    stubEnv('DOOP_WRITE_BOUNDARY', 'throw')
    outsideOperation('a job that commits each write by itself', () => {
      transaction(() => requireBoundary('a'))
      expect(() => requireBoundary('b')).not.toThrow()
    })
  })
})
