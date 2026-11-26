import { describe, expect, it } from 'vitest'
import { nodeVersionProblem } from './nodeVersion.ts'

describe('nodeVersionProblem', () => {
  it('accepts the version .node-version names, with or without its v', () => {
    expect(nodeVersionProblem('26.13.1\n', 'v26.13.1')).toBeNull()
    expect(nodeVersionProblem('v26.13.1', '26.13.1')).toBeNull()
  })

  it('accepts a later release of the same major', () => {
    expect(nodeVersionProblem('26.13.1', 'v26.13.2')).toBeNull()
    expect(nodeVersionProblem('26.13.1', 'v26.20.0')).toBeNull()
  })

  it('refuses an earlier release of the same major', () => {
    expect(nodeVersionProblem('26.13.1', 'v26.12.1')).toContain('this is Node 26.12.1')
  })

  it('refuses another major, older or newer, and says how to switch', () => {
    const problem = nodeVersionProblem('26.13.1', 'v24.21.0')
    expect(problem).toContain('need Node 26 (26.13.1 or later')
    expect(problem).toContain('nvm use 26.13.1')
    expect(nodeVersionProblem('26.13.1', 'v27.0.0')).not.toBeNull()
  })

  it('stays out of the way when a version cannot be read', () => {
    expect(nodeVersionProblem('lts/*', 'v26.13.1')).toBeNull()
  })
})
