# Local Doop CLI (private preview)

Requires Node.js 22.19 or newer and npm. This is a private development preview,
not a published registry package. Install the generated tarball:

```sh
npm install -g ./killzonegaming-doop-cli-0.12.0-cli.2.tgz
doop start
```

Open the printed local URL after the server ready message and create a local
account. Connect agents through the app's Connect AI flow or its `/mcp` endpoint.
Authentication and MCP permissions remain enabled. Editing and connecting an
existing MCP agent require no external model key.

The CLI is implemented in TypeScript with Effect 4. Configuration, process
execution, server startup, service management and authenticated HTTP access are
explicit services composed through Layers. Schemas validate persisted settings
and control messages; credentials remain redacted until an adapter needs them.
Scopes own backend processes, control connections, log streams and heartbeat
locks, including cleanup on interruption. The existing Doop web application runs
behind the backend process adapter.

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

Only one instance may use a data directory. The backend and supervisor use
heartbeat locks, which expire after ten seconds without a heartbeat following a
forced termination. Retry startup after that grace period; PID reuse does not
establish ownership. Do not manually remove a live lock. Legacy preview locks
containing `pid` or `owner.json` metadata require stopping the old CLI first;
remove a stale legacy directory only after verifying the old process has stopped.

Existing server environment variables configure external integrations. The CLI
sets production mode, loopback host, port, authentication origin and key itself.
Other inherited settings, including DATABASE_URL and object storage, still apply.
Set shell variables before starting; the CLI does not load .env files. External
APIs need credentials and connectivity. Screenshot/PDF rendering requires a
supported local Chrome/Chromium installation. Desktop UI integration and remote
tunnels are follow-up work.

## Command groups

The command/handler split and shared service model follow the inspected
[`@opencode/cli` v2.2.5](https://github.com/anomalyco/opencode/tree/v2.2.5/packages/cli).
Doop retains its existing Node backend instead of adopting OpenCode's server or
terminal UI implementation.

```sh
doop service install --port 4400
doop service start
doop service status --json
doop api GET /healthz
doop auth login
doop api GET /api/canvases
doop api POST /api/canvases --data '{"name":"My canvas"}'
doop reload
doop service stop
```

`service` alone shows status. `service restart` stops and starts the managed
backend. `service uninstall` stops it and removes registration, retaining all
canvases, assets and account data. The service is a detached per-user supervisor;
it does not require an elevated Windows Service or root daemon. A private named
pipe (Windows) or permission-restricted Unix socket handles authenticated control.
Saved process IDs are never used to terminate an unverified process.

Add `--autostart` to `service install` for current-user login startup through
Windows Task Scheduler, macOS launchd or Linux systemd user services. This requires
a working user session/service manager and permission to register user jobs.
Ordinary install does not change login startup. Uninstall removes that registration.
Stopping a service does not uninstall its next-login registration. Reinstall after
moving the CLI installation so startup references the new executable location.

`reload` restarts the managed backend, preserving its selected port when configured
with port 0. It rereads persistent service settings. It cannot import new variables
from another terminal into the already-running supervisor: stop and start the
service from the new environment for that. Service output is in `service.log`.

`api` accepts a path (GET by default) or a method and path. `--data @file.json`
loads a JSON body from a file. `--server http://127.0.0.1:PORT` targets a foreground
instance instead of the managed service. Requests retain normal server permissions.
External URLs in API paths and automatic redirect following are rejected.

`auth login` signs into an existing local account, prompting privately for its
password. For automation, use `--email ADDRESS --password-stdin` and provide the
password on standard input, never as an argument. Create an account in the app
first. `auth status`/`whoami` show the current user; `auth logout` revokes the
session. The private `cli-session.json` stores a cookie scoped to the exact server
origin, not the password. CLI account login and agent MCP OAuth are separate.

```sh
doop pair
doop pair --client codex
doop skill list
doop skill show
doop skill install --client codex
doop doctor --json
doop debug paths
doop debug config
doop debug logs
```

`pair --client codex|claude|cursor|opencode` writes that client's MCP configuration
and uses its normal OAuth connection flow. It does not produce OpenCode-style
one-time remote pairing links. `--directory PATH` uses an alternate home/config
root (useful for isolated setup). Existing entries are preserved; JSON client
entries may be replaced with `--force`. Existing Codex TOML entries require an
explicit edit. No OAuth sign-in is silently approved on the user's behalf.

`skill install` installs the bundled Doop skill for the selected client under the
same alternate root, refusing replacement unless `--force` is supplied. The skill
guides agents through the existing MCP guide and authenticated CLI API.

Doctor checks the Node version, frontend and migration assets, directory access,
and the running service's health. A stopped service is valid. Failed required
checks return a nonzero exit status. Debug config omits session and service keys;
debug logs prints a bounded tail of raw backend logs, which can include user data.

```sh
doop upgrade ./new-doop-cli.tgz --dry-run
doop update ./new-doop-cli.tgz
```

`update` and `upgrade` are aliases. They use npm, stop the managed service before
replacement, and preserve its data. Start it with the upgraded executable after
installation. `--prefix PATH` installs into a separate npm prefix. A source
checkout cannot replace itself. Bare registry upgrades remain unavailable until
the private preview is published; local tarball upgrades work now. Direct runtime
dependencies are pinned to the versions installed from the repository lockfile.

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
