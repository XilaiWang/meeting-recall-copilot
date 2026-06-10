// Why: enforces code style rules from 4.2 §1.
// Flat config (ESLint 9+) for monorepo.

import tseslint from 'typescript-eslint';
import js from '@eslint/js';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Anti-patterns from CLAUDE.md
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      // Common landmines
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'prefer-const': 'error',
      'no-var': 'error',
      // Why: catches AI mistake where it imports something that doesn't exist
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSEnumDeclaration',
          message: 'Use `as const` arrays instead of enum (CLAUDE.md anti-pattern)',
        },
      ],
    },
  },
  {
    // Backend renderer cannot touch fs/db/keychain directly
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['fs', 'fs/*', 'node:fs', 'node:fs/*'], message: 'Renderer cannot use fs. Use IPC.' },
            { group: ['better-sqlite3', 'pg'], message: 'Renderer cannot use DB. Use IPC.' },
            { group: ['keytar'], message: 'Renderer cannot use keytar. Use IPC.' },
          ],
        },
      ],
    },
  },
  {
    // Test files: relax some rules
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },
  {
    // Why: backend CLI scripts, the DB migration runner, and the server entry
    // point legitimately write to stdout (boot banner, migration progress, seed
    // output). no-console targets library/UI code, not Node entry points.
    files: ['apps/backend/scripts/**/*.ts', 'apps/backend/src/db/migrate.ts', 'apps/backend/src/index.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // Why: .cjs files (commitlint config, electron-builder afterPack hooks) are
    // CommonJS modules that legitimately use require(), __dirname, and console.
    // Provide Node.js CJS globals inline and turn off ESM-only rules for these files.
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        require:    'readonly',
        module:     'readonly',
        exports:    'writable',
        __dirname:  'readonly',
        __filename: 'readonly',
        console:    'readonly',
        process:    'readonly',
        Buffer:     'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      'no-console': 'off',
    },
  },
  {
    // Why: backend infra scripts written as plain Node ESM (the ensure-db Postgres
    // bootstrap + the vitest globalSetup). They run via `node`/vitest without the TS
    // toolchain, so they legitimately use Node globals and write progress to stdout.
    files: ['apps/backend/scripts/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        process:      'readonly',
        console:      'readonly',
        Buffer:       'readonly',
        URL:          'readonly',
        setTimeout:   'readonly',
        clearTimeout: 'readonly',
      },
    },
    rules: { 'no-console': 'off' },
  },
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/out/**', '**/.husky/**'],
  },
);
