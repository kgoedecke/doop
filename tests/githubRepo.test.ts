import { describe, expect, it } from 'vitest'
import { branchCandidates, parseRepoRef } from '../shared/githubRepo'

describe('parseRepoRef', () => {
  it.each([
    ['owner/repo', { repo: 'owner/repo' }],
    ['https://github.com/kgoedecke/doop', { repo: 'kgoedecke/doop' }],
    ['https://www.github.com/kgoedecke/doop/', { repo: 'kgoedecke/doop' }],
    ['github.com/kgoedecke/doop', { repo: 'kgoedecke/doop' }],
    ['https://github.com/kgoedecke/doop.git', { repo: 'kgoedecke/doop' }],
    ['git@github.com:kgoedecke/doop.git', { repo: 'kgoedecke/doop' }],
    ['https://github.com/kgoedecke/doop?tab=readme#top', { repo: 'kgoedecke/doop' }],
    ['https://github.com/kgoedecke/doop/tree/next', { repo: 'kgoedecke/doop', treePath: ['next'] }],
    [
      'https://github.com/acme/app/tree/feature/login-redesign',
      { repo: 'acme/app', treePath: ['feature', 'login-redesign'] },
    ],
    ['https://github.com/acme/app/tree/a%2Fb', { repo: 'acme/app', treePath: ['a/b'] }],
    ['https://github.com/o/r/blob/feature-x/src/App.tsx', { repo: 'o/r', treePath: ['feature-x', 'src', 'App.tsx'] }],
    ['  https://github.com/kgoedecke/doop/pulls  ', { repo: 'kgoedecke/doop' }],
  ])('reads %s', (input, expected) => {
    expect(parseRepoRef(input)).toEqual(expected)
  })

  it.each([
    '',
    'doop',
    'https://github.com/kgoedecke',
    'https://gitlab.com/a/b/c',
    'gitlab.com/acme/app',
    'https://github.com/orgs/acme/repositories',
    'https://github.com/settings/tokens',
    'own er/repo',
    'https://github.com/a/b/tree/50%off',
    'https://github.com/o/r/tree/..',
    'https://github.com/o/r/tree/main/./src',
  ])('refuses %j', (input) => {
    expect(parseRepoRef(input)).toBeNull()
  })
})

describe('branchCandidates', () => {
  it('tries the longest prefix first', () => {
    expect(branchCandidates(['feature', 'login', 'src'])).toEqual(['feature/login/src', 'feature/login', 'feature'])
  })
})
