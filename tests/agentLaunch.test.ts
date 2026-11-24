import { describe, expect, it } from 'vitest'
import { agentLaunch, agentLaunchKind } from '../shared/agentLaunch.ts'

/* The client names agents reach Doop with (oauth_application.name). */
describe('agentLaunchKind', () => {
  it('tells Claude Code, the desktop extension and the Claude connector apart', () => {
    expect(agentLaunchKind('Claude Code (doop)')).toBe('claude-code')
    expect(agentLaunchKind('Doop for Claude Desktop')).toBe('claude-desktop')
    expect(agentLaunchKind('Claude')).toBe('claude')
    expect(agentLaunchKind('ChatGPT')).toBe('chatgpt')
    expect(agentLaunchKind('Cursor')).toBe('cursor')
    expect(agentLaunchKind('Codex')).toBe('codex')
    expect(agentLaunchKind('opencode')).toBe('other')
    expect(agentLaunchKind(undefined)).toBe('other')
  })
})

describe('agentLaunch', () => {
  const prompt = `Build Ana's cards & go`

  it('fills the prompt in, encoded, wherever a link exists', () => {
    const encoded = encodeURIComponent(prompt)
    expect(agentLaunch('Claude Code (doop)', prompt).url).toBe(`claude-cli://open?q=${encoded}`)
    expect(agentLaunch('Doop for Claude Desktop', prompt).url).toBe(`claude://claude.ai/new?q=${encoded}`)
    expect(agentLaunch('Claude', prompt).url).toBe(`https://claude.ai/new?q=${encoded}`)
    expect(agentLaunch('ChatGPT', prompt).url).toBe(`https://chatgpt.com/?q=${encoded}`)
    expect(agentLaunch('Cursor', prompt).url).toBe(`https://cursor.com/link/prompt?text=${encoded}`)
  })

  it('gives terminal agents a command with the prompt as one quoted argument', () => {
    expect(agentLaunch('Codex', prompt)).toEqual({
      kind: 'codex',
      label: 'Codex',
      command: `codex 'Build Ana'\\''s cards & go'`,
    })
    expect(agentLaunch('Claude Code (doop)', prompt).command).toBe(`claude 'Build Ana'\\''s cards & go'`)
  })

  it('leaves an agent it cannot open to copying the prompt', () => {
    expect(agentLaunch('opencode', prompt)).toEqual({ kind: 'other', label: 'your agent' })
  })
})
