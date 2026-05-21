CREATE TABLE "llm_providers" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'openai-compatible' NOT NULL,
	"base_url" text NOT NULL,
	"api_key" text DEFAULT '' NOT NULL,
	"model" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"purpose" text DEFAULT 'all' NOT NULL,
	"max_tokens" integer DEFAULT 2048 NOT NULL,
	"temperature" double precision DEFAULT 0.5 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_llm_providers_enabled" ON "llm_providers" USING btree ("enabled") WHERE "llm_providers"."enabled" = TRUE;--> statement-breakpoint
CREATE INDEX "idx_llm_providers_purpose" ON "llm_providers" USING btree ("purpose");