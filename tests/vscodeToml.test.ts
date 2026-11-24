import { describe, expect, it } from 'vitest'
import { tableName, withoutTable } from '../vscode-extension/src/toml.ts'

/* The editor extension rewrites only Doop's table of Codex's config.toml
   (vscode-extension/src/toml.ts): every way a person may have spelt its
   header has to be found, or a second table makes the file invalid. */

describe('tableName', () => {
  it('reads every spelling of a header', () => {
    expect(tableName('[mcp_servers.doop]')).toBe('mcp_servers.doop')
    expect(tableName('[mcp_servers.doop]   # added by hand')).toBe('mcp_servers.doop')
    expect(tableName('[mcp_servers."doop"]')).toBe('mcp_servers.doop')
    expect(tableName("[ mcp_servers . 'doop' . env ]")).toBe('mcp_servers.doop.env')
    expect(tableName('[[mcp_servers.doop]]')).toBe('mcp_servers.doop')
  })

  it('is null for anything that is not a header', () => {
    for (const line of ['url = "x"', 'args = ["a", "b"]', '# [mcp_servers.doop]', '', 'x = [1]'])
      expect(tableName(line), line).toBeNull()
  })
})

describe('withoutTable', () => {
  it('drops the table and its sub-tables, whatever its header looks like, and keeps the rest', () => {
    const text = [
      'model = "gpt-5"',
      '',
      '[mcp_servers."doop"] # mine',
      'url = "old"',
      '',
      '[mcp_servers.doop.env]',
      'A = "1"',
      '',
      '[mcp_servers.other]',
      'command = "x"',
      '',
    ].join('\n')
    expect(withoutTable(text, 'mcp_servers.doop')).toBe(
      ['model = "gpt-5"', '', '[mcp_servers.other]', 'command = "x"'].join('\n'),
    )
  })

  it('leaves a file without the table as it was', () => {
    expect(withoutTable('a = 1\n\n[b]\nc = 2\n\n', 'mcp_servers.doop')).toBe('a = 1\n\n[b]\nc = 2')
  })
})
