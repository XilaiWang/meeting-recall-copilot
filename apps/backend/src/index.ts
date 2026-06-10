// Why: load .env before importing other modules that read env vars
import 'dotenv/config';

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import { authRoutes } from './routes/auth.js';
import { licenseRoutes } from './routes/license.js';
import { surveyRoutes } from './routes/survey.js';
import { llmProxyRoutes } from './routes/llm-proxy.js';

const app = new Hono();

// Global middleware
app.use('*', logger());

// CORS: allow Electron app + Vite dev server.
// Why: production Electron loads pages from `file://` or `app://`, so we
// need to allow these; dev uses Vite on localhost:5173.
app.use('*', cors({
  origin: ['http://localhost:5173', 'app://qa-matching', 'file://'],
  credentials: true,
}));

// Health check — used by Fly.io and uptime monitoring
app.get('/health', (c) => c.json({ ok: true, data: { version: '0.0.1' }, error: null }));

// API v1 routes
app.route('/v1/auth', authRoutes);
app.route('/v1/license', licenseRoutes);
app.route('/v1/survey', surveyRoutes);
app.route('/v1/llm', llmProxyRoutes);

// Why: unified error envelope so client can always check `ok` first
app.onError((err, c) => {
  console.error('[onError]', err);
  return c.json({
    ok: false,
    data: null,
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' },
  }, 500);
});

app.notFound((c) => c.json({
  ok: false,
  data: null,
  error: { code: 'NOT_FOUND', message: 'Route not found' },
}, 404));

const port = Number(process.env.PORT ?? 3000);
console.log(`[server] starting on http://localhost:${port}`);
serve({ fetch: app.fetch, port });
