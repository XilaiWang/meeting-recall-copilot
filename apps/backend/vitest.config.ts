import { defineConfig } from 'vitest/config';

// Why: enforce coverage thresholds from 4.2 §2.3.
// Backend overall >= 70%; F-MVP-4 extract pipeline >= 90% (set per-file when added).
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Why: auto-start + migrate the local Postgres before any test (set SKIP_DB_SETUP=1
    // to bypass for non-DB-only runs). Stops the cryptic ECONNREFUSED 127.0.0.1:5432.
    globalSetup: ['./scripts/vitest-global-setup.mjs'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/db/migrations/**',
        'src/db/migrate.ts',
        'src/index.ts',  // server bootstrap, hard to unit test
      ],
      thresholds: {
        statements: 70,
        branches: 65,
        functions: 70,
        lines: 70,
        // Per-file overrides for critical modules:
        perFile: false,
      },
    },
  },
});
