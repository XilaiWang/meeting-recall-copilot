import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import { ipRateLimit, userRateLimit, pickClientIp } from './rate-limit.js';
import type { AuthVars } from './auth.js';
import type { LicenseStatus } from '../services/auth-service.js';

const OK_RESPONSE = { ok: true, data: null, error: null };

// Why: each test uses a unique prefix so the module-level MemoryStore
// singleton doesn't leak state between test cases.
let seq = 0;
const uid = () => `test-${++seq}`;

describe('middleware/rate-limit', () => {
  describe('ipRateLimit', () => {
    it('passes requests under the limit', async () => {
      const app = new Hono();
      app.use('/t', ipRateLimit({ max: 3, windowMs: 60_000, prefix: uid() }));
      app.get('/t', (c) => c.json(OK_RESPONSE));

      for (let i = 0; i < 3; i++) {
        expect((await app.request('/t')).status).toBe(200);
      }
    });

    it('returns 429 RATE_LIMITED on the request that exceeds the limit', async () => {
      const app = new Hono();
      app.use('/t', ipRateLimit({ max: 2, windowMs: 60_000, prefix: uid() }));
      app.get('/t', (c) => c.json(OK_RESPONSE));

      await app.request('/t');
      await app.request('/t');
      const res = await app.request('/t');
      expect(res.status).toBe(429);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('RATE_LIMITED');
    });

    it('sets X-RateLimit-* headers on every response', async () => {
      const app = new Hono();
      app.use('/t', ipRateLimit({ max: 5, windowMs: 60_000, prefix: uid() }));
      app.get('/t', (c) => c.json(OK_RESPONSE));

      const res = await app.request('/t');
      expect(res.headers.get('X-RateLimit-Limit')).toBe('5');
      expect(res.headers.get('X-RateLimit-Remaining')).toBe('4');
      expect(Number(res.headers.get('X-RateLimit-Reset'))).toBeGreaterThan(0);
    });

    it('X-RateLimit-Remaining floors at 0 on a 429', async () => {
      const app = new Hono();
      app.use('/t', ipRateLimit({ max: 1, windowMs: 60_000, prefix: uid() }));
      app.get('/t', (c) => c.json(OK_RESPONSE));

      await app.request('/t');
      const res = await app.request('/t');
      expect(res.status).toBe(429);
      expect(res.headers.get('X-RateLimit-Remaining')).toBe('0');
    });
  });

  describe('pickClientIp (anti-spoofing)', () => {
    it('prefers the trusted Fly-Client-IP header over X-Forwarded-For', () => {
      expect(pickClientIp('203.0.113.7', '1.2.3.4, 10.0.0.1')).toBe('203.0.113.7');
    });

    it('ignores a client-forged leftmost XFF, using the rightmost (trusted) hop', () => {
      // Attacker sends "X-Forwarded-For: 6.6.6.6"; Fly appends the real IP at the end.
      expect(pickClientIp(undefined, '6.6.6.6, 203.0.113.7')).toBe('203.0.113.7');
    });

    it('falls back to unknown when no IP headers are present', () => {
      expect(pickClientIp(undefined, undefined)).toBe('unknown');
      expect(pickClientIp('  ', '   ')).toBe('unknown');
    });
  });

  describe('ipRateLimit (spoofed XFF cannot escape the bucket)', () => {
    it('counts requests from one Fly-Client-IP together despite rotating XFF', async () => {
      const app = new Hono();
      const prefix = uid();
      app.use('/t', ipRateLimit({ max: 2, windowMs: 60_000, prefix }));
      app.get('/t', (c) => c.json(OK_RESPONSE));

      // Same real client (Fly-Client-IP), but a different forged leftmost XFF each time.
      const req = (fakeXff: string) =>
        app.request('/t', { headers: { 'Fly-Client-IP': '203.0.113.7', 'X-Forwarded-For': fakeXff } });
      expect((await req('1.1.1.1')).status).toBe(200);
      expect((await req('2.2.2.2')).status).toBe(200);
      expect((await req('3.3.3.3')).status).toBe(429); // still the same bucket → limited
    });
  });

  describe('userRateLimit', () => {
    function makeUserApp(max: number, prefix: string) {
      const app = new Hono<{ Variables: AuthVars }>();
      app.use('/t', async (c, next) => {
        c.set('userId', 'u-1');
        c.set('email', 'u@example.com');
        c.set('licenseStatus', 'active' as LicenseStatus);
        await next();
      });
      app.use('/t', userRateLimit({ max, windowMs: 60_000, prefix }));
      app.get('/t', (c) => c.json(OK_RESPONSE));
      return app;
    }

    it('passes requests under the limit', async () => {
      const app = makeUserApp(3, uid());
      for (let i = 0; i < 3; i++) {
        expect((await app.request('/t')).status).toBe(200);
      }
    });

    it('returns 429 when limit exceeded', async () => {
      const app = makeUserApp(2, uid());
      await app.request('/t');
      await app.request('/t');
      const res = await app.request('/t');
      expect(res.status).toBe(429);
    });
  });

  // The Upstash REST store is selected only when both env vars are present, so these
  // tests set them, mock global fetch, and restore everything afterwards — leaving the
  // default (in-memory) tests above untouched.
  describe('userRateLimit (Upstash REST store, multi-instance)', () => {
    const URL = 'https://example.upstash.io';
    const TOKEN = 'test-token';

    afterEach(() => {
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    function upstashApp(max: number, prefix: string) {
      const app = new Hono<{ Variables: AuthVars }>();
      app.use('/t', async (c, next) => {
        c.set('userId', 'u-redis');
        c.set('email', 'u@example.com');
        c.set('licenseStatus', 'active' as LicenseStatus);
        await next();
      });
      app.use('/t', userRateLimit({ max, windowMs: 60_000, prefix }));
      app.get('/t', (c) => c.json(OK_RESPONSE));
      return app;
    }

    it('hits Redis via EVAL and 429s when the SHARED count exceeds the limit', async () => {
      process.env.UPSTASH_REDIS_REST_URL = URL;
      process.env.UPSTASH_REDIS_REST_TOKEN = TOKEN;
      let n = 0;
      const fetchMock = vi.fn(async (_input: unknown, _init?: unknown) =>
        ({ ok: true, json: async () => ({ result: ++n }) }));
      vi.stubGlobal('fetch', fetchMock);

      const app = upstashApp(2, uid());
      expect((await app.request('/t')).status).toBe(200); // shared count 1
      expect((await app.request('/t')).status).toBe(200); // shared count 2
      expect((await app.request('/t')).status).toBe(429); // shared count 3 > 2

      expect(fetchMock).toHaveBeenCalledTimes(3);
      const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
      expect(fetchMock.mock.calls[0]?.[0]).toBe(URL);
      expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${TOKEN}`);
      expect(String(init.body)).toContain('EVAL');
    });

    it('fails OPEN to the in-memory limiter when Redis is unreachable', async () => {
      process.env.UPSTASH_REDIS_REST_URL = URL;
      process.env.UPSTASH_REDIS_REST_TOKEN = TOKEN;
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const app = upstashApp(2, uid());
      // Redis throws → degrade to the per-instance memory limiter; still served.
      expect((await app.request('/t')).status).toBe(200);
      expect((await app.request('/t')).status).toBe(200);
      expect((await app.request('/t')).status).toBe(429); // memory limiter enforces
      expect(errSpy).toHaveBeenCalled();
    });

    it('does not call Redis when Upstash env is unset (memory store)', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const app = upstashApp(5, uid());
      await app.request('/t');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
