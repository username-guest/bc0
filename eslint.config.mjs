// ESLint 9 flat config. typescript-eslint's recommended rules plus Next's plugin (core web vitals).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import nextPlugin from '@next/eslint-plugin-next';

export default tseslint.config(
  { ignores: ['.next/**', 'node_modules/**', 'demo/**', '.data/**', 'drizzle/**', 'next-env.d.ts', 'scripts/offline/typecheck/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { plugins: { '@next/next': nextPlugin }, rules: { ...nextPlugin.configs.recommended.rules, ...nextPlugin.configs['core-web-vitals'].rules } },
  {
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', window: 'readonly', document: 'readonly', fetch: 'readonly', URL: 'readonly', Buffer: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly' },
    },
    rules: {
      // A leading underscore marks a deliberately unused binding (e.g. stripping a field with a rest spread).
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
    },
  },
  // Validation tests deliberately build malformed payloads, so loose typing is the point there.
  { files: ['**/*.test.ts'], rules: { '@typescript-eslint/no-explicit-any': 'off' } },
);
