// Run drizzle migrations programmatically.
// Usage: pnpm db:migrate
// Why: easier to ship with the app than wrestling drizzle-kit CLI in CI

import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const db = drizzle(pool);

  console.log('[migrate] running migrations...');
  await migrate(db, { migrationsFolder: './src/db/migrations' });
  console.log('[migrate] done.');

  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
