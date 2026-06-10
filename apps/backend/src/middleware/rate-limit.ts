import { randomUUID } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import type { AuthVars } from './auth.js';

interface RateResult {
  count: number;
  resetAt: number;
}

// Pluggable backend so the same middleware works single-instance (in-memory) or
// multi-instance (shared Redis). increment() records one hit for `key` within a
// rolling `windowMs` and returns the current count + when the window resets.
interface RateLimitStore {
  increment(key: string, windowMs: number): Promise<RateResult>;
}

// ── In-memory store (single instance / dev / Redis-outage fallback) ───────────
// Fixed window. State resets on cold start — fine at single-machine scale. NOT
// shared across instances, which is exactly why a Redis store exists below.
interface BucketEntry {
  count: number;
  resetAt: number;
}

class MemoryStore implements RateLimitStore {
  private readonly buckets = new Map<string, BucketEntry>();

  // async to satisfy the shared RateLimitStore interface (the work itself is sync).
  async increment(key: string, windowMs: number): Promise<RateResult> {
    const now = Date.now();
    const entry = this.buckets.get(key);

    if (!entry || now >= entry.resetAt) {
      const fresh: BucketEntry = { count: 1, resetAt: now + windowMs };
      this.buckets.set(key, fresh);
      return fresh;
    }

    entry.count += 1;
    return entry;
  }

  prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.buckets) {
      if (now >= entry.resetAt) this.buckets.delete(key);
    }
  }
}

const memoryStore = new MemoryStore();
// Why: .unref() prevents the interval from keeping the process alive in tests.
setInterval(() => memoryStore.prune(), 5 * 60 * 1000).unref();

// ── Upstash Redis store (multi-instance) ──────────────────────────────────────
// Sliding-window log in a Redis sorted set, run atomically as one Lua script over
// the Upstash REST API (global fetch — no TCP client / npm dependency). Every
// backend instance hits the SAME Redis under the same key, so the limit is GLOBAL,
// fixing the per-instance leak of MemoryStore once we run >1 machine.
//
//   ZREMRANGEBYSCORE drops hits older than the window, ZADD records this hit with a
//   unique member (so same-millisecond hits don't collide), ZCARD is the live count,
//   PEXPIRE bounds the key's lifetime. Returns the post-insert count.
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local member = ARGV[3]
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
redis.call('ZADD', key, now, member)
local count = redis.call('ZCARD', key)
redis.call('PEXPIRE', key, window)
return count
`;

class UpstashRedisStore implements RateLimitStore {
  constructor(private readonly url: string, private readonly token: string) {}

  async increment(key: string, windowMs: number): Promise<RateResult> {
    const now = Date.now();
    // Unique member so concurrent hits within the same millisecond each count.
    const member = `${now}-${randomUUID()}`;
    // Upstash REST EVAL form: ["EVAL", script, numKeys, key, ...args] (all strings).
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['EVAL', SLIDING_WINDOW_LUA, '1', key, String(now), String(windowMs), member]),
    });
    if (!res.ok) throw new Error(`upstash_http_${res.status}`);
    const json = (await res.json()) as { result?: unknown; error?: string };
    if (typeof json.error === 'string') throw new Error(`upstash_redis: ${json.error}`);
    const count = typeof json.result === 'number' ? json.result : Number(json.result);
    if (!Number.isFinite(count)) throw new Error('upstash_bad_result');
    // Sliding window: the safe upper bound on when this hit ages out is now+window.
    return { count, resetAt: now + windowMs };
  }
}

// ── Store selection ───────────────────────────────────────────────────────────
// Re-reads env each call (cheap) so the choice is never frozen at import time; the
// Upstash client is cached until its URL/token change. No Upstash config ⇒ memory
// store, so dev / single-instance / tests are unaffected.
let upstash: UpstashRedisStore | null = null;
let upstashKey = '';
function getStore(): RateLimitStore {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return memoryStore;
  const k = `${url} ${token}`;
  if (!upstash || upstashKey !== k) {
    upstash = new UpstashRedisStore(url, token);
    upstashKey = k;
  }
  return upstash;
}

let redisDegraded = false;
// Record a hit, degrading to the in-memory limiter if Redis is unreachable. Fail-OPEN
// to per-instance limiting (not fail-closed): a Redis hiccup must not lock users out
// of the boot-time license check, but abuse still stays bounded per machine.
async function hit(key: string, windowMs: number): Promise<RateResult> {
  const store = getStore();
  if (store === memoryStore) return store.increment(key, windowMs);
  try {
    const r = await store.increment(key, windowMs);
    redisDegraded = false;
    return r;
  } catch (err) {
    if (!redisDegraded) {
      redisDegraded = true;
      console.error('[rate-limit] Redis unavailable, degrading to in-memory limiter:', err);
    }
    return memoryStore.increment(key, windowMs);
  }
}

// Why: the rate-limit key must be an UNFORGEABLE client IP. The leftmost
// X-Forwarded-For entry is fully client-controlled — Fly.io appends the real
// connecting IP to whatever XFF the client sent, so trusting xff[0] lets an
// attacker rotate a fake IP per request and bypass per-IP limits entirely
// (password brute-force / account enumeration / refresh probing). We therefore
// prefer Fly's trusted `Fly-Client-IP` header, and only fall back to the LAST
// (rightmost) XFF hop — the one our trusted proxy added — when it's absent.
export function pickClientIp(flyClientIp: string | undefined, xff: string | undefined): string {
  const fly = flyClientIp?.trim();
  if (fly) return fly;
  if (xff) {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) return last;
  }
  return 'unknown';
}

function clientIp(c: Context): string {
  return pickClientIp(c.req.header('Fly-Client-IP'), c.req.header('X-Forwarded-For'));
}

function applyHeaders(c: Context, max: number, count: number, resetAt: number): void {
  c.header('X-RateLimit-Limit', String(max));
  c.header('X-RateLimit-Remaining', String(Math.max(0, max - count)));
  c.header('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)));
}

function tooMany(c: Context) {
  return c.json(
    {
      ok: false,
      data: null,
      error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later' },
    },
    429,
  );
}

// Rate limit keyed on client IP — for public endpoints (signup, login, refresh).
export function ipRateLimit(opts: {
  max: number;
  windowMs: number;
  prefix: string;
}): MiddlewareHandler {
  return async (c, next) => {
    const { count, resetAt } = await hit(`${opts.prefix}:${clientIp(c)}`, opts.windowMs);
    applyHeaders(c, opts.max, count, resetAt);
    if (count > opts.max) return tooMany(c);
    await next();
  };
}

// Rate limit keyed on authenticated user ID — applied after requireAuth.
export function userRateLimit(opts: {
  max: number;
  windowMs: number;
  prefix: string;
}): MiddlewareHandler<{ Variables: AuthVars }> {
  return async (c, next) => {
    const { count, resetAt } = await hit(`${opts.prefix}:${c.get('userId')}`, opts.windowMs);
    applyHeaders(c, opts.max, count, resetAt);
    if (count > opts.max) return tooMany(c);
    await next();
  };
}
