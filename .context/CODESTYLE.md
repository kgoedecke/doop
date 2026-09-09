# CODESTYLE - doop

## Formatting (Prettier, `.prettierrc.json`)

- No semicolons (`semi: false`).
- Single quotes (`singleQuote: true`).
- Print width 120.
- Trailing commas everywhere (`trailingComma: all`).
- Run `bun run format` to write, `bun run format:check` to verify (CI-gated).

## Linting (ESLint, `eslint.config.js`)

- Base: `@eslint/js` recommended + `typescript-eslint` recommended, with `eslint-config-prettier`
  applied last so stylistic rules never fight Prettier.
- `bun run lint` runs with `--max-warnings 0`: a warning fails CI the same as an error.
- `src/**/*.{ts,tsx}` additionally pulls in `eslint-plugin-react-hooks` recommended rules, with
  `react-hooks/set-state-in-effect` and `react-hooks/exhaustive-deps` at `error`. Reset state from
  a changed prop during render (the `seen`/`setSeen` pattern), not in an effect; a genuine
  external-system sync may carry a scoped `eslint-disable-next-line` with a reason.
- `@typescript-eslint/no-floating-promises` is `error` (type-aware, via `projectService`) across
  `src/`, `server/`, `shared/` and `tests/`. Await, `.catch`, or `void` a promise on purpose;
  `void fn()` is for callees that already handle their own errors.
- `@typescript-eslint/no-explicit-any` is `error`. The server exchanges broad JSON shapes with
  itself at its seams; an `any` there must be a commented `eslint-disable-next-line`, not a habit.
- `@typescript-eslint/no-unused-vars` is `error`, with `_`-prefixed args/vars and rest-sibling
  destructuring exempted.
- `@typescript-eslint/no-namespace` allows declarations (`declare global { namespace Express }` is
  how Express request typing is extended in this repo).
- `public/**/*.js` (the embeddable snippet) is treated as plain, unbundled, ES5-flavoured browser
  JS on purpose - it ships as-is to run wherever the host page runs. It gets a relaxed rule set
  (no-unused-expressions off, unused-vars allows caught errors) rather than the TS-project rules.
- Run `bun run lint` / `bun run lint:fix`.

## Pre-commit (Husky + lint-staged)

- `.husky/pre-commit` runs `bunx lint-staged`.
- `*.{ts,tsx,js}` -> `eslint --fix` then `prettier --write`.
- `*.{json,css,md,html}` -> `prettier --write`.

## Commits

- Conventional commits, enforced by commitlint (`commitlint.config.js`,
  `@commitlint/config-conventional`).
- PRs land on `main` as a squash merge, so CI lints the **PR title**, not individual commit
  messages - see `.github/workflows/ci.yml`'s `commit-message` job.

## TypeScript

- `strict: true`, `noEmit: true` (type-check only; Vite/tsx handle actual transpilation).
- `noUncheckedIndexedAccess`: indexing an array, record, or regex match group yields
  `T | undefined`. Destructure with a default, guard with `if (!x) return`, or `?? ''` for capture
  groups; reserve `!` for indexes that are provably in range (a modulo, a checked length).
- `noFallthroughCasesInSwitch` and `noImplicitOverride` are on.
- Path alias `@/*` -> `./src/*`.
