CREATE TYPE "public"."proxy_status" AS ENUM('success', 'failed');--> statement-breakpoint
CREATE TYPE "public"."proxy_vendor" AS ENUM('anthropic', 'openai');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "proxy_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"vendor" "proxy_vendor" NOT NULL,
	"model" varchar(50),
	"input_tokens" integer,
	"output_tokens" integer,
	"status" "proxy_status" NOT NULL,
	"error_msg" text,
	"called_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "proxy_calls" ADD CONSTRAINT "proxy_calls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_proxy_calls_user_id_called_at" ON "proxy_calls" USING btree ("user_id","called_at");