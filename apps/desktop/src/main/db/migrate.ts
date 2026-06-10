import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { app } from 'electron';
import { getDb, runSupplementalMigrations, createSearchTables } from './client.js';

// Why: migrations run once at startup from the bundled migrations folder.
// Using app.getAppPath() for the migration files (they are bundled with the app)
// vs app.getPath('userData') for the actual DB file (user data, persists across updates).
//
// ORDER MATTERS: migrate() must create the base tables BEFORE runSupplementalMigrations()
// runs its ALTER TABLE ... ADD COLUMN statements. On a fresh install the tables don't
// exist yet, so running the ALTERs first throws 'no such table' (not swallowed) and
// bricks first launch — getDb() therefore no longer runs them inline.
export function runMigrations() {
  const db = getDb();
  const migrationsFolder = app.isPackaged
    ? join(process.resourcesPath, 'migrations')
    : join(app.getAppPath(), 'src/main/db/migrations');
  migrate(db, { migrationsFolder });
  runSupplementalMigrations();
  // Search layer (FTS5 + vec0 virtual tables + embed-state) — after base tables exist.
  createSearchTables();
}
