// Vitest globalSetup: auto-start + migrate Postgres once before the suite runs, so
// DB-backed tests don't fail with `connect ECONNREFUSED 127.0.0.1:5432`.
//
// Why a globalSetup (not a per-file beforeAll): it runs exactly once in the main
// process, before any worker spins up — the right place for a side effect like
// "bring the database online". Opt out for pure-unit iteration with SKIP_DB_SETUP=1.

import { ensureDb } from './ensure-db.mjs';

export default async function setup() {
  if (process.env.SKIP_DB_SETUP) {
    console.log('[ensure-db] SKIP_DB_SETUP set — skipping Postgres bootstrap');
    return;
  }
  await ensureDb();
}
