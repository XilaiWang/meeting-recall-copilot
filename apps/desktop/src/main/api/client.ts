import type { ApiEnvelope } from '@qa-matching/shared';

// Why: BACKEND_URL env var allows staging vs prod switching without a rebuild.
// In packaged apps process.env is empty (GUI apps don't inherit shell env), so the
// fallback must be the production backend URL baked into the build.
const BACKEND_URL = (process.env['BACKEND_URL'] ?? 'https://qa-matching-api.fly.dev').replace(/\/$/, '');

export async function apiPost<T>(
  path: string,
  body: unknown,
  accessToken?: string,
): Promise<ApiEnvelope<T>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  return res.json() as Promise<ApiEnvelope<T>>;
}

export async function apiGet<T>(
  path: string,
  accessToken?: string,
  extraHeaders?: Record<string, string>,
): Promise<ApiEnvelope<T>> {
  const headers: Record<string, string> = { ...extraHeaders };
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

  const res = await fetch(`${BACKEND_URL}${path}`, { headers });
  return res.json() as Promise<ApiEnvelope<T>>;
}
