-- Image-generation providers: add a `category` column to llm_providers so the
-- same table + /providers editor can hold text-to-image providers (Runware)
-- alongside chat/LLM providers. Existing rows default to 'text'.
-- (The youtube_oauth_states table is created by 0008; drizzle-kit re-emitted it
--  here because that migration's snapshot was out of sync — stripped so this
--  migration only carries the llm_providers change.)
ALTER TABLE "llm_providers" ADD COLUMN "category" text DEFAULT 'text' NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_llm_providers_category" ON "llm_providers" USING btree ("category");
