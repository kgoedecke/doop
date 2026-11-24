# Doop for VS Code

Your Doop canvases inside your editor. Open a canvas in a tab next to your code and watch your coding agents
design on it live: the same multiplayer canvas as in the browser, with cursors, presence, agent status and comments.

Works in VS Code and its forks (Cursor, Windsurf, VSCodium, Positron, Kiro, Trae, Antigravity).

## What it does

- **Canvases in the activity bar.** The Doop view lists your canvases, grouped by workspace, read live from your
  account. New canvas, open by search, or paste a canvas link.
- **The live canvas in a tab.** A canvas opens as an editor tab showing the Doop app itself, signed in as you.
  Reload, Open in Browser and Copy Prompt for Your Agent sit in the tab's title bar.
- **Agents design on it.** The extension offers Doop's MCP server to this editor's own agent mode (Copilot and
  any agent that reads VS Code's MCP servers), signed in as you. **Doop: Connect Coding Agents…** adds it to Claude
  Code, Codex, Cursor, Gemini CLI and Windsurf as well, touching only the `doop` entry in their config files.
  **Copy Prompt for Your Agent** puts a prompt naming the canvas on your clipboard.

Nothing is written to your workspace: canvases stay on your Doop server.

## Signing in

**Doop: Sign In** opens your browser on `/editor/connect`. Confirm there, and the browser hands a one-time code
back to the editor, which trades it for an agent key named after the editor ("VS Code extension"). The key lives
in the editor's secret storage. **Doop: Sign Out** deletes it on the server too, which signs out the canvas views
and any agents you connected with it; removing it in Doop under Settings → Connect AI does the same. **Sign In with
an Agent Key** takes a key you created there yourself instead.

A self-hosted Doop: set `doop.serverUrl`, then sign in again. Open canvas tabs close when the server changes. The
canvas view needs the server on https (or on this machine): its cookie is `Secure`.

## How the canvas view signs in

The tab is a webview whose top frame is `vscode-webview://…`, so the Doop page inside it is a third party and its
usual `SameSite=Lax` session cookie is never sent. Each time a view loads, the extension asks for a one-minute,
single-use ticket (`POST /editor/embed-ticket`, with the agent key), and the iframe opens `/editor/embed?ticket=…`,
which sets the session cookie again as `SameSite=None; Secure; Partitioned`, and only for an iframe. That cookie
lives in a jar keyed by the webview, so it signs in that one view and no other site can send it. All views of one
key share one session, which ends with the key. Server side: `server/editorConnect.ts`; shared link rules:
`shared/editorConnect.ts`.

## Settings

| Setting                  | Default               | What it does                                             |
| ------------------------ | --------------------- | -------------------------------------------------------- |
| `doop.serverUrl`         | `https://doop.design` | The Doop server; change it for a self-hosted Doop.       |
| `doop.registerMcpServer` | `true`                | Offer Doop's MCP server to this editor's own agent mode. |

## Building

From the repository root:

```bash
bun run build:vscode-extension                    # vscode-extension/out/extension.js
node scripts/build-vscode-extension.mjs --vsix    # also vscode-extension/dist/doop.vsix
code --install-extension vscode-extension/dist/doop.vsix
```

`bun run typecheck` checks the extension too. Tests: `tests/editorConnect.test.ts` (link rules) and
`tests/editorConnectHttp.test.ts` (sign-in, exchange, ticket and embed against the real server).

Publishing: bump `version` in `package.json`, merge, and push the tag `vscode-v<version>`.
`.github/workflows/vscode-extension.yml` publishes to the Visual Studio Marketplace and Open VSX (`VSCE_PAT` and
`OVSX_PAT` secrets) and attaches the VSIX to a GitHub Release. Details in `.context/RELEASE.md`.
