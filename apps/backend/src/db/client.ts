import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

// Why: lazy-fail at construction so missing env crashes fast, not on first query
if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

// Pool: 10 connections is plenty for MVP; bump when QPS demands.
// Why use Pool not single client: serverless-friendly, handles failures gracefully.
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});

export const db = drizzle(pool, { schema });
export type DB = typeof db;
