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
    },
  },
  {
    rules: {
      /* the server talks to itself over broad JSON shapes; any is pragmatic
         at the seams but should stay a conscious choice */
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      /* declare global { namespace Express } is how express req typing works */
      '@typescript-eslint/no-namespace': ['error', { allowDeclarations: true }],
    },
  },
  /* must be last: silence stylistic rules that would fight prettier */
  prettier,
)
