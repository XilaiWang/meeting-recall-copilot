DO $$ BEGIN
 CREATE TYPE "public"."license_status" AS ENUM('pending', 'active', 'revoked', 'expired');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."license_tier" AS ENUM('lifetime', 'trial');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."platform" AS ENUM('macos_intel', 'macos_arm', 'windows');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" varchar(64) NOT NULL,
	"platform" "platform" NOT NULL,
	"app_version" varchar(20),
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_devices_user_id_device_id" UNIQUE("user_id","device_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "licenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(32) NOT NULL,
	"user_id" uuid,
	"tier" "license_tier" DEFAULT 'lifetime' NOT NULL,
	"status" "license_status" DEFAULT 'pending' NOT NULL,
	"purchased_at" timestamp NOT NULL,
	"activated_at" timestamp,
	"expires_at" timestamp,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "licenses_key_unique" UNIQUE("key")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "licenses" ADD CONSTRAINT "licenses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_devices_user_id" ON "devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_licenses_user_id" ON "licenses" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_licenses_status" ON "licenses" USING btree ("status");