DROP INDEX IF EXISTS "mockup_jobs_cache_idx";--> statement-breakpoint
ALTER TABLE "mockup_jobs" ADD COLUMN "product_slug" text;--> statement-breakpoint
ALTER TABLE "mockup_jobs" ADD COLUMN "color_hex" text;--> statement-breakpoint
ALTER TABLE "mockup_jobs" ADD COLUMN "location" text;--> statement-breakpoint
ALTER TABLE "mockup_jobs" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mockup_jobs" ADD COLUMN "run_after" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "mockup_jobs" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "mockup_jobs" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mockup_jobs_tenant_cache_uq" ON "mockup_jobs" USING btree ("tenant_id","cache_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mockup_jobs_due_idx" ON "mockup_jobs" USING btree ("tenant_id","status","run_after");