CREATE TABLE "experiments" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"package_id" text NOT NULL,
	"video_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"metric" text DEFAULT 'views' NOT NULL,
	"variants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rotation_hours" integer DEFAULT 48 NOT NULL,
	"min_views" integer DEFAULT 50 NOT NULL,
	"rounds" integer DEFAULT 1 NOT NULL,
	"current_variant" integer,
	"current_cycle" integer DEFAULT 0 NOT NULL,
	"current_variant_since" timestamp with time zone,
	"winner_variant" integer,
	"last_error" text,
	"started_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_experiments_brand_status" ON "experiments" USING btree ("brand_id","status");--> statement-breakpoint
CREATE INDEX "idx_experiments_running" ON "experiments" USING btree ("status") WHERE "experiments"."status" = 'running';--> statement-breakpoint
CREATE INDEX "idx_experiments_package" ON "experiments" USING btree ("package_id");