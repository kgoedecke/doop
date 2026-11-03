import { describe, expect, it } from 'vitest'
import { authErrorCode, authErrorMessage } from '../src/lib/authError'

/* The body Railway's edge sends whenever it answers instead of the container
   (a deploy restart, a cold start, a 404 for a renamed service). Its `code` is
   a number, where every code our own API sends is a string. */
const EDGE_ERROR = {
  status: 'error',
  code: 502,
  message: 'Application failed to respond',
  request_id: 'Ks3Nn1gLSsmRxT8ZTqA3dQ',
}

describe('authErrorCode', () => {
  it('reads our own API codes', () => {
    expect(authErrorCode({ code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL' })).toBe(
      'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL',
    )
  })

  it('matches nothing when the body came from in front of the app', () => {
    expect(authErrorCode(EDGE_ERROR)).toBe('')
    expect(authErrorCode(EDGE_ERROR).startsWith('USER_ALREADY_EXISTS')).toBe(false)
  })

  it('matches nothing when the body carried no code at all', () => {
    expect(authErrorCode({ message: 'Too many requests. Please try again later.' })).toBe('')
  })
})

describe('authErrorMessage', () => {
  it('passes the message our API sent through', () => {
    expect(
      authErrorMessage({ code: 'PASSWORD_TOO_SHORT', message: 'Password too short' }, 'fallback', 'unreachable'),
    ).toBe('Password too short')
  })

  it('replaces infrastructure wording a person cannot act on', () => {
    expect(authErrorMessage(EDGE_ERROR, 'fallback', 'doop could not be reached')).toBe('doop could not be reached')
  })

  it('falls back when there is no message', () => {
    expect(authErrorMessage({}, 'Something went wrong', 'unreachable')).toBe('Something went wrong')
  })
})
