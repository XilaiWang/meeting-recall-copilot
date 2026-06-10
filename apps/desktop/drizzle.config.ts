import { defineConfig } from 'drizzle-kit';

// Why: drizzle-kit generate only needs the schema path; the actual DB path
// is determined at runtime via app.getPath('userData').
export default defineConfig({
  schema: './src/main/db/schema.ts',
  out: './src/main/db/migrations',
  dialect: 'sqlite',
});
