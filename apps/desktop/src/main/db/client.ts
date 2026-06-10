import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { app } from 'electron';
import { join } from 'node:path';
import * as schema from './schema.js';

// Why: lazy singleton — DB must not be opened until Electron's app.getPath()
// is available (i.e. after 'ready' event). Calling getDb() before that throws.
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;
// Why: keep the raw connection so runSupplementalMigrations() / createSearchTables()
// can run raw DDL AFTER the Drizzle migrator has created the base tables.
let _sqlite: Database.Database | null = null;
// Why: sqlite-vec is a loadable native extension that can fail to load (e.g. a
// hardened-runtime build blocking the unsigned dylib). We track success so retrieval
// degrades to FTS5-only instead of crashing — vector search becomes optional.
let _vecAvailable = false;

export function isVecAvailable(): boolean {
  return _vecAvailable;
}

// Why: expose the raw better-sqlite3 handle for the search layer — FTS5 / vec0 are
// virtual tables Drizzle can't model, so the retrieval/ingestion modules issue raw
// prepared statements against them (the one justified raw-SQL exception).
export function getRawSqlite(): Database.Database {
  if (!_sqlite) throw new Error('getRawSqlite() called before getDb()');
  return _sqlite;
}

export function getDb() {
  if (_db) return _db;
  const dbPath = join(app.getPath('userData'), 'qa-matching.db');
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  // Load the sqlite-vec loadable extension so vec0 vector tables work. Degrade
  // gracefully if it can't load — the app stays usable, retrieval falls back to FTS5.
  try {
    sqliteVec.load(sqlite);
    _vecAvailable = true;
  } catch (e) {
    // In packaged Electron apps, require.resolve inside the asar returns a virtual
    // asar path that dlopen can't use, even when the dylib was auto-unpacked by
    // electron-builder's smartUnpack. Try the unpacked filesystem path directly.
    if (app.isPackaged) {
      try {
        const dylibPath = join(app.getAppPath() + '.unpacked', 'node_modules', 'sqlite-vec-darwin-arm64', 'vec0.dylib');
        sqlite.loadExtension(dylibPath);
        _vecAvailable = true;
        console.warn('[db] sqlite-vec loaded from unpacked path');
      } catch (e2) {
        console.error('[db] sqlite-vec failed to load; vector search disabled:', e2);
        _vecAvailable = false;
      }
    } else {
      console.error('[db] sqlite-vec failed to load; vector search disabled:', e);
      _vecAvailable = false;
    }
  }
  _sqlite = sqlite;
  _db = drizzle(sqlite, { schema });
  return _db;
}

// Why: the hybrid-retrieval search layer. fts_cards (FTS5 lexical) + vec_cards (vec0
// semantic) are virtual tables Drizzle can't model, so they're created via raw DDL.
// card_embed_state tracks each card's content hash for incremental (re-)embedding.
// MUST run AFTER the base `cards` table exists (called from runMigrations).
// Chinese 2-char terms are handled by injecting bigrams into the FTS5 columns at
// ingest time (see lib/search-index.ts), mirroring the prior Orama approach.
export function createSearchTables() {
  const sqlite = _sqlite;
  if (!sqlite) throw new Error('createSearchTables() called before getDb()');
  sqlite.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS fts_cards USING fts5(card_id UNINDEXED, title, summary, details, tags)`,
  );
  if (_vecAvailable) {
    sqlite.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS vec_cards USING vec0(card_id TEXT PRIMARY KEY, embedding FLOAT[384] distance_metric=cosine)`,
    );
  }
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS card_embed_state (card_id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  );
}

// Why: idempotent "add column" migrations for schema that post-dates the base
// migrations/*.sql (fsrs_*, category, source_mtime, company_*, is_profile, license
// grace/clock columns). These MUST run AFTER the Drizzle migrator has created the
// base tables — on a fresh install the tables don't exist yet, so running these
// ALTERs first throws 'no such table' (which, unlike 'duplicate column name', is
// NOT swallowed) and bricks first launch. runMigrations() enforces the ordering:
// migrate() (creates tables) → runSupplementalMigrations() (adds columns).
export function runSupplementalMigrations() {
  const sqlite = _sqlite;
  if (!sqlite) throw new Error('runSupplementalMigrations() called before getDb()');

  // Idempotent schema migration: swallow only "duplicate column name" errors
  // (column already added on a prior launch); re-throw anything else (disk full,
  // schema corruption) so it surfaces.
  const runMigration = (sql: string) => {
    try {
      sqlite.exec(sql);
    } catch (e: unknown) {
      if (!(e instanceof Error) || !e.message.includes('duplicate column name')) throw e;
    }
  };
  const addCol = (col: string, def: string) =>
    runMigration(`ALTER TABLE cards ADD COLUMN ${col} ${def}`);
  const addColUsersLocal = (col: string, def: string) =>
    runMigration(`ALTER TABLE users_local ADD COLUMN ${col} ${def}`);
  const addColMaterials = (col: string, def: string) =>
    runMigration(`ALTER TABLE materials ADD COLUMN ${col} ${def}`);
  const addColProjects = (col: string, def: string) =>
    runMigration(`ALTER TABLE projects ADD COLUMN ${col} ${def}`);
  addColUsersLocal('license_grace_start', 'INTEGER');
  addColUsersLocal('max_seen_wall_clock', 'INTEGER');
  addCol('fsrs_due',            'INTEGER');
  addCol('fsrs_stability',      'REAL');
  addCol('fsrs_difficulty',     'REAL');
  addCol('fsrs_elapsed_days',   'INTEGER');
  addCol('fsrs_scheduled_days', 'INTEGER');
  addCol('fsrs_reps',           'INTEGER');
  addCol('fsrs_lapses',         'INTEGER');
  addCol('fsrs_learning_steps', 'INTEGER');
  addCol('fsrs_state',          'INTEGER');
  addColMaterials('category', "TEXT NOT NULL DEFAULT 'project'");
  // Incremental Obsidian import: track each source file's mtime at import time.
  addColMaterials('source_mtime', 'INTEGER');
  addColProjects('company_name',               'TEXT');
  addColProjects('company_brief',              'TEXT');
  addColProjects('company_brief_generated_at', 'INTEGER');
  // Personal corpus: a single is_profile=1 project holds reusable personal cards.
  addColProjects('is_profile', 'INTEGER NOT NULL DEFAULT 0');
  // Backfill: existing company_url materials are company-category intelligence.
  runMigration("UPDATE materials SET category='company' WHERE type='company_url' AND category='project'");
}
