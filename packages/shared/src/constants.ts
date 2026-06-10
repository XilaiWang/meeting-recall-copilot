export const APP_NAME = 'qa-matching' as const;
export const APP_VERSION = '0.0.1' as const;

// Why: license status choices are a closed set; as const array gives both JS
// runtime value and TS type, avoiding enum.
export const LICENSE_STATUSES = ['active', 'expired', 'none'] as const;

// Why: explicit token lifetimes so they're visible and documented
export const ACCESS_TOKEN_TTL = '1h' as const;
// Refresh token TTL in seconds: 30 days
export const REFRESH_TOKEN_TTL = 2_592_000 as const;

// Why: shared between server (quota check) and desktop client (display remaining
// calls). Changing this constant is the single source of truth for the quota.
export const COLD_START_QUOTA_MAX = 100 as const;
