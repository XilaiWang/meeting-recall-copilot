import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  boolean,
  integer,
  timestamp,
  date,
  text,
  unique,
  index,
} from 'drizzle-orm/pg-core';

// ---------- users ----------
// Why: minimal fields for MVP. `cold_start_quota_used` tracks free LLM
// proxy usage (ADR-12); default starts at 0, increments each /llm/proxy call.
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  displayName: varchar('display_name', { length: 100 }),
  emailVerified: boolean('email_verified').notNull().default(false),
  emailVerifiedAt: timestamp('email_verified_at'),
  coldStartQuotaUsed: integer('cold_start_quota_used').notNull().default(0),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

// ---------- refresh_tokens ----------
// Why: 30-day TTL refresh tokens stored server-side so we can revoke
// (e.g. on logout, account compromise). Cleanup cron deletes expired rows.
export const refreshTokens = pgTable('refresh_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // Why: double UUID = 73 chars (36+1+36). 128 gives headroom for future formats.
  token: varchar('token', { length: 128 }).notNull().unique(),
  // Why: family groups all tokens in one login session lineage. Reuse detection
  // (revoked token presented again) revokes the whole family, not just this one.
  // `defaultRandom()` assigns a random UUID to rows created before this column landed.
  family: uuid('family').notNull().defaultRandom(),
  deviceId: varchar('device_id', { length: 64 }),
  revoked: boolean('revoked').notNull().default(false),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// ---------- licenses ----------
// Why: closed sets → pgEnum gives us DB-level enforcement instead of
// CHECK constraints, and Drizzle generates matching TS string-union types.
export const licenseStatusEnum = pgEnum('license_status', [
  'pending',
  'active',
  'revoked',
  'expired',
]);
export const licenseTierEnum = pgEnum('license_tier', ['lifetime', 'trial']);

// Why: a license is a sold/granted entitlement that becomes user-bound only
// at first activation. `userId` stays null while `status='pending'` so we
// can pre-generate keys for promo batches without dummy users. `key` length
// is 32 chars per ADR (3.3 §2.2): "QM-2026-" + 24 Crockford-base32 chars,
// no ambiguous 0/O/1/I/L characters.
export const licenses = pgTable(
  'licenses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: varchar('key', { length: 32 }).notNull().unique(),
    userId: uuid('user_id').references(() => users.id),
    tier: licenseTierEnum('tier').notNull().default('lifetime'),
    status: licenseStatusEnum('status').notNull().default('pending'),
    purchasedAt: timestamp('purchased_at').notNull(),
    activatedAt: timestamp('activated_at'),
    expiresAt: timestamp('expires_at'),
    notes: text('notes'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    userIdIdx: index('idx_licenses_user_id').on(table.userId),
    statusIdx: index('idx_licenses_status').on(table.status),
  }),
);

// ---------- devices ----------
// Why: 2-device-per-user cap is enforced at the service layer (count check),
// not by a DB constraint, so unbind/rebind UX stays simple. The
// `(user_id, device_id)` unique pair makes activate idempotent: same device
// activating twice updates `lastSeenAt`, never creates a duplicate row.
export const platformEnum = pgEnum('platform', ['macos_intel', 'macos_arm', 'windows']);

export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: varchar('device_id', { length: 64 }).notNull(),
    platform: platformEnum('platform').notNull(),
    appVersion: varchar('app_version', { length: 20 }),
    firstSeenAt: timestamp('first_seen_at').notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at').notNull().defaultNow(),
  },
  (table) => ({
    uniqueUserDevice: unique('uq_devices_user_id_device_id').on(table.userId, table.deviceId),
    userIdIdx: index('idx_devices_user_id').on(table.userId),
  }),
);

// ---------- survey_responses ----------
// Why: closed sets → pgEnum gives DB-level rejection for unknown values;
// Drizzle generates the matching TS string-union so route code stays type-safe.
export const outcomeEnum = pgEnum('outcome', [
  'went_well',
  'needs_followup',
  'no_progress',
  'prefer_not_to_say',
]);
export const cardHelpfulEnum = pgEnum('card_helpful', [
  'used_helpful',
  'used_not_helpful',
  'not_used',
]);
export const willUseNextEnum = pgEnum('will_use_next', ['definitely', 'maybe', 'depends', 'no']);

// Why: userId is nullable so `onDelete: 'set null'` can anonymise rows
// when a user deletes their account — survey data is retained for aggregate
// analytics (3.3 §2.5). The unique constraint on (userId, projectLocalId,
// meetingDate) prevents double-submissions for the same meeting.
export const surveyResponses = pgTable(
  'survey_responses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    projectLocalId: uuid('project_local_id').notNull(),
    meetingDate: date('meeting_date').notNull(),
    companyNameHash: varchar('company_name_hash', { length: 64 }),
    outcome: outcomeEnum('outcome').notNull(),
    cardHelpful: cardHelpfulEnum('card_helpful').notNull(),
    willUseNext: willUseNextEnum('will_use_next').notNull(),
    freeText: text('free_text'),
    submittedAt: timestamp('submitted_at').notNull().defaultNow(),
  },
  (table) => ({
    uniqueResponse: unique('uq_survey_user_project_date').on(
      table.userId,
      table.projectLocalId,
      table.meetingDate,
    ),
    userIdIdx: index('idx_survey_user_id').on(table.userId),
    submittedAtIdx: index('idx_survey_submitted_at').on(table.submittedAt),
    willUseNextIdx: index('idx_survey_will_use_next').on(table.willUseNext),
  }),
);

// ---------- proxy_calls ----------
// Why: records meta (tokens, status) only — prompt content and LLM output
// are never persisted (3.3 §2.6 privacy). Used for quota monitoring and
// abuse detection; rows are retained for 90 days (3.5 §4.4).
export const proxyVendorEnum = pgEnum('proxy_vendor', ['anthropic', 'openai']);
export const proxyStatusEnum = pgEnum('proxy_status', ['success', 'failed']);

export const proxyCalls = pgTable(
  'proxy_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    vendor: proxyVendorEnum('vendor').notNull(),
    model: varchar('model', { length: 50 }),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    status: proxyStatusEnum('status').notNull(),
    errorMsg: text('error_msg'),
    calledAt: timestamp('called_at').notNull().defaultNow(),
  },
  (table) => ({
    userIdCalledAtIdx: index('idx_proxy_calls_user_id_called_at').on(table.userId, table.calledAt),
  }),
);

// ---------- Type exports for use in services ----------
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type RefreshToken = typeof refreshTokens.$inferSelect;
export type NewRefreshToken = typeof refreshTokens.$inferInsert;
export type License = typeof licenses.$inferSelect;
export type NewLicense = typeof licenses.$inferInsert;
export type Device = typeof devices.$inferSelect;
export type NewDevice = typeof devices.$inferInsert;
export type LicenseStatus = License['status'];
export type LicenseTier = License['tier'];
export type Platform = Device['platform'];
export type SurveyResponse = typeof surveyResponses.$inferSelect;
export type NewSurveyResponse = typeof surveyResponses.$inferInsert;
export type Outcome = SurveyResponse['outcome'];
export type CardHelpful = SurveyResponse['cardHelpful'];
export type WillUseNext = SurveyResponse['willUseNext'];
export type ProxyCall = typeof proxyCalls.$inferSelect;
export type ProxyVendor = ProxyCall['vendor'];
export type ProxyStatus = ProxyCall['status'];
