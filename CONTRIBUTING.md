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

The Cantelop service lives in `cantelop/` and uses a separate Bun
lockfile. Run `bun run cantelop:install` before root type checking or tests, which
include client/service contract checks. Run `bun run cantelop:check` and
`bun run cantelop:test` for its Node test suite. `bun run cantelop:build` also verifies
the deployable API and sandbox image and requires Cantelop CLI and Docker.
See [the service README](cantelop/README.md) for deployment details.

For live testing on your own Cantelop account, run `cantelop login` and
`bun run cantelop:setup`. It provisions matching configuration without another
developer's environment variables. `--prepare-only` generates files without
deploying. Setup tests use generated temporary keys and fake deployment commands.
