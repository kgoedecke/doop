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
- **oxlint** (`bun run lint`, type-aware via tsgolint) covers TS + React hooks; a slim ESLint run adds the `process.env` ban. Warnings fail CI like errors.
- **`bun run typecheck`** must pass.

A pre-commit hook (husky + lint-staged) runs ESLint and Prettier on staged files, and a commit-msg hook validates the message. Hooks install automatically via `bun install` (the `prepare` script).

CI runs typecheck, lint, format check, build and the test suite (in four shards) as parallel jobs on every push and PR.
