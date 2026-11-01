import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { CliError, packageRoot, readJson, writeJson } from './runtime.mjs'

const clients = ['codex', 'claude', 'cursor', 'opencode']
function clientName(value) {
  if (!clients.includes(value)) throw new CliError(`Choose --client ${clients.join('|')}.`)
  return value
}

/** Connect local MCP clients to the existing Doop OAuth endpoint. */
export function pair(base, values) {
  const url = `${base}/mcp`
  if (!values.client)
    return {
      url,
      login: base,
      authentication: 'MCP OAuth; sign in using the client Connect flow',
      clients,
      next: 'Run doop pair --client NAME to write that client configuration. Remote pairing/tunnels are not enabled.',
    }
  const client = clientName(values.client)
  const folder = values.directory ? path.resolve(values.directory) : homedir()
  let file
  if (client === 'codex') {
    file = path.join(folder, '.codex/config.toml')
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
    if (/^\[mcp_servers\.doop\]/m.test(existing))
      throw new CliError(
        'A Codex doop entry already exists. Edit that entry explicitly to avoid overwriting other settings.',
      )
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `${existing}\n[mcp_servers.doop]\nurl = ${JSON.stringify(url)}\n`, { mode: 0o600 })
  } else {
    file = path.join(
      folder,
      client === 'claude'
        ? '.claude.json'
        : client === 'cursor'
          ? '.cursor/mcp.json'
          : '.config/opencode/opencode.json',
    )
    const config = readJson(file, {})
    const key = client === 'opencode' ? 'mcp' : 'mcpServers'
    config[key] ??= {}
    if (config[key].doop && !values.force)
      throw new CliError('A doop MCP entry already exists. Use --force to replace only that entry.')
    config[key].doop = client === 'opencode' ? { type: 'remote', url, enabled: true } : { type: 'http', url }
    writeJson(file, config)
  }
  return {
    paired: true,
    client,
    file,
    url,
    authentication: 'Complete MCP OAuth sign-in in the client before using tools.',
  }
}

/** Install the bundled skill without silently overwriting an existing skill. */
export function skill(action, values) {
  const source = path.join(packageRoot, 'cli/skills/doop/SKILL.md')
  if (action === 'list')
    return [{ name: 'doop', description: 'Use the local Doop canvas through MCP and the CLI API.' }]
  if (action === 'show') return readFileSync(source, 'utf8')
  if (action !== 'install') throw new CliError('Unknown skill command. Use list, show or install.')
  const client = clientName(values.client || 'codex')
  const folder = values.directory ? path.resolve(values.directory) : homedir()
  const relative = {
    codex: '.agents/skills',
    claude: '.claude/skills',
    cursor: '.cursor/skills',
    opencode: '.config/opencode/skills',
  }[client]
  const file = path.join(folder, relative, 'doop/SKILL.md')
  if (existsSync(file) && !values.force) throw new CliError('The Doop skill already exists. Use --force to replace it.')
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, readFileSync(source))
  return { installed: true, client, file }
}
