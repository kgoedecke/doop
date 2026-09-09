import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-hooks/set-state-in-effect': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    /* type-aware rules for the TypeScript sources: a dropped promise is a
       real bug (lost errors, work that never awaits), not a style nit */
    files: ['src/**/*.{ts,tsx}', 'server/**/*.ts', 'shared/**/*.ts', 'tests/**/*.ts'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  {
    rules: {
      /* the server talks to itself over broad JSON shapes; the odd any at a
         seam must be an explicit, commented eslint-disable, not a habit */
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      /* declare global { namespace Express } is how express req typing works */
      '@typescript-eslint/no-namespace': ['error', { allowDeclarations: true }],
    },
  },
  {
    /* repo maintenance scripts: plain ESM run directly by node, so they get
       node globals rather than the browser set */
    files: ['scripts/**/*.{js,mjs}'],
    languageOptions: {
      globals: Object.fromEntries(
        'process console Buffer URL setTimeout clearTimeout'.split(' ').map((g) => [g, 'readonly']),
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
    rules: {
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { caughtErrors: 'none' }],
    },
  },
  /* must be last: silence stylistic rules that would fight prettier */
  prettier,
)
