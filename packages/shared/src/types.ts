// Why: shared API envelope type so frontend/backend stay in sync.
// All API responses follow { ok, data, error } shape.
export interface ApiEnvelope<T> {
  ok: boolean;
  data: T | null;
  error: ApiError | null;
}

export interface ApiError {
  code: string;
  message: string;
}

// Auth payload types
export interface AccessTokenPayload {
  sub: string;
  email: string;
  licenseStatus: 'active' | 'expired' | 'none';
}
