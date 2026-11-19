import { describe, expect, it } from 'vitest'
import { withoutSignInError } from '../shared/signInPath.ts'

describe('withoutSignInError', () => {
  it('drops a provider error and keeps an interrupted authorize request', () => {
    expect(withoutSignInError('?client_id=a&response_type=code&error=access_denied&error_description=no')).toBe(
      '?client_id=a&response_type=code',
    )
  })

  it('returns nothing when only the error was there', () => {
    expect(withoutSignInError('?error=access_denied')).toBe('')
    expect(withoutSignInError('')).toBe('')
  })
})
