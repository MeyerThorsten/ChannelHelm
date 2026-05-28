ALTER TABLE "sources" ADD COLUMN "archive_path" text;--> statement-breakpoint
ALTER TABLE "packages" ADD COLUMN "archived_at" timestamp with time zone;