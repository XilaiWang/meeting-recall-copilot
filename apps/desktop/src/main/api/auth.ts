import type { SignupInput, LoginInput, RefreshInput } from '@qa-matching/shared/schemas';
import { apiPost } from './client.js';

export interface AuthUser {
  id: string;
  email: string;
  displayName: string | null;
  licenseStatus: 'active' | 'expired' | 'none';
}

export interface AuthTokens {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
}

export function signupApi(body: SignupInput) {
  return apiPost<AuthTokens>('/v1/auth/signup', body);
}

export function loginApi(body: LoginInput) {
  return apiPost<AuthTokens>('/v1/auth/login', body);
}

export function refreshApi(body: RefreshInput) {
  return apiPost<AuthTokens>('/v1/auth/refresh', body);
}

export function logoutApi(refreshToken: string) {
  return apiPost<{ loggedOut: boolean }>('/v1/auth/logout', { refreshToken });
}
