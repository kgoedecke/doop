# Contributing

## Contributor License Agreement

First-time contributors are asked to sign our [CLA](CLA.md) — a bot comments on
your first pull request and signing is a single reply
(`I have read the CLA Document and I hereby sign the CLA`). In short: **you keep
the copyright to your work** and grant the maintainer the right to distribute it
under other terms too (e.g. a commercial license). The released code stays
AGPL-3.0; the CLA is what keeps dual-licensing possible without chasing every
past contributor. Unsigned PRs can't be merged.

## Commit messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org/), enforced by commitlint via a git hook:

```
feat: add frame snap guides
fix(server): close stale websocket rooms
chore: bump dependencies
```

Common types: `feat`, `fix`, `chore`, `refactor`, `style`, `docs`, `test`, `ci`, `perf`.

## Code style

- **Prettier** formats everything (`bun run format`); no semicolons, single quotes, 120 columns.
- **ESLint** (`bun run lint`) covers TS + React hooks. Warnings are tolerated tech debt; errors block.
- **`bun run typecheck`** must pass.

A pre-commit hook (husky + lint-staged) runs ESLint and Prettier on staged files, and a commit-msg hook validates the message. Hooks install automatically via `bun install` (the `prepare` script).

CI runs typecheck, lint, format check, and build on every push and PR.

## Hosted Claude runtime

The Cantelop service lives in `cantelop/`, a Bun workspace sharing the root
lockfile and SDK installation.
Run `bun install --frozen-lockfile` and `bun run cantelop:build` before root type checking,
tests, development or Docker builds. The build uses the Cantelop CLI and Docker to
qualify the service and generate Doop's backend client. Ordinary Doop commands
reuse that client; rebuild after changing the service definition or SDK.
Run `bun run cantelop:check` and `bun run cantelop:test` for the service checks.
See [the service README](cantelop/README.md) for configuration and deployment.

For live testing, configure your own backend environment, run `cantelop login`
and `bun run cantelop:deploy`. Preserve the existing App name and Workspace namespace.
