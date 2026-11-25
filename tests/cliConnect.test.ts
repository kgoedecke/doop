import { describe, expect, it } from 'vitest'
import {
  cliCallbackURL,
  cliConnectURL,
  cliMachineName,
  parseCliConnect,
  parseCliConnectQuery,
} from '../shared/cliConnect.ts'

/* The link rules of the doop CLI's browser sign-in (shared/cliConnect.ts). */

const STATE = '0123456789abcdef0123456789abcdef'
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'

describe('parseCliConnect', () => {
  it('takes a request from the CLI, with or without a port to come back to', () => {
    expect(parseCliConnect({ state: STATE, challenge: CHALLENGE, name: 'mac', port: 53124 })).toEqual({
      state: STATE,
      challenge: CHALLENGE,
      name: 'mac',
      port: 53124,
    })
    expect(parseCliConnect({ state: STATE, challenge: CHALLENGE, name: 'mac' })).toEqual({
      state: STATE,
      challenge: CHALLENGE,
      name: 'mac',
    })
  })

  it('refuses a request that is incomplete or names a port it should not', () => {
    for (const bad of [
      { challenge: CHALLENGE, name: 'mac' },
      { state: 'short', challenge: CHALLENGE },
      { state: STATE, challenge: 'not-a-hash' },
      { state: STATE, challenge: CHALLENGE, port: 80 },
      { state: STATE, challenge: CHALLENGE, port: 70000 },
      { state: STATE, challenge: CHALLENGE, port: '8080@evil.test' },
      { state: STATE, challenge: CHALLENGE, port: 1.5 },
    ])
      expect(parseCliConnect(bad), JSON.stringify(bad)).toBeNull()
  })

  it('reads the page’s query the way the CLI wrote it', () => {
    const request = { state: STATE, challenge: CHALLENGE, name: 'Kevin’s MacBook', port: 40123 }
    const url = new URL(cliConnectURL('https://doop.design', request))
    expect(url.origin + url.pathname).toBe('https://doop.design/cli/connect')
    expect(parseCliConnectQuery(url.search)).toEqual(request)
  })
})

describe('cliCallbackURL', () => {
  it('goes to this machine’s loopback address and nowhere else', () => {
    const url = new URL(cliCallbackURL({ state: STATE, challenge: CHALLENGE, name: 'mac', port: 40123 }, 'the-code')!)
    expect(url.origin).toBe('http://127.0.0.1:40123')
    expect(url.pathname).toBe('/callback')
    expect(Object.fromEntries(url.searchParams)).toEqual({ code: 'the-code', state: STATE })
  })

  it('has no address when the code is pasted', () => {
    expect(cliCallbackURL({ state: STATE, challenge: CHALLENGE, name: 'mac' }, 'the-code')).toBeNull()
  })
})

describe('cliMachineName', () => {
  it('keeps a name printable, on one line and short', () => {
    expect(cliMachineName('  build\nbox\t01  ')).toBe('build box 01')
    expect(cliMachineName('x'.repeat(200))).toHaveLength(40)
    expect(cliMachineName('')).toBe('this computer')
    /* cut between characters, never through one */
    expect(cliMachineName(`${'x'.repeat(39)}🙂tail`)).toBe(`${'x'.repeat(39)}🙂`)
  })
})
