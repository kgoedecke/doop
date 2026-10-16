# CODESTYLE - doop

## Formatting (Prettier, `.prettierrc.json`)

- No semicolons (`semi: false`).
- Single quotes (`singleQuote: true`).
- Print width 120.
- Trailing commas everywhere (`trailingComma: all`).
- Run `bun run format` to write, `bun run format:check` to verify (CI-gated).

## Linting (oxlint + a sliver of ESLint)

- `bun run lint` runs `oxlint --type-aware --deny-warnings .` and then `eslint . --max-warnings 0`;
  a warning from either fails CI the same as an error. oxlint
  (`.oxlintrc.json`, generated from the old ESLint config with `@oxlint/migrate`) carries the whole
  rule set: ESLint recommended, typescript recommended, the React Compiler / hooks rules for
  `src/`, and the type-aware rules through tsgolint. ESLint (`eslint.config.js`) remains for what
  oxlint cannot cover: the `no-restricted-syntax` selector that bans `process.env` outside
  `server/env.ts`, and `no-undef` for the plain JavaScript in `scripts/`, `ios/scripts/` and
  `public/` that no type check sees; it loads no type information.
- `react/set-state-in-effect` and `react/exhaustive-deps` are at `error` for `src/`. Reset state
  from a changed prop during render (the `seen`/`setSeen` pattern), not in an effect; a genuine
  external-system sync may carry a scoped `eslint-disable-next-line` with a reason (oxlint honours
  `eslint-disable` comments).
- `typescript/no-floating-promises` is `error` across `src/`, `server/`, `shared/` and `tests/`.
  Await, `.catch`, or `void` a promise on purpose; `void fn()` is for callees that already handle
  their own errors.
- `typescript/no-explicit-any` is `error`. The server exchanges broad JSON shapes with itself at
  its seams; an `any` there must be a commented `eslint-disable-next-line`, not a habit.
- `no-unused-vars` is `error`, with `_`-prefixed args/vars and rest-sibling destructuring exempted.
- `typescript/no-namespace` allows declarations (`declare global { namespace Express }` is how
  Express request typing is extended in this repo).
- `public/**/*.js` (the embeddable snippet) is treated as plain, unbundled, ES5-flavoured browser
  JS on purpose - it ships as-is to run wherever the host page runs. It gets a relaxed rule set
  (no-unused-expressions off, unused-vars allows caught errors) rather than the TS-project rules.
- Run `bun run lint` / `bun run lint:fix` (`lint:fix` lets oxlint autofix; review its edits).

## Pre-commit (Husky + lint-staged)

- `.husky/pre-commit` runs `bunx lint-staged`.
- `*.{ts,tsx,js}` -> `oxlint --type-aware`, `eslint`, then `prettier --write`.
- `*.{json,css,md,html}` -> `prettier --write`.

## Commits

- Conventional commits, enforced by commitlint (`commitlint.config.js`,
  `@commitlint/config-conventional`).
- PRs land on `main` as a squash merge, so CI lints the **PR title**, not individual commit
  messages - see `.github/workflows/ci.yml`'s `commit-message` job.

## TypeScript

- `strict: true`, `noEmit: true` (type-check only; Vite/tsx handle actual transpilation).
  `bun run typecheck` runs `tsgo`, the native TypeScript 7 compiler from `@typescript/native-preview`,
  which rejects `baseUrl` - keep path mapping in `paths` only. The `typescript` package stays at 5.x
  for editors and the ESLint parser.
- `noUncheckedIndexedAccess`: indexing an array, record, or regex match group yields
  `T | undefined`. Destructure with a default, guard with `if (!x) return`, or `?? ''` for capture
  groups; reserve `!` for indexes that are provably in range (a modulo, a checked length).
- `noFallthroughCasesInSwitch` and `noImplicitOverride` are on.
- Path alias `@/*` -> `./src/*`.
