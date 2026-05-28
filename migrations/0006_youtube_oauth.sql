ALTER TABLE "brands" ADD COLUMN "youtube_oauth" jsonb;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "youtube_dispatch_target" text DEFAULT 'manual' NOT NULL;