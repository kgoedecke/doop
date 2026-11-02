# Doop for Claude Desktop

Design with Claude on your Doop canvas. The extension connects Claude Desktop to
Doop's existing MCP server, with browser sign-in and the same canvas permissions
as your Doop account. No terminal, API key or separate Node installation is needed.

## Install

For Doop Cloud or a public HTTPS server, choose **Connect AI → Claude → Connect →
Add to Claude**. Claude opens its connector form with Doop's details filled in.
Confirm the connector and sign in to Doop. There is no file to download.

In an updated Doop desktop app on macOS or Windows, **Add to Claude** prepares the
extension in the app's cache and opens Claude's install prompt directly. The Doop
server URL is prefilled, including for localhost. Confirm in Claude and approve
the browser sign-in. This requires a shell with the `__DOOP_CLAUDE_EXTENSION__`
capability; older shells offer the online connector or manual installation.

Manual fallback:

1. In Doop, choose **Connect AI → Claude → Connect → Desktop app → Install manually → Download extension**.
2. Open `doop.mcpb` with Claude Desktop and install it. If opening the file does
   not start installation, use **Settings → Extensions → Advanced settings →
   Install Extension** in Claude and select the file.
3. Keep the default server URL for Doop Cloud, enable the extension, and approve
   the Doop connection in the browser that opens.
4. Start a new Claude chat, enable Doop in the tools menu, and paste the canvas
   prompt from Doop's connection dialog.

The extension is for Claude Desktop on macOS and Windows. Claude on the web can
also use **Customize → Connectors → Add custom connector** with
`https://doop.design/mcp` instead. Organization settings may restrict installing
custom extensions.

## Self-hosting

Set **Doop server URL** in the extension's settings to your server's `/mcp` URL,
such as `https://design.example.com/mcp` or `http://localhost:4300/mcp`. Local HTTP
is supported; other hosts need HTTPS. Doop must be running and reachable from
your computer. The web connector requires a server reachable from Claude's cloud.

## Build and validation

```sh
bun install --frozen-lockfile
bun run build:claude-extension
bun run test tests/claudeExtension.test.ts tests/claudeConnection.test.ts tests/connectModal.test.tsx
```

The build writes `public/claude-extension/doop.mcpb`, a ZIP containing the manifest,
logo, license and pinned `mcp-remote` proxy with its runtime dependencies and their
licenses. It is included automatically in `bun run dev` and `bun run build`, so
Vite and the production server serve the download at `/claude-extension/doop.mcpb`.
No additional packages are fetched when Claude installs or starts the extension. Claude
Desktop supplies the Node runtime (20.18.1 or newer).
The packager supports both Node and Bun. It resolves installed package directories
directly so Bun's built-in modules do not replace runtime dependencies in the archive.

The proxy forwards MCP tools, resources and server instructions over Streamable
HTTP and handles OAuth registration, PKCE sign-in and token refresh. Credentials
are stored locally by `mcp-remote` under `~/.mcp-auth`, not in the extension or the
Doop download. Disable or remove the extension in Claude's settings to stop it
connecting. Removing the extension does not remove the proxy's separate OAuth cache.

Before releasing, install the built file in Claude Desktop on macOS and Windows,
complete browser sign-in, and create a frame on a test canvas. Check reconnecting
after restarting Claude and connecting to a self-hosted server. The automated
smoke test runs the extracted download in an isolated directory and exercises its
MCP transport, OAuth sign-in, consent and reconnection; it does not replace this native installation check. Directory
listing or signing is a separate release step; this package can be installed
directly without a directory listing.

Format: [MCP Bundles](https://github.com/modelcontextprotocol/mcpb).
Proxy: [mcp-remote](https://github.com/punkpeye/mcp-remote).
Online setup: [Claude's documented install links](https://claude.com/docs/connectors/building/directory-vs-custom#share-an-install-link).
