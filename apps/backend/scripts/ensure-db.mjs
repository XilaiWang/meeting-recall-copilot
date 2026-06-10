// Ensure a local Postgres (via docker-compose) is running + migrated before tests/dev.
//
// Why: the backend tests hit a REAL PostgreSQL (auth-service.rotateRefreshToken relies
// on `SELECT ... FOR UPDATE` + drizzle tx semantics — mocking it would test the mock).
// Without a DB up, the suite dies with a cryptic `connect ECONNREFUSED 127.0.0.1:5432`.
// This turns that into a one-command, idempotent, runtime-agnostic bootstrap — and a
// clear, actionable error when no container runtime is installed.
//
// Usage:
//   node scripts/ensure-db.mjs            # up + migrate (idempotent)
//   node scripts/ensure-db.mjs --reset    # wipe volume, then up + migrate
//   node scripts/ensure-db.mjs --down     # stop the container
//   SKIP_DB_SETUP=1 ...                   # honored by the vitest globalSetup wrapper

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(__dirname, '..');
const composeFile = join(backendDir, 'docker-compose.yml');
const envFile = join(backendDir, '.env');
const envExample = join(backendDir, '.env.example');

// Must mirror docker-compose.yml so readiness checks target the right role/db.
const PROJECT = 'qa-matching';
const DB_USER = 'qauser';
const DB_NAME = 'qa_matching';

const log = (...a) => console.log('[ensure-db]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let COMPOSE = null; // argv prefix for the detected runtime, e.g. ['docker','compose']

function tryCmd(file, args) {
  try {
    execFileSync(file, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Detect a compose-capable runtime. Returns the argv prefix, or null if none.
function detectCompose() {
  if (tryCmd('docker', ['compose', 'version'])) return ['docker', 'compose'];
  if (tryCmd('docker-compose', ['version'])) return ['docker-compose'];
  if (tryCmd('podman', ['compose', 'version'])) return ['podman', 'compose'];
  if (tryCmd('podman-compose', ['version'])) return ['podman-compose'];
  return null;
}

function compose(rest, opts = {}) {
  const [bin, ...sub] = COMPOSE;
  execFileSync(bin, [...sub, '-f', composeFile, '-p', PROJECT, ...rest], {
    stdio: 'inherit',
    cwd: backendDir,
    ...opts,
  });
}

// pg_isready inside the container — the authoritative "accepting connections" check.
function pgReady() {
  const [bin, ...sub] = COMPOSE;
  return tryCmd(bin, [
    ...sub, '-f', composeFile, '-p', PROJECT,
    'exec', '-T', 'postgres', 'pg_isready', '-U', DB_USER, '-d', DB_NAME, '-q',
  ]);
}

async function waitReady(timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pgReady()) return;
    await sleep(1000);
  }
  throw new Error('Postgres did not become ready within 60s.');
}

function detectPm() {
  return tryCmd('pnpm', ['--version']) ? 'pnpm' : 'npm';
}

function migrate() {
  const pm = detectPm();
  log(`running migrations (${pm} run db:migrate)...`);
  execFileSync(pm, ['run', 'db:migrate'], { stdio: 'inherit', cwd: backendDir });
}

// First-run convenience: create .env from .env.example with working dev JWT secrets,
// so tests that need DATABASE_URL + JWT_ACCESS_SECRET don't fail on missing env.
// Only ever CREATES — never overwrites an existing .env.
function bootstrapEnv() {
  if (existsSync(envFile)) return;
  if (!existsSync(envExample)) {
    log('warning: no .env and no .env.example — skipping env bootstrap');
    return;
  }
  const sec = () => randomBytes(32).toString('base64');
  const body = readFileSync(envExample, 'utf8')
    .replace(/^JWT_ACCESS_SECRET=.*$/m, `JWT_ACCESS_SECRET=${sec()}`)
    .replace(/^JWT_REFRESH_SECRET=.*$/m, `JWT_REFRESH_SECRET=${sec()}`);
  writeFileSync(envFile, body);
  log('created apps/backend/.env from .env.example (dev JWT secrets generated)');
}

function runtimeMissing() {
  log('No container runtime found (docker / podman).');
  console.error(
    [
      '',
      'Postgres is required for the backend integration tests, but no container',
      'runtime is installed. Install ONE of these, then re-run:',
      '',
      '  • OrbStack  (recommended on macOS, lightweight):  brew install orbstack',
      '  • Docker Desktop:  https://www.docker.com/products/docker-desktop/',
      '  • Colima (CLI):    brew install colima docker && colima start',
      '',
      'To run only the non-DB tests in the meantime:',
      '  SKIP_DB_SETUP=1 pnpm test',
      '',
    ].join('\n'),
  );
  throw new Error('No container runtime (docker/podman) found.');
}

function daemonHint() {
  console.error(
    [
      '',
      'A container runtime was found, but starting Postgres failed. The runtime',
      'daemon is probably not running. Start it and re-run:',
      '  • Docker Desktop / OrbStack: open the app',
      '  • Colima:                    colima start',
      '',
    ].join('\n'),
  );
}

export async function ensureDb({ reset = false, downOnly = false } = {}) {
  COMPOSE = detectCompose();
  if (!COMPOSE) return runtimeMissing();
  log(`using runtime: ${COMPOSE.join(' ')}`);

  if (downOnly) {
    log('stopping postgres...');
    compose(['down']);
    return;
  }

  if (reset) {
    log('resetting postgres (down -v)...');
    try {
      compose(['down', '-v']);
    } catch {
      /* nothing to remove yet */
    }
  }

  bootstrapEnv();

  log('starting postgres (compose up -d --wait)...');
  try {
    // --wait blocks until the healthcheck passes (compose v2).
    compose(['up', '-d', '--wait', 'postgres']);
  } catch {
    // Older / alternative runtimes may not support --wait — fall back to polling.
    try {
      compose(['up', '-d', 'postgres']);
      await waitReady();
    } catch {
      daemonHint();
      throw new Error('Failed to start Postgres via compose.');
    }
  }
  // Cheap belt-and-suspenders: confirm it really accepts connections before migrating.
  if (!pgReady()) await waitReady();
  log('postgres is ready.');

  migrate();
  log('database ready for tests ✅');
}

// CLI entry — only runs when invoked directly (not when imported by the vitest setup).
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  ensureDb({ reset: argv.includes('--reset'), downOnly: argv.includes('--down') }).catch(
    (err) => {
      console.error('[ensure-db]', err.message);
      process.exit(1);
    },
  );
}
