-- Why: family column groups all refresh tokens in one login-session lineage.
-- Reuse detection (revoked token re-presented) revokes the whole family,
-- not just the single token, to invalidate any forked attacker sessions.
-- DEFAULT gen_random_uuid() assigns a distinct family to every existing row
-- so old tokens without a true lineage can still be individually revoked.
ALTER TABLE "refresh_tokens" ADD COLUMN "family" uuid NOT NULL DEFAULT gen_random_uuid();--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_refresh_tokens_family" ON "refresh_tokens" USING btree ("family");
