CREATE TABLE "youtube_oauth_states" (
  "state" text PRIMARY KEY NOT NULL,
  "brand_id" text NOT NULL,
  "redirect_uri" text NOT NULL,
  "login_hint" text,
  "expected_channel_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "youtube_oauth_states" ADD CONSTRAINT "youtube_oauth_states_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "brands"("id") ON DELETE cascade;
--> statement-breakpoint
CREATE INDEX "idx_youtube_oauth_states_brand" ON "youtube_oauth_states" ("brand_id");
--> statement-breakpoint
CREATE INDEX "idx_youtube_oauth_states_expires" ON "youtube_oauth_states" ("expires_at");
