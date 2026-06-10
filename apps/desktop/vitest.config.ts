import { defineConfig } from 'vitest/config';

// Why: desktop unit tests target PURE logic only — LLM extraction parsing/dedup,
// meeting card matching, and HMAC session signing. UI components and modules
// bound to Electron / better-sqlite3 are validated manually, so the suite runs
// in a plain Node environment (no jsdom) and tests import their helpers from
// dependency-free modules to keep Electron out of the import graph.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
