import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import * as vscode from 'vscode'
import type { Auth } from './auth.ts'
import { withoutTable } from './toml.ts'
import { canvasUrl, serverUrl } from './server.ts'

/* Coding agents get Doop the way they get any MCP server: the remote /mcp
   endpoint, signed in with the extension's agent key, so there is no OAuth
   round trip per agent and the agent designs as the person signed in here.

   - This editor's own agent mode (Copilot and anything reading VS Code's MCP
     servers) gets it through the MCP server definition provider, live: it
     follows sign-in, sign-out and the server setting.
   - Other agents (Claude Code, Codex, Cursor, Gemini CLI, Windsurf) read
     their own config files. "Connect Coding Agents…" writes the `doop` entry
     into the ones the person picks, and nothing else in those files. */

const SERVER_NAME = 'doop'

export class DoopMcpProvider implements vscode.McpServerDefinitionProvider<vscode.McpHttpServerDefinition> {
  private readonly changed = new vscode.EventEmitter<void>()
  readonly onDidChangeMcpServerDefinitions = this.changed.event

  constructor(private readonly auth: Auth) {
    auth.onDidChange(() => this.changed.fire())
  }

  refresh(): void {
    this.changed.fire()
  }

  async provideMcpServerDefinitions(): Promise<vscode.McpHttpServerDefinition[]> {
    if (!vscode.workspace.getConfiguration('doop').get<boolean>('registerMcpServer', true)) return []
    const key = await this.auth.key()
    if (!key) return []
    return [
      new vscode.McpHttpServerDefinition('Doop', vscode.Uri.parse(`${serverUrl()}/mcp`), {
        Authorization: `Bearer ${key}`,
      }),
    ]
  }
}

interface AgentTarget {
  id: string
  label: string
  file: string
  /** this agent appears to be installed: its config folder exists */
  present: () => boolean
  write: (url: string, key: string) => Promise<void>
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  if (!existsSync(file)) return {}
  const text = (await readFile(file, 'utf8')).trim()
  if (!text) return {}
  const parsed: unknown = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${file} is not a JSON object`)
  return parsed as Record<string, unknown>
}

/** Sets `root[section].doop` and writes the file back, leaving everything else as it was. */
async function writeJsonEntry(file: string, section: string, entry: Record<string, unknown>): Promise<void> {
  const config = await readJson(file)
  const servers = (config[section] && typeof config[section] === 'object' ? config[section] : {}) as Record<
    string,
    unknown
  >
  config[section] = { ...servers, [SERVER_NAME]: entry }
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
}

function claudeCli(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('claude', args, { timeout: 20_000 }, (err) => (err ? reject(err) : resolve()))
  })
}

const tomlString = (value: string) => JSON.stringify(value)

/** Codex's config.toml: replaces the [mcp_servers.doop] table (and its sub-tables) or appends one. */
async function writeCodex(file: string, url: string, key: string): Promise<void> {
  const text = existsSync(file) ? await readFile(file, 'utf8') : ''
  const table = [
    `[mcp_servers.${SERVER_NAME}]`,
    `url = ${tomlString(url)}`,
    `http_headers = { Authorization = ${tomlString(`Bearer ${key}`)} }`,
    '',
  ].join('\n')
  const body = withoutTable(text, `mcp_servers.${SERVER_NAME}`)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${body ? `${body}\n\n` : ''}${table}`, { mode: 0o600 })
}

function targets(): AgentTarget[] {
  const home = homedir()
  const headers = (key: string) => ({ Authorization: `Bearer ${key}` })
  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      file: join(home, '.claude.json'),
      present: () => existsSync(join(home, '.claude.json')) || existsSync(join(home, '.claude')),
      /* Claude Code rewrites ~/.claude.json while it runs, so its own CLI writes the
         entry when it is on the PATH; the file is the fallback */
      write: async (url, key) => {
        const viaCli = await claudeCli(['mcp', 'remove', '--scope', 'user', SERVER_NAME])
          .catch(() => null)
          .then(() =>
            claudeCli([
              'mcp',
              'add',
              '--transport',
              'http',
              '--scope',
              'user',
              SERVER_NAME,
              url,
              '--header',
              `Authorization: Bearer ${key}`,
            ]),
          )
          .then(
            () => true,
            () => false,
          )
        if (!viaCli)
          await writeJsonEntry(join(home, '.claude.json'), 'mcpServers', { type: 'http', url, headers: headers(key) })
      },
    },
    {
      id: 'codex',
      label: 'Codex',
      file: join(home, '.codex', 'config.toml'),
      present: () => existsSync(join(home, '.codex')),
      write: (url, key) => writeCodex(join(home, '.codex', 'config.toml'), url, key),
    },
    {
      id: 'cursor',
      label: 'Cursor',
      file: join(home, '.cursor', 'mcp.json'),
      present: () => existsSync(join(home, '.cursor')),
      write: (url, key) =>
        writeJsonEntry(join(home, '.cursor', 'mcp.json'), 'mcpServers', { url, headers: headers(key) }),
    },
    {
      id: 'gemini',
      label: 'Gemini CLI',
      file: join(home, '.gemini', 'settings.json'),
      present: () => existsSync(join(home, '.gemini')),
      write: (url, key) =>
        writeJsonEntry(join(home, '.gemini', 'settings.json'), 'mcpServers', { httpUrl: url, headers: headers(key) }),
    },
    {
      id: 'windsurf',
      label: 'Windsurf',
      file: join(home, '.codeium', 'windsurf', 'mcp_config.json'),
      present: () => existsSync(join(home, '.codeium', 'windsurf')),
      write: (url, key) =>
        writeJsonEntry(join(home, '.codeium', 'windsurf', 'mcp_config.json'), 'mcpServers', {
          serverUrl: url,
          headers: headers(key),
        }),
    },
  ]
}

export async function connectAgents(auth: Auth): Promise<void> {
  const key = await auth.key()
  if (!key) {
    void vscode.window.showWarningMessage('Doop: sign in first.')
    return
  }
  const url = `${serverUrl()}/mcp`
  const items = targets().map((target) => ({
    label: target.label,
    description: target.present() ? 'installed' : 'not found',
    detail: target.file.replace(homedir(), '~'),
    picked: target.present(),
    target,
  }))
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Connect coding agents to Doop',
    placeHolder: 'Adds a "doop" MCP server, signed in as you, to each agent you pick',
    canPickMany: true,
    ignoreFocusOut: true,
  })
  if (!picked?.length) return
  const done: string[] = []
  for (const { target } of picked) {
    try {
      await target.write(url, key)
      done.push(target.label)
    } catch (err) {
      void vscode.window.showErrorMessage(`Doop: could not update ${target.file}: ${(err as Error).message}`)
    }
  }
  if (done.length)
    void vscode.window.showInformationMessage(
      `Doop: connected ${done.join(', ')}. Restart a running agent session to pick it up.`,
    )
}

/** What to tell a coding agent to work on a canvas. */
export function agentPrompt(canvas: { id: string; name: string }): string {
  return `Use the Doop MCP server to work on the Doop canvas "${canvas.name}" (canvas_id: ${canvas.id}, ${canvasUrl(canvas.id)}). Call get_guide and get_canvas first, then `
}
