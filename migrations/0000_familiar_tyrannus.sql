CREATE TABLE "brands" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"voice_profile" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"zernio_profile_id" text,
	"dojoclaw_sites" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"youtube_channel_id" text,
	"default_publishing_schedule" text DEFAULT 'balanced' NOT NULL,
	"default_processing_profile" text DEFAULT 'standard_audio_visual' NOT NULL,
	"approval_required_for" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"auto_dispatch_for" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brands_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"kind" text NOT NULL,
	"origin_url" text,
	"local_media_path" text,
	"duration_seconds" integer,
	"language" text,
	"title" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "packages" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"source_id" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"processing_profile" text DEFAULT 'standard_audio_visual' NOT NULL,
	"intelligence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"routing" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" text PRIMARY KEY NOT NULL,
	"package_id" text NOT NULL,
	"brand_id" text NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"approval_required" boolean DEFAULT true NOT NULL,
	"payload" jsonb NOT NULL,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dispatch" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"signals" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"priority" integer DEFAULT 5 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"locked_by" text,
	"locked_at" timestamp with time zone,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dispatches" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"asset_id" text NOT NULL,
	"target" text NOT NULL,
	"request_payload" jsonb NOT NULL,
	"response_payload" jsonb,
	"external_id" text,
	"success" boolean,
	"error" text,
	"dispatched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"source_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"external_id" text,
	"payload" jsonb NOT NULL,
	"processed" boolean DEFAULT false NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"asset_id" text,
	"source_signal" text NOT NULL,
	"metric" text NOT NULL,
	"value" double precision NOT NULL,
	"sampled_at" timestamp with time zone NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "voice_examples" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"asset_type" text NOT NULL,
	"text" text NOT NULL,
	"performance_score" double precision,
	"used_as_example_count" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_examples" ADD CONSTRAINT "voice_examples_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_brands_active" ON "brands" USING btree ("active") WHERE "brands"."active" = TRUE;--> statement-breakpoint
CREATE INDEX "idx_sources_brand" ON "sources" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "idx_sources_kind" ON "sources" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "idx_packages_brand_status" ON "packages" USING btree ("brand_id","status");--> statement-breakpoint
CREATE INDEX "idx_packages_source" ON "packages" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "idx_packages_updated" ON "packages" USING btree ("updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_assets_package" ON "assets" USING btree ("package_id");--> statement-breakpoint
CREATE INDEX "idx_assets_brand_type_status" ON "assets" USING btree ("brand_id","type","status");--> statement-breakpoint
CREATE INDEX "idx_assets_dispatch_external" ON "assets" USING btree (("dispatch" ->> 'external_id')) WHERE ("assets"."dispatch" ->> 'external_id') IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_jobs_kind_idempotency" ON "jobs" USING btree ("kind","idempotency_key") WHERE "jobs"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_jobs_claim" ON "jobs" USING btree ("status","priority","run_after") WHERE "jobs"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "idx_jobs_kind_status" ON "jobs" USING btree ("kind","status");--> statement-breakpoint
CREATE INDEX "idx_dispatches_asset" ON "dispatches" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "idx_dispatches_target_success" ON "dispatches" USING btree ("target","success");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_webhook_source_event" ON "webhook_events" USING btree ("source","source_event_id");--> statement-breakpoint
CREATE INDEX "idx_webhook_unprocessed" ON "webhook_events" USING btree ("source","received_at") WHERE "webhook_events"."processed" = FALSE;--> statement-breakpoint
CREATE INDEX "idx_signals_brand_asset" ON "signals" USING btree ("brand_id","asset_id");--> statement-breakpoint
CREATE INDEX "idx_signals_sampled" ON "signals" USING btree ("sampled_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_voice_examples_brand_type_score" ON "voice_examples" USING btree ("brand_id","asset_type","performance_score" DESC NULLS LAST);