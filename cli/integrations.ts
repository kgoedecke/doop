import { Effect, FileSystem, Path, Schema } from 'effect'
import { homedir } from 'node:os'
import { Configuration } from './config.ts'
import { readJson, writeJson } from './files.ts'
import { ConfigurationError, JsonObject, type Options, StorageError } from './model.ts'

const clients = ['codex', 'claude', 'cursor', 'opencode'] as const
const Client = Schema.Literals(clients)
const parseClient = (value: string) =>
  Schema.decodeUnknownEffect(Client)(value).pipe(
    Effect.mapError(
      () => new ConfigurationError({ operation: 'client', message: `Choose --client ${clients.join('|')}.` }),
    ),
  )

/** Preserve unrelated client settings while adding a local MCP OAuth endpoint. */
export const pair = Effect.fn('Integrations.pair')(
  function* (base: string, options: Options) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const url = `${base}/mcp`
    if (!options.client)
      return {
        url,
        login: base,
        authentication: 'MCP OAuth; sign in using the client Connect flow',
        clients,
        next: 'Run doop pair --client NAME to configure a local client. Remote pairing is not enabled.',
      }
    const client = yield* parseClient(options.client)
    const folder = options.directory ? path.resolve(options.directory) : homedir()
    const file = path.join(
      folder,
      client === 'codex'
        ? '.codex/config.toml'
        : client === 'claude'
          ? '.claude.json'
          : client === 'cursor'
            ? '.cursor/mcp.json'
            : '.config/opencode/opencode.json',
    )
    yield* fs.makeDirectory(path.dirname(file), { recursive: true })
    if (client === 'codex') {
      const existing = (yield* fs.exists(file)) ? yield* fs.readFileString(file) : ''
      if (/^\[mcp_servers\.doop\]/m.test(existing))
        return yield* new ConfigurationError({
          operation: 'pair',
          message: 'A Codex doop entry already exists. Edit it explicitly to preserve other settings.',
        })
      yield* fs.writeFileString(file, `${existing}\n[mcp_servers.doop]\nurl = ${JSON.stringify(url)}\n`, {
        mode: 0o600,
      })
    } else {
      const config = yield* readJson(file, JsonObject, {})
      const key = client === 'opencode' ? 'mcp' : 'mcpServers'
      const servers = config[key] === undefined ? {} : yield* Schema.decodeUnknownEffect(JsonObject)(config[key])
      if (servers.doop && !options.force)
        return yield* new ConfigurationError({
          operation: 'pair',
          message: 'A doop MCP entry already exists. Use --force to replace only that entry.',
        })
      yield* writeJson(file, JsonObject, {
        ...config,
        [key]: {
          ...servers,
          doop: client === 'opencode' ? { type: 'remote', url, enabled: true } : { type: 'http', url },
        },
      })
    }
    return {
      paired: true,
      client,
      file,
      url,
      authentication: 'Complete MCP OAuth sign-in in the client before using tools.',
    }
  },
  Effect.mapError((error) =>
    error instanceof ConfigurationError || error instanceof StorageError
      ? error
      : new StorageError({ operation: 'pair', message: 'Cannot update the client configuration.' }),
  ),
)

/** Install the bundled skill through Effect filesystem operations without implicit replacement. */
export const skill = Effect.fn('Integrations.skill')(
  function* (action: string, options: Options) {
    const config = yield* Configuration
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const source = path.join(config.root, 'cli/skills/doop/SKILL.md')
    if (action === 'list')
      return [{ name: 'doop', description: 'Use the local Doop canvas through MCP and the CLI API.' }]
    if (action === 'show') return yield* fs.readFileString(source)
    if (action !== 'install')
      return yield* new ConfigurationError({
        operation: 'skill',
        message: 'Unknown skill command. Use list, show or install.',
      })
    const client = yield* parseClient(options.client || 'codex')
    const folder = options.directory ? path.resolve(options.directory) : homedir()
    const relative = {
      codex: '.agents/skills',
      claude: '.claude/skills',
      cursor: '.cursor/skills',
      opencode: '.config/opencode/skills',
    }[client]
    const file = path.join(folder, relative, 'doop/SKILL.md')
    if ((yield* fs.exists(file)) && !options.force)
      return yield* new ConfigurationError({
        operation: 'skill',
        message: 'The Doop skill already exists. Use --force to replace it.',
      })
    yield* fs.makeDirectory(path.dirname(file), { recursive: true })
    yield* fs.writeFileString(file, yield* fs.readFileString(source))
    return { installed: true, client, file }
  },
  Effect.mapError((error) =>
    error instanceof ConfigurationError
      ? error
      : new StorageError({ operation: 'skill', message: 'Cannot read or install the bundled Doop skill.' }),
  ),
)
