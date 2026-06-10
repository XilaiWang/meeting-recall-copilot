import { ipcMain, app } from 'electron';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { eq } from 'drizzle-orm';
import { loginApi, signupApi, logoutApi } from '../api/auth.js';
import { getSession, setSession, clearSession } from '../store/session.js';
import { getDb } from '../db/client.js';
import { usersLocal, appSettings } from '../db/schema.js';
import { signJson, verifyJson } from '../lib/signing.js';
import { checkLicenseGrace } from './license.js';

const SESSION_KEY = 'persisted_session';

// Why: persist session to SQLite so the user stays logged in across restarts.
// We store tokens, never the password. On logout, the row is deleted.
// Why signed: HMAC protects the licenseStatus field against local SQLite
// tampering. Any modification breaks the sig → licenseStatus reverts to 'none'.
async function persistSession(s: Parameters<typeof setSession>[0]) {
  const db = getDb();
  const signed = signJson(s);
  await db.insert(appSettings)
    .values({ key: SESSION_KEY, valueJson: { signed } as unknown as Record<string, unknown>, updatedAt: new Date() })
    .onConflictDoUpdate({ target: appSettings.key, set: { valueJson: { signed } as unknown as Record<string, unknown>, updatedAt: new Date() } });
}

async function loadPersistedSession() {
  const db = getDb();
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, SESSION_KEY));
  if (!row) return null;
  const wrapper = row.valueJson as { signed?: string } | null;
  if (!wrapper?.signed) {
    // Legacy unsigned row — delete it so the user re-authenticates cleanly.
    await db.delete(appSettings).where(eq(appSettings.key, SESSION_KEY));
    return null;
  }
  const verified = verifyJson<Parameters<typeof setSession>[0]>(wrapper.signed);
  if (!verified) {
    // Tampered or wrong machine — purge and force re-login.
    await db.delete(appSettings).where(eq(appSettings.key, SESSION_KEY));
    return null;
  }
  return verified;
}

async function clearPersistedSession() {
  await getDb().delete(appSettings).where(eq(appSettings.key, SESSION_KEY));
}

export function registerAuthIpcHandlers() {
  ipcMain.handle('auth:signup', async (_event, email: string, password: string, displayName?: string) => {
    const res = await signupApi({ email, password, displayName });
    if (!res.ok || !res.data) return res;
    const { user, accessToken, refreshToken } = res.data;
    // Write local DB first — if this fails the in-memory session is never set,
    // keeping DB and memory consistent (checkLicenseGrace needs the usersLocal row).
    await upsertUserLocal(user);
    const s = { userId: user.id, email: user.email, displayName: user.displayName ?? undefined, licenseStatus: user.licenseStatus, accessToken, refreshToken };
    setSession(s);
    await persistSession(s);
    return res;
  });

  ipcMain.handle('auth:login', async (_event, email: string, password: string) => {
    const res = await loginApi({ email, password });
    if (!res.ok || !res.data) return res;
    const { user, accessToken, refreshToken } = res.data;
    await upsertUserLocal(user);
    const s = { userId: user.id, email: user.email, displayName: user.displayName ?? undefined, licenseStatus: user.licenseStatus, accessToken, refreshToken };
    setSession(s);
    await persistSession(s);
    return res;
  });

  ipcMain.handle('auth:logout', async () => {
    const session = getSession();
    if (session) {
      await logoutApi(session.refreshToken).catch(() => null);
    }
    clearSession();
    await clearPersistedSession();
    return { ok: true, data: { loggedOut: true }, error: null };
  });

  ipcMain.handle('auth:session', async () => {
    // Why: ~/.qa-matching-dev (or running unpackaged) lets the developer skip the
    // login screen. The file is also the dev auto-login hook: if it holds
    // {"email","password"} JSON, we do a REAL backend login so the dev session
    // carries real tokens; an empty file keeps the old offline stub behavior.
    // Why: dev bypasses (auto-login + offline stub) must NEVER be reachable in a
    // packaged production build — otherwise anyone who can drop a ~/.qa-matching-dev
    // file in the user's home (malware, shared machine, social-engineering) would get
    // a stub session with licenseStatus:'active', bypassing login + the local licence
    // gate. So the dev file is only consulted when the app is unpackaged.
    const isDev = !app.isPackaged;
    const devFile = join(app.getPath('home'), '.qa-matching-dev');
    const devFileExists = isDev && existsSync(devFile);

    // In-memory session (set earlier this launch) always wins — avoids
    // re-logging-in on repeated auth:session calls within one run.
    let s = getSession();

    // Dev auto-login: on the first call of a launch, log in fresh with the dev
    // creds so the session reflects the CURRENT backend account state (e.g. a
    // license activated since last launch). Prioritised over the persisted row,
    // since checkLicenseGrace only refreshes already-active users (never upgrades
    // none → active).
    if (!s && devFileExists) {
      const creds = readDevCreds(devFile);
      if (creds) {
        const res = await loginApi(creds).catch(() => null);
        if (res?.ok && res.data) {
          const { user, accessToken, refreshToken } = res.data;
          await upsertUserLocal(user);
          s = { userId: user.id, email: user.email, displayName: user.displayName ?? undefined, licenseStatus: user.licenseStatus, accessToken, refreshToken };
          setSession(s);
          await persistSession(s);
        }
      }
    }

    // Restore a persisted session (non-dev path, or dev login failed/offline).
    if (!s) {
      s = await loadPersistedSession();
      if (s) setSession(s);
    }

    // Dev fallback: backend down / no usable creds → stub session so the dev can
    // still open the UI offline (preserves the original bypass behavior).
    if (!s && isDev) {
      const devS = {
        userId: 'dev-user',
        email: 'dev@localhost',
        displayName: 'Dev' as string | undefined,
        licenseStatus: 'active' as const,
        accessToken: 'dev-token',
        refreshToken: 'dev-refresh',
      };
      setSession(devS);
      return { ok: true, data: { ...devS, offlineDaysLeft: null }, error: null };
    }

    if (!s) return { ok: false, data: null, error: { code: 'UNAUTHENTICATED', message: 'No session' } };
    let offlineDaysLeft: number | null = null;
    try {
      ({ offlineDaysLeft } = await checkLicenseGrace(s.userId, s.accessToken));
    } catch {
      // Grace check failed (e.g. DB error). Return session without blocking startup.
    }
    // Re-read in-memory session: checkLicenseGrace may have updated licenseStatus.
    const current = getSession() ?? s;
    return {
      ok: true,
      data: { userId: current.userId, email: current.email, displayName: current.displayName, licenseStatus: current.licenseStatus, offlineDaysLeft },
      error: null,
    };
  });
}

// Parse ~/.qa-matching-dev as dev auto-login credentials. Returns null for an
// empty/non-JSON file (treated as a plain "skip login" marker, not creds).
function readDevCreds(devFile: string): { email: string; password: string } | null {
  try {
    const raw = readFileSync(devFile, 'utf8').trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { email?: unknown; password?: unknown };
    if (typeof parsed.email === 'string' && typeof parsed.password === 'string') {
      return { email: parsed.email, password: parsed.password };
    }
  } catch {
    // Unreadable or not JSON → no auto-login (fall back to stub).
  }
  return null;
}

async function upsertUserLocal(user: { id: string; email: string; displayName: string | null; licenseStatus: 'active' | 'expired' | 'none' }) {
  const db = getDb();
  await db
    .insert(usersLocal)
    .values({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      licenseStatus: user.licenseStatus,
      createdAt: new Date(),
    })
    .onConflictDoUpdate({
      target: usersLocal.id,
      set: { email: user.email, displayName: user.displayName, licenseStatus: user.licenseStatus },
    });
}
