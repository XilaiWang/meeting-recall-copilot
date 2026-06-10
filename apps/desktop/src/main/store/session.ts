// Why: in-memory session store in the main process holds tokens so the
// renderer never touches raw credentials (contextIsolation boundary).
interface Session {
  userId: string;
  email: string;
  displayName?: string;
  licenseStatus: 'active' | 'expired' | 'none';
  accessToken: string;
  refreshToken: string;
}

let _session: Session | null = null;

export function getSession() {
  return _session;
}

export function setSession(s: Session) {
  _session = s;
}

export function clearSession() {
  _session = null;
}
