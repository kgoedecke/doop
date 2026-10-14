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

The service in `cantelop/` shares the root Bun workspace. Follow the
[setup guide](README.md#set-up-your-own-hosted-claude-service) to build the generated
client before development, type checking, tests or Docker builds. Rebuild after
changing the App definition or SDK. `bun run cantelop:check` typechecks the service;
root tests cover Doop's integration. CI smoke-tests the CLI-built runtime image.
