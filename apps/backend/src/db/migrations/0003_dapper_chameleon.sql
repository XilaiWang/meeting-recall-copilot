CREATE TYPE "public"."card_helpful" AS ENUM('used_helpful', 'used_not_helpful', 'not_used');--> statement-breakpoint
CREATE TYPE "public"."outcome" AS ENUM('went_well', 'needs_followup', 'no_progress', 'prefer_not_to_say');--> statement-breakpoint
CREATE TYPE "public"."will_use_next" AS ENUM('definitely', 'maybe', 'depends', 'no');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "survey_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"project_local_id" uuid NOT NULL,
	"meeting_date" date NOT NULL,
	"company_name_hash" varchar(64),
	"outcome" "outcome" NOT NULL,
	"card_helpful" "card_helpful" NOT NULL,
	"will_use_next" "will_use_next" NOT NULL,
	"free_text" text,
	"submitted_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_survey_user_project_date" UNIQUE("user_id","project_local_id","meeting_date")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "survey_responses" ADD CONSTRAINT "survey_responses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_survey_user_id" ON "survey_responses" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_survey_submitted_at" ON "survey_responses" USING btree ("submitted_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_survey_will_use_next" ON "survey_responses" USING btree ("will_use_next");