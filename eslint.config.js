import tseslint from 'typescript-eslint'

/* oxlint (`.oxlintrc.json`) carries the rule set, including the type-aware
   rules via tsgolint. ESLint stays for what oxlint cannot cover: the
   `no-restricted-syntax` selector below, and `no-undef` for the plain
   JavaScript that no type check sees (oxlint's is still a nursery rule).
   No type information is loaded, so this run is cheap. */
export default tseslint.config(
  {
    ignores: [
      'dist/',
      'node_modules/',
      '.claude/worktrees/**',
      'desktop/src-tauri/target/',
      '.cantelop/**',
      'cantelop/.cantelop/**',
      'cantelop/.dev/**',
    ],
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    rules: { 'no-undef': 'error' },
  },
  {
    /* repo maintenance scripts and the iOS dev helpers: plain ESM run directly
       by node, so they get node globals rather than the browser set */
    files: ['scripts/**/*.{js,mjs}', 'ios/scripts/**/*.{js,mjs}'],
    languageOptions: {
      globals: Object.fromEntries(
        'process console Buffer URL fetch setTimeout clearTimeout setInterval clearInterval'
          .split(' ')
          .map((g) => [g, 'readonly']),
      ),
    },
  },
  {
    /* the embeddable snippet: plain browser JS shipped as-is, no bundling —
       ES5-flavoured on purpose so it runs wherever the host app does */
    files: ['public/**/*.js'],
    languageOptions: {
      globals: Object.fromEntries(
        (
          'window document location history localStorage fetch console setTimeout clearTimeout ' +
          'matchMedia URL JSON Date Math FileReader Promise MutationObserver'
        )
          .split(' ')
          .map((g) => [g, 'readonly']),
      ),
    },
  },
  {
    /* every environment variable is declared once in server/env.ts, typed and
       validated at boot; the rest of the server reads `env.X` from there. The
       Gemini cloud worker is its own process with its own three variables. */
    files: ['server/**/*.ts'],
    ignores: ['server/env.ts', 'server/geminiCloudWorker.ts', 'server/geminiCloudWorkerMain.ts'],
    languageOptions: { parser: tseslint.parser },
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message: 'Read environment variables through `env` from server/env.ts, which validates them at boot.',
        },
      ],
    },
  },
)
