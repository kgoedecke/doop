# Local Doop CLI (private preview)

Requires Node.js 22.19 or newer and npm. This is a private development preview,
not a published registry package. Install the generated tarball:

```sh
npm install -g ./killzonegaming-doop-cli-0.12.0-cli.0.tgz
doop start
```

Open the printed local URL after the server ready message and create a local
account. Connect agents through the app's Connect AI flow or its `/mcp` endpoint.
Authentication and MCP permissions remain enabled. Editing and connecting an
existing MCP agent require no external model key.

`doop start --port 0` selects an available port; use a fixed port for saved MCP
connections. `--port 4401` selects a specific port. The CLI always binds to
127.0.0.1. It runs in the foreground; Ctrl+C flushes pending writes and stops it.

`--data-dir <directory>` overrides the default data root:

- Windows: `%LOCALAPPDATA%/Doop`
- macOS: `~/Library/Application Support/Doop`
- Linux: `$XDG_DATA_HOME/doop` or `~/.local/share/doop`

The root contains `data/pg`, `data/assets` and a generated `local-auth.json` session
signing key. Treat it as private. Back up the whole directory while stopped,
including the key, and restore as a unit. Upgrades apply existing migrations at
startup; back up before upgrading. Install the next tarball and restart with the
same data directory.

Only one instance may use a data directory. After forced termination, check the
`pid` file in `.doop-lock` and ensure no instance is running before manually
removing that stale lock directory. Do not remove a live lock.

Existing server environment variables configure external integrations. The CLI
sets production mode, loopback host, port, authentication origin and key itself.
Other inherited settings, including DATABASE_URL and object storage, still apply.
Set shell variables before starting; the CLI does not load .env files. External
APIs need credentials and connectivity. Screenshot/PDF rendering requires a
supported local Chrome/Chromium installation. Desktop integration, background
services and tunnels are follow-up work.

## Build and verify

From the repository, with Bun and Node installed:

```sh
bun install --frozen-lockfile
npm run build:cli
npm run test:cli
```

The build stages runtime sources, frontend assets and migrations in `cli-package/`.
The smoke test packs it, installs it into an isolated temporary npm project, and
exercises the installed app. The preview package has `private: true` to prevent
accidental registry publication.
