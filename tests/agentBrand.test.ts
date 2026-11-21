import { describe, expect, it } from 'vitest'
import { AGENT_BRANDS, agentBrandOf, brandMarkOf, isAgentBrandChoice, resolveAgentBrand } from '../shared/agentBrand'

describe('agentBrandOf', () => {
  /* client names as agents send them in initialize (agent_connected in PostHog) */
  it.each([
    ['claude-code', 'claude'],
    ['Anthropic/ClaudeAI', 'claude'],
    ['claude-ai (via mcp-remote 0.15.1)', 'claude'],
    ['codex-mcp-client', 'openai'],
    ['openai-mcp (Codex)', 'openai'],
    ['openai-mcp', 'openai'],
    ['Cursor', 'cursor'],
    ['cursor-vscode', 'cursor'],
    ['Cursor MCP Availability', 'cursor'],
    ['antigravity-client (via mcp-remote 0.16.5)', 'gemini'],
    ['Gemini', 'gemini'],
    ['copilot-cli', 'github'],
    ['kimi-code', 'kimi'],
    ['Visual Studio Code', 'microsoft'],
    ['deepseek-mcp', 'deepseek'],
    ['DeepSeek', 'deepseek'],
    ['deepseek-r1 (via mcp-remote 0.16.5)', 'deepseek'],
    ['grok-shell-doop', 'grok'],
    ['Grok rail', 'grok'],
    ['opencode', 'opencode'],
    ['pi', 'pi'],
    ['pi-mcp-doop', 'pi'],
  ] as const)('reads %s as %s', (client, brand) => {
    expect(agentBrandOf(client)).toBe(brand)
  })

  it.each(['mcp', 'rmcp', 'api-client', 'pipeline', 'ngrok', 'Bau', 'Doop', ''])('places %s nowhere', (client) => {
    expect(agentBrandOf(client)).toBeUndefined()
  })
})

describe('resolveAgentBrand', () => {
  it('takes the client over the name the agent chose', () => {
    expect(resolveAgentBrand('Cursor', 'Bau')).toBe('cursor')
    expect(resolveAgentBrand('claude-code', 'Codex reviewer')).toBe('claude')
  })

  it('falls back to the name when the client says nothing', () => {
    expect(resolveAgentBrand('mcp', 'Claude')).toBe('claude')
    expect(resolveAgentBrand(undefined, 'Bau')).toBeUndefined()
  })
})

describe('isAgentBrandChoice', () => {
  /* every product mark a user may store, plus the opt-out */
  it.each([...AGENT_BRANDS, 'doop'] as const)('accepts %s', (choice) => {
    expect(isAgentBrandChoice(choice)).toBe(true)
  })

  it.each([null, undefined, '', 'nope', 'Cursor'])('refuses %s', (value) => {
    expect(isAgentBrandChoice(value)).toBe(false)
  })
})

describe('brandMarkOf', () => {
  it('draws no product mark for the opt-out or for automatic', () => {
    expect(brandMarkOf('doop')).toBeUndefined()
    expect(brandMarkOf(undefined)).toBeUndefined()
  })

  it.each(AGENT_BRANDS)('draws %s as its own mark', (brand) => {
    expect(brandMarkOf(brand)).toBe(brand)
  })
})
