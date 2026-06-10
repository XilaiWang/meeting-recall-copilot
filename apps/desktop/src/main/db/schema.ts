import { sqliteTable, text, integer, real, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { randomUUID } from 'node:crypto';

// Why: users_local caches remote user info so the app works during network
// hiccups and avoids a server round-trip on every launch.
export const usersLocal = sqliteTable('users_local', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  displayName: text('display_name'),
  licenseStatus: text('license_status', { enum: ['active', 'expired', 'none'] }).notNull().default('none'),
  licenseTier: text('license_tier'),
  licenseCacheFetchedAt: integer('license_cache_fetched_at', { mode: 'timestamp' }),
  licenseCacheUntil: integer('license_cache_until', { mode: 'timestamp' }),
  licenseGraceStart: integer('license_grace_start', { mode: 'timestamp' }),
  // Why: monotonic wall-clock high-water mark. Offline-grace elapsed time is
  // measured against max(now, this), so rolling the system clock back cannot
  // extend or reset the grace window (see lib/license-grace.ts).
  maxSeenWallClock: integer('max_seen_wall_clock', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

// Why: generic key-value store for UI preferences and onboarding state;
// avoids schema migrations for low-churn settings.
export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  valueJson: text('value_json', { mode: 'json' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export type UsersLocalRow = typeof usersLocal.$inferSelect;
export type AppSettingsRow = typeof appSettings.$inferSelect;

// Why: project status is a fixed vocabulary; using an enum array + text column
// keeps SQLite simple while TypeScript enforces valid values.
export const projectStatusValues = ['draft', 'materializing', 'extracting', 'needs_review', 'ready', 'exported', 'archived'] as const;
export type ProjectStatus = typeof projectStatusValues[number];

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  parentProjectId: text('parent_project_id').references((): AnySQLiteColumn => projects.id),
  // Why: a single is_profile=true project is the user's reusable PERSONAL corpus
  // (resume / theses / past projects), shared across all applications. Regular
  // (is_profile=false) projects are job applications. Reuses the whole
  // project/material/card/extraction pipeline for the personal library.
  isProfile: integer('is_profile', { mode: 'boolean' }).notNull().default(false),
  name: text('name').notNull(),
  targetRole: text('target_role').notNull(),
  jdText: text('jd_text'),
  status: text('status', { enum: projectStatusValues }).notNull().default('draft'),
  companyName: text('company_name'),
  companyBrief: text('company_brief'),
  companyBriefGeneratedAt: integer('company_brief_generated_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export type ProjectRow = typeof projects.$inferSelect;

export const materialTypeValues = ['github_url', 'zip', 'file', 'url', 'text', 'company_url', 'obsidian'] as const;
export type MaterialType = typeof materialTypeValues[number];

export const materialCategoryValues = ['project', 'company'] as const;
export type MaterialCategory = typeof materialCategoryValues[number];

export const materials = sqliteTable('materials', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  type: text('type', { enum: materialTypeValues }).notNull(),
  category: text('category', { enum: materialCategoryValues }).notNull().default('project'),
  sourceRef: text('source_ref'),
  rawContent: text('raw_content').notNull(),
  fileSize: integer('file_size'),
  // Why: source file modification time at import — lets Obsidian re-imports skip
  // unchanged notes (incremental import). NULL for non-file sources / legacy rows.
  sourceMtime: integer('source_mtime', { mode: 'timestamp' }),
  uploadedAt: integer('uploaded_at', { mode: 'timestamp' }).notNull(),
});

export type MaterialRow = typeof materials.$inferSelect;

export const cardTypeValues = ['tech_principle', 'domain_fact', 'data_metric', 'process_method', 'decision_tradeoff', 'difficulty_solution', 'result_impact'] as const;
export type CardType = typeof cardTypeValues[number];

export const cardLanguageValues = ['zh', 'en', 'bilingual'] as const;
export type CardLanguage = typeof cardLanguageValues[number];

export const cards = sqliteTable('cards', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  sourceMaterialId: text('source_material_id').references(() => materials.id, { onDelete: 'set null' }),
  type: text('type', { enum: cardTypeValues }).notNull(),
  title: text('title').notNull(),
  summary: text('summary').notNull(),
  details: text('details').notNull(),
  tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default([]),
  language: text('language', { enum: cardLanguageValues }).notNull().default('zh'),
  confidence: real('confidence').notNull().default(0.5),
  userVerified: integer('user_verified', { mode: 'boolean' }).notNull().default(false),
  isImportant: integer('is_important', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  // FSRS spaced-repetition state — NULL columns mean the card has never been reviewed (New).
  fsrsDue:           integer('fsrs_due', { mode: 'timestamp' }),
  fsrsStability:     real('fsrs_stability'),
  fsrsDifficulty:    real('fsrs_difficulty'),
  fsrsElapsedDays:   integer('fsrs_elapsed_days'),
  fsrsScheduledDays: integer('fsrs_scheduled_days'),
  fsrsReps:          integer('fsrs_reps'),
  fsrsLapses:        integer('fsrs_lapses'),
  fsrsLearningSteps: integer('fsrs_learning_steps'),
  fsrsState:         integer('fsrs_state'),
});

export type CardRow = typeof cards.$inferSelect;
