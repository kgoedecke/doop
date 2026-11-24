import { describe, expect, it } from 'vitest'
import { editorCallbackURL, editorRedirect, embedTarget, parseEditorConnectQuery } from '../shared/editorConnect.ts'

/* The link rules of the editor extension's sign-in (shared/editorConnect.ts). */

const STATE = '0123456789abcdef0123456789abcdef'

describe('editorRedirect', () => {
  it('takes the deep link of every editor the extension runs in', () => {
    expect(editorRedirect('vscode://doop.doop/auth')?.editor).toBe('VS Code')
    expect(editorRedirect('cursor://doop.doop/auth')?.editor).toBe('Cursor')
    expect(editorRedirect('vscode-insiders://Doop.Doop/auth')?.editor).toBe('VS Code Insiders')
    expect(editorRedirect('vscode://doop.doop/auth?windowId=2')?.editor).toBe('VS Code')
  })

  it('refuses anything that would hand the code to someone else', () => {
    for (const bad of [
      'https://doop.design/auth',
      'https://evil.test/auth',
      'vscode://other.extension/auth',
      'vscode://doop.doop/other',
      'vscode://doop.doop.evil.test/auth',
      'vscode://user@doop.doop/auth',
      'vscode://doop.doop:80/auth',
      'javascript:alert(1)',
      'not a url',
      '',
    ])
      expect(editorRedirect(bad), bad).toBeNull()
  })
})

describe('parseEditorConnectQuery', () => {
  it('needs a state and an editor link', () => {
    const redirect = encodeURIComponent('vscode://doop.doop/auth')
    expect(parseEditorConnectQuery(`?redirect=${redirect}&state=${STATE}`)).toEqual({
      redirect: 'vscode://doop.doop/auth',
      state: STATE,
    })
    expect(parseEditorConnectQuery(`?redirect=${redirect}`)).toBeNull()
    expect(parseEditorConnectQuery(`?redirect=${redirect}&state=short`)).toBeNull()
    expect(parseEditorConnectQuery(`?redirect=https%3A%2F%2Fevil.test&state=${STATE}`)).toBeNull()
  })
})

describe('editorCallbackURL', () => {
  it('adds the code and state and keeps what the editor put on its link', () => {
    const url = new URL(editorCallbackURL({ redirect: 'vscode://doop.doop/auth?windowId=2', state: STATE }, 'c0de'))
    expect(url.protocol).toBe('vscode:')
    expect(url.pathname).toBe('/auth')
    expect(url.searchParams.get('windowId')).toBe('2')
    expect(url.searchParams.get('code')).toBe('c0de')
    expect(url.searchParams.get('state')).toBe(STATE)
  })

  it('will not build a link for a redirect that is not an editor', () => {
    expect(() => editorCallbackURL({ redirect: 'https://evil.test/auth', state: STATE }, 'c0de')).toThrow()
  })
})

describe('embedTarget', () => {
  it('keeps same-origin paths only', () => {
    expect(embedTarget('/c/abc123')).toBe('/c/abc123')
    expect(embedTarget('/c/abc123?frame=x#y')).toBe('/c/abc123?frame=x#y')
    for (const bad of ['//evil.test', '/\\evil.test', 'https://evil.test', 'c/abc', '', undefined, 42])
      expect(embedTarget(bad), String(bad)).toBeNull()
  })
})
